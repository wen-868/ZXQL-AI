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

/** E4 训练触发阈值（权威文档 26 章） */
export const E4_MIN_SAMPLES = 50;
export const E4_MIN_QUALITY = 4;

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
    options: { force?: boolean; baseModel?: string } = {},
  ): Promise<{
    ok: boolean;
    modelName?: string;
    samples?: number;
    message: string;
  }> {
    const base =
      options.baseModel ??
      this.configService.get<string>('OLLAMA_MODEL', 'qwen2.5:7b');
    const ollamaBase = this.configService.get<string>(
      'OLLAMA_BASE_URL',
      'http://127.0.0.1:11434',
    );

    // 1. 就绪门控
    const readiness = (await this.readiness()).find(
      (r) => r.taskType === taskType,
    );
    if (!options.force && (!readiness || !readiness.ready)) {
      return {
        ok: false,
        message: `E4 训练门控未通过：${taskType} 需 ≥${E4_MIN_SAMPLES} 条 quality≥${E4_MIN_QUALITY} 样本（当前 ${
          readiness?.qualifiedSamples ?? 0
        } 条），可用 readiness 看板跟进积累进度`,
      };
    }

    // 2. 数据集
    const dataset = await this.exportDataset(taskType, 100);
    if (dataset.count < 10) {
      return {
        ok: false,
        message: `有效样本不足（${dataset.count}/10，需≥10 条 JSON 格式样本），先通过评分回流积累`,
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

    // 3. 蒸馏指令（从样本提炼的口径——MVP 以第一类共性开场 + 示例内嵌）
    const examples = parsed
      .slice(0, 8)
      .map(
        (m) =>
          `MESSAGE user ${JSON.stringify(m[0]?.content ?? '')}\nMESSAGE assistant ${JSON.stringify(
            m[1]?.content ?? '',
          )}`,
      )
      .join('\n');
    const modelName = `zhixiang-${taskType
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const modelfile =
      `FROM ${base}\n` +
      `SYSTEM """你是智享全链的岗位特化助手，专精「${taskType}」类任务。` +
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
   */
  async readiness(): Promise<E4ReadinessItem[]> {
    const raw = await this.sampleRepo
      .createQueryBuilder('s')
      .select('s.task_type', 'taskType')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN s.quality >= :q THEN 1 ELSE 0 END)',
        'qualified',
      )
      .addSelect('AVG(s.quality)', 'avgQuality')
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
  ): Promise<{ taskType: string; count: number; jsonl: string }> {
    const samples = await this.sampleRepo.find({
      where: { taskType, quality: MoreThanOrEqual(E4_MIN_QUALITY) },
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
