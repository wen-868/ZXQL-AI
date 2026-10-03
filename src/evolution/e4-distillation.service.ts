/**
 * E4DistillationService — E4 本地训练的就绪度评估、数据集导出与蒸馏执行
 *
 * 依据：权威文档 26 章 E4 触发阈值——同 task_type 的 ai_sample ≥ 50 条且
 * quality ≥ 4（5 分制）。完整权重微调属服务器设施侧；本服务负责工程侧三件事：
 * 1. readiness：按 taskType 统计 quality≥4 样本量与平均质量，给出是否达到
 *    E4 训练阈值的看板数据；
 * 2. exportDataset：把达标样本导出为 JSONL 训练集（messages 格式，可直接
 *    供 Ollama/LLaMA-Factory 等离线微调管线消费）；
 * 3. train（提示词蒸馏）：把达标样本蒸馏成 Ollama 专用模型（Modelfile
 *    内置蒸馏指令 + 少量示例），经 Ollama create API 生成可路由的新模型。
 *    权重级微调不在本层——本层产出的是"开箱可用的岗位特化模型"。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/**
 * 缺省租户：与AiDbController 其他端点（this.tenantContext.getData()?.tenantId ?? 'default'）
 * 保持一致。⚠ 多租户隔离依赖调用方显式传 tenantId，缺省值只应在无租户上下文（本地/单租户）时命中。
 */
export const DEFAULT_TENANT_ID = 'default';

/** E4 训练触发阈值（权威文档 26 章） */
export const E4_MIN_SAMPLES = 50;
export const E4_MIN_QUALITY = 4;
/** force 试跑时的最小可用样本数（与门控阈值不同：force 把门槛从 50 降到 10） */
export const E4_FORCE_MIN_SAMPLES = 10;
/** 训练集实际使用的样本条数（写入 Modelfile 的示例） */
const E4_EXAMPLE_COUNT = 8;
/** taskType 允许的字符集：与 ai_sample.task_type VARCHAR(64) 对齐，留一位给模型名后缀拼接 */
const TASK_TYPE_RE = /^[\w.-]{1,60}$/;
/**
 * baseModel 允许的字符集：Ollama 官方模型名形如 `qwen2.5:7b` / `llama3.1:8b-instruct-q4_0`。
 * 严禁换行——Modelfile 是逐行指令格式，换行即可注入 PARAMETER/TEMPLATE/ADAPTER，
 * 而 ADAPTER/FROM 可指向宿主机任意路径，等价于文件读取原语（见踩坑日志 [44]）。
 */
const BASE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 单个 taskType 的 E4 就绪度 */
export interface E4ReadinessItem {
  taskType: string;
  /** quality≥4 的样本数 */
  qualifiedSamples: number;
  /** 全部样本的平均质量（1-5） */
  avgQuality: number;
  /** 是否达到 E4 训练阈值 */
  ready: boolean;
}

@Injectable()
export class E4DistillationService {
  constructor(
    @InjectRepository(AiSampleEntity, AI_DB_CONNECTION)
    private readonly sampleRepo: Repository<AiSampleEntity>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * E4 提示词蒸馏（提示词蒸馏：样本 → Ollama 专用模型）
   *
   * 流程：
   * 1. 就绪门控：该 taskType 的 quality≥4 样本 ≥ E4_MIN_SAMPLES 才允许
   *    （force=true 可跳过，供试跑验收）；
   * 2. 拉取达标样本（≤100 条），蒸馏为 SYSTEM 指令（口径与风格提炼）
   *    + 少量 MESSAGE 示例，拼装 Modelfile；
   * 3. 经 Ollama create API（POST /api/create）生成专用模型——产出
   *    "开箱可用的岗位特化模型"，模型名随 taskType 带日期后缀；
   * 4. Ollama 不可达时返回失败（不抛异常，调用方给出可读提示）。
   *
   * 权重级微调（真 LoRA/GGUF 训练）不在本层——那是设施侧的离线管线，
   * 本层的产出物是"即时可用的蒸馏模型"。
   */
  async train(
    taskType: string,
    options: { force?: boolean; baseModel?: string; tenantId?: string } = {},
  ): Promise<{
    ok: boolean;
    modelName?: string;
    samples?: number;
    message: string;
  }> {
    // 0. 入参校验（Modelfile 是逐行指令格式，任何未校验的换行都能注入新指令）
    const task = (taskType ?? '').trim();
    if (!task) {
      return { ok: false, message: 'taskType 不能为空' };
    }
    if (!TASK_TYPE_RE.test(task)) {
      return {
        ok: false,
        message: `taskType 含非法字符（仅允许字母数字与 _ . -，≤60 字符）：${task.slice(0, 40)}`,
      };
    }
    const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
    const base =
      options.baseModel ??
      this.configService.get<string>('OLLAMA_MODEL', 'qwen2.5:7b');
    if (!BASE_MODEL_RE.test(base)) {
      return {
        ok: false,
        message: `baseModel 非法（仅允许字母数字与 _ . : - ，≤128 字符）：${base.slice(0, 40)}`,
      };
    }
    const ollamaBase = this.configService.get<string>(
      'OLLAMA_BASE_URL',
      'http://127.0.0.1:11434',
    );

    // 1. 就绪门控
    const readiness = (await this.readiness(tenantId)).find(
      (r) => r.taskType === task,
    );
    if (!options.force && (!readiness || !readiness.ready)) {
      return {
        ok: false,
        message: `E4 训练门控未通过：${task} 需 ≥${E4_MIN_SAMPLES} 条 quality≥${E4_MIN_QUALITY} 样本（当前 ${
          readiness?.qualifiedSamples ?? 0
        } 条），可用 readiness 看板跟进积累进度`,
      };
    }

    // 2. 数据集
    const dataset = await this.exportDataset(task, 100, tenantId);
    if (dataset.count < E4_FORCE_MIN_SAMPLES) {
      return {
        ok: false,
        message: `有效样本不足（${dataset.count}/${E4_FORCE_MIN_SAMPLES}，需≥${E4_FORCE_MIN_SAMPLES} 条 JSON 格式样本），先通过评分回流积累`,
      };
    }
    const parsed = dataset.jsonl
      .split('\n')
      .map((l) => {
        try {
          const m = JSON.parse(l) as {
            messages: Array<{ role: string; content: string }>;
          };
          return m.messages;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<Array<{ role: string; content: string }>>;
    // 以实际可解析条数为准再判一次：count 统计的是 JSONL 行数，
    // 若解析失败会静默少样本，用它训练等于拿残缺数据集冒充达标
    if (parsed.length < E4_FORCE_MIN_SAMPLES) {
      return {
        ok: false,
        message: `可解析样本不足（${parsed.length}/${E4_FORCE_MIN_SAMPLES}，共 ${dataset.count} 行 JSON 格式异常），请检查样本内容`,
      };
    }

    // 3. 蒸馏指令（从样本提炼的口径——MVP 以第一类共性开场 + 示例内嵌）
    const examples = parsed
      .slice(0, E4_EXAMPLE_COUNT)
      .map(
        (m) =>
          `MESSAGE user ${JSON.stringify(m[0]?.content ?? '')}\nMESSAGE assistant ${JSON.stringify(
            m[1]?.content ?? '',
          )}`,
      )
      .join('\n');
    // 模型名：加时分秒，避免同日重训静默覆盖已投产的模型（Ollama create 覆盖且无版本记录）
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const modelName = `zhixiang-${task
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()}-${stamp}`;
    const modelfile =
      `FROM ${base}\n` +
      `SYSTEM """你是智享全链的岗位特化助手，专精「${task}」类任务。` +
      `以下是从历史高质量任务中蒸馏的口径与示例，回答时保持一致的风格与字段口径。"""\n` +
      examples;

    // 4. Ollama create API
    try {
      const res = await fetch(`${ollamaBase}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, modelfile, stream: false }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          message: `Ollama create 失败（HTTP ${res.status}）：${body.slice(0, 200)}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        message: `Ollama 不可达（${ollamaBase}）：${
          err instanceof Error ? err.message : String(err)
        }。请确认 Ollama 服务已启动后再试`,
      };
    }

    return {
      ok: true,
      modelName,
      samples: parsed.length,
      message: `蒸馏模型已生成：${modelName}（样本 ${parsed.length} 条），请在"模型接入"页注册为外部模型后即可路由使用`,
    };
  }

  /**
   * E4 就绪度看板：按 taskType 统计 quality≥4 样本量、总样本量、平均质量
   *
   * ⚠ 必须按 tenantId 过滤：ai_sample 是全租户共表，不加租户条件会让 A 租户的
   * 样本量把B 租户顶成 ready，且经 train() 复用为门控后会导致跨租户串样本。
   */
  async readiness(tenantId?: string): Promise<E4ReadinessItem[]> {
    const tid = tenantId ?? DEFAULT_TENANT_ID;
    const raw = await this.sampleRepo
      .createQueryBuilder('s')
      .select('s.task_type', 'taskType')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN s.quality >= :q THEN 1 ELSE 0 END)',
        'qualified',
      )
      .addSelect('AVG(s.quality)', 'avgQuality')
      .where('s.tenant_id = :tid', { tid })
      .setParameter('q', E4_MIN_QUALITY)
      .groupBy('s.task_type')
      .orderBy('qualified', 'DESC')
      .getRawMany<{
        taskType: string;
        total: string | number;
        qualified: string | number;
        avgQuality: string | number;
      }>();

    return raw.map((r) => {
      const qualified = Number(r.qualified ?? 0);
      const avgQuality = Number(r.avgQuality ?? 0);
      return {
        taskType: r.taskType,
        qualifiedSamples: qualified,
        totalSamples: Number(r.total ?? 0),
        avgQuality: Math.round(avgQuality * 100) / 100,
        ready: qualified >= E4_MIN_SAMPLES && avgQuality >= E4_MIN_QUALITY,
        remaining: Math.max(0, E4_MIN_SAMPLES - qualified),
      };
    });
  }

  /**
   * 导出 JSONL 训练集（quality≥4 且 prompt/completion 齐备的样本）
   *
   * 训练集卫生：同 prompt 去重（重复样本会让微调过拟合到措辞）、
   * prompt 过短（<4 字符）剔除；格式为 messages：
   * {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
   */
  async exportDataset(
    taskType: string,
    limit = 500,
    tenantId?: string,
  ): Promise<{ taskType: string; count: number; jsonl: string }> {
    const samples = await this.sampleRepo.find({
      // ⚠ tenantId 必带：prompt/completion 是真实用户消息，跨租户取样等于数据泄露
      where: {
        taskType,
        quality: MoreThanOrEqual(E4_MIN_QUALITY),
        tenantId: tenantId ?? DEFAULT_TENANT_ID,
      },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 2000),
    });

    const lines: string[] = [];
    const seenPrompts = new Set<string>();
    for (const s of samples) {
      const prompt = (s.prompt ?? '').trim();
      const completion = (s.completion ?? '').trim();
      if (prompt.length < 4 || seenPrompts.has(prompt)) continue;
      if (!completion) continue;
      seenPrompts.add(prompt);
      lines.push(
        JSON.stringify({
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: completion },
          ],
        }),
      );
    }

    return { taskType, count: lines.length, jsonl: lines.join('\n') };
  }
}
