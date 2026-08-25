/**
 * ContextBuilder — 上下文构建器
 *
 * 职责：
 * 1. 组装 System Prompt（角色设定 + 业务规则 + 可用工具列表 + 租户信息）
 * 2. 合并 对话历史（MemoryManager 加载） + 用户消息
 * 3. 返回完整的 ChatMessage[] 供 LLM 调用
 *
 * System Prompt 结构：
 *   - 角色身份（智享AI助手 + 租户ID + 用户角色）
 *   - 能力列表（按业务域列出可用 Tool）
 *   - 工作规则（写操作确认 / 金额精确 / 结果表格化 / 异常如实告知）
 *   - 可用工具描述（ToolRegistry 生成）
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-开发文档.md 第八章 8.2 ContextBuilder
 * - docs/ai-base/智享AI底座-架构设计文档.md 第九章 核心数据流
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatMessage } from '../providers/provider.interface';
import type { ToolRegistry } from '../tools/tool-registry';
import { RetrieverService } from '../rag/retriever.service';
import { LongTermMemoryService } from './memory/long-term-memory.service';
import { LearningService } from './learning/learning.service';

/** ContextBuilder 构建参数 */
export interface BuildContextParams {
  /** 租户 ID */
  tenantId: string;
  /** 用户 ID */
  userId?: string;
  /** 用户角色 */
  role?: string;
  /** 当前用户消息 */
  userMessage: string;
  /** 对话历史（由 MemoryManager 加载，不含 system 消息） */
  history: ChatMessage[];
  /** 系统提示词（租户自定义 > 平台默认，由 AiConfigService 提供） */
  systemPrompt?: string;
  /** RAG 知识库参考内容（由 build() 内部检索注入；embedding 未配置时跳过） */
  ragContext?: string;
  /** 长期记忆参考（由 build() 内部检索注入：租户档案 + 相关历史经验） */
  ltmContext?: string;
}

/**
 * 默认系统提示词
 *
 * 当 AiConfigService 未返回租户自定义系统提示词时使用。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是"智享AI助手"，一个为酒水行业进销存管理系统设计的智能助手。

## 你的身份
- 你服务于智享全链管理系统（批零一体即时零售SaaS平台）
- 当前租户ID：{tenantId}
- 当前用户：{userId}（角色：{role}）

## 你的能力
1. 销售管理：查询/创建销售单、查询客户信息、查询商品信息
2. 库存管理：查询库存、库存调拨、盘点
3. 采购管理：查询/创建采购单
4. 财务管理：查询对账、费用记录
5. 报表分析：销售报表、库存报表

## 工作规则
1. 当用户需要查询或操作数据时，使用可用的工具（function calling）完成
2. 创建订单等写操作时，先向用户确认信息无误后再执行
3. 回答简洁专业，避免冗余解释
4. 不确定的信息要明确告知用户，不要编造数据
5. 所有金额单位为"元"，日期格式为"YYYY-MM-DD"
6. 查询结果优先用表格呈现，便于阅读
7. 当回答包含趋势/占比/排行/对比等数据时，在回答末尾输出图表标记（JSON 必须合法，不要省略字段）：
   [CHART]{"type":"line|bar|pie","title":"图表标题","xAxis":["分类1","分类2"...],"series":[{"name":"系列名","data":[数值...]}]}[/CHART]
   选型：时间趋势用 line、占比用 pie、排行/对比用 bar；无此类数据时不要输出该标记
8. 无法处理用户请求（信息不足/权限不足/超出能力范围）或涉及资金、发布等高风险且无法确认时，
   明确说明原因并建议转人工处理（如"该操作建议由管理员在系统中人工确认"），绝不编造执行结果`;

@Injectable()
export class ContextBuilder {
  private readonly logger = new Logger(ContextBuilder.name);

  constructor(
    private readonly retriever: RetrieverService,
    private readonly ltm: LongTermMemoryService,
    private readonly learning: LearningService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 构建完整的对话上下文
   *
   * 合并顺序：System Prompt（含 RAG 知识库参考）→ 对话历史 → 用户消息
   *
   * R70-21 RAG 增强：build 内部调用 RetrieverService 检索与用户消息相关的
   * 知识库分块，注入 System Prompt 的"知识库参考"段落。embedding 未配置时
   * 检索返回空，跳过注入（对话正常进行，不受影响）。
   *
   * @param params 构建参数
   * @param registry 工具注册中心（用于生成工具描述注入 System Prompt）
   * @returns 完整的 ChatMessage[] 供 LLM 调用
   */
  async build(
    params: BuildContextParams,
    registry: ToolRegistry,
  ): Promise<ChatMessage[]> {
    const ragContext = await this.buildRagContext(params);
    const ltmContext = await this.buildLtmContext(params);
    const systemPrompt = this.buildSystemPrompt(
      { ...params, ragContext, ltmContext },
      registry,
    );
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

    // 加入对话历史（过滤掉 system 消息，避免重复）
    for (const msg of params.history) {
      if (msg.role !== 'system') {
        messages.push(msg);
      }
    }

    // 加入当前用户消息
    messages.push({ role: 'user', content: params.userMessage });

    return messages;
  }

  /**
   * 长期记忆检索（P1）：租户档案 + 相关历史经验（降级安全）
   */
  private async buildLtmContext(
    params: BuildContextParams,
  ): Promise<string | undefined> {
    try {
      const [profiles, hits, hints] = await Promise.all([
        this.ltm.getProfiles(params.tenantId, params.userId),
        this.ltm.search(params.tenantId, params.userMessage, 3),
        this.learning.getHints(params.tenantId, params.userId),
      ]);
      const hasHints = hints.toolSelect.length > 0 || hints.routing.length > 0;
      if (profiles.length === 0 && hits.length === 0 && !hasHints) {
        return undefined;
      }
      const parts: string[] = [];
      if (profiles.length > 0) {
        parts.push(
          `## 租户档案（该租户的稳定偏好/事实）\n${profiles
            .map((p) => `- ${p.k}：${JSON.stringify(p.v)}`)
            .join('\n')}`,
        );
      }
      if (hits.length > 0) {
        parts.push(
          `## 相关历史经验（该租户过去交互沉淀，可参考）\n${hits
            .map((h) => `- ${h.text}`)
            .join('\n')}`,
        );
      }
      if (hasHints) {
        const hintParts: string[] = [];
        if (hints.toolSelect.length > 0) {
          hintParts.push(
            `工具选择提示：\n${hints.toolSelect
              .map((h) => `- ${h.tool}：${h.note}`)
              .join('\n')}`,
          );
        }
        if (hints.routing.length > 0) {
          hintParts.push(
            `流程提示：\n${hints.routing.map((h) => `- ${h.note}`).join('\n')}`,
          );
        }
        parts.push(
          `## 学习经验提示（该租户过往任务的已知问题，规避踩坑）\n${hintParts.join('\n')}`,
        );
      }
      return parts.join('\n\n');
    } catch (err) {
      this.logger.warn(
        `长期记忆检索失败（跳过注入）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * RAG 知识库检索（降级安全）
   *
   * - embedding 未配置 → retriever 返回空数组 → 返回 undefined（跳过注入）
   * - 检索异常 → warn + 返回 undefined（对话主流程不受影响）
   *
   * @returns 拼接后的知识库参考文本；无可用知识时返回 undefined
   */
  private async buildRagContext(
    params: BuildContextParams,
  ): Promise<string | undefined> {
    // B1 权威文档对齐：默认「系统数据即知识库」，RAG 增强默认关闭
    // （ENABLE_RAG=true 显式开启时才注入知识库参考；决策 7 口径）
    const ragEnabled =
      this.configService.get<string>('ENABLE_RAG', 'false') === 'true';
    if (!ragEnabled) {
      return undefined;
    }
    try {
      const results = await this.retriever.search(
        params.userMessage,
        params.tenantId,
      );
      if (!results || results.length === 0) {
        return undefined;
      }
      return results
        .map(
          (r) =>
            `【${r.docName} 第${r.chunkIndex + 1}段】(相关度 ${(r.score * 100).toFixed(0)}%) ${r.text}`,
        )
        .join('\n');
    } catch (err) {
      this.logger.warn(
        `RAG 检索失败（跳过知识库增强）：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * 构建 System Prompt
   *
   * 优先使用租户自定义提示词（由 AiConfigService 提供），
   * 未提供时使用 DEFAULT_SYSTEM_PROMPT。
   *
   * 无论使用哪个提示词，都会替换 {tenantId}/{userId}/{role} 占位符。
   */
  buildSystemPrompt(
    params: BuildContextParams,
    registry: ToolRegistry,
  ): string {
    const base =
      params.systemPrompt && params.systemPrompt.length > 0
        ? params.systemPrompt
        : DEFAULT_SYSTEM_PROMPT;

    // 替换占位符
    let prompt = base
      .replace(/\{tenantId\}/g, params.tenantId)
      .replace(/\{userId\}/g, params.userId ?? '未知')
      .replace(/\{role\}/g, params.role ?? '未知');

    // 注入当前日期（防止模型使用训练数据中的旧示例日期，如 2023-01-01）
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    prompt += `\n\n## 当前时间
今天是 ${todayStr}（${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日）。
- 用户未指定日期时，查询报表/单据默认使用今天或本月/本月至今，严禁使用示例或训练数据中的旧日期（如 2023 年）。
- 涉及"本月/上月/今天/昨天/本周"等相对时间时，以上述当前日期为准计算。`;

    // 追加可用工具描述
    const tools = registry.list();
    if (tools.length > 0) {
      const toolList = tools
        .map((t) => `- ${t.name}（${t.category}）：${t.description}`)
        .join('\n');
      prompt += `\n\n## 当前可用工具\n${toolList}`;
    }

    // R70-21：追加 RAG 知识库参考（检索到相关知识时注入，优先采信）
    if (params.ragContext && params.ragContext.trim().length > 0) {
      prompt += `\n\n## 知识库参考（以下为检索到的内部知识，回答相关问题时优先采信）\n${params.ragContext}`;
    }

    // P1：追加长期记忆参考（租户档案 + 相关历史经验）
    if (params.ltmContext && params.ltmContext.trim().length > 0) {
      prompt += `\n\n## 长期记忆参考（以下为该租户的档案与历史经验，回答时贴合这些背景）\n${params.ltmContext}`;
    }

    // 无论租户使用默认提示词还是自定义提示词，都追加"缺失数据自动创建流程"规则，
    // 确保搜索未命中时 AI 会询问并自动创建（与智享AI助手-能力说明书 2.1.1 异常处理一致）
    prompt += `\n\n## 缺失数据自动创建流程（强制生效，勿遗漏）
1. 创建销售单时：直接调用 createSalesOrder 并传入 customerName（客户名称），不要单独调用 createCustomer；
   createSalesOrder 工具会自动查找客户，客户不存在时预览会提示"将自动创建客户「名称」"，
   用户确认预览（confirm=true）后工具自动创建客户并完成开单，无需手动传 customerId。
2. searchProduct 未找到商品时：
   - 第一轮只能向用户提问："未找到商品「名称」，是否创建该商品？（请提供零售价或批发价）"；
   - 用户确认并提供价格后，再调用 createProduct（confirm=true 直接创建），创建成功后继续后续流程。
   - 严禁对 searchProduct 已找到的商品再次调用 createProduct（避免重复建商品）。
3. 其他写操作（创建销售单、库存调拨、盘点、退款等）先生成预览卡片（confirm=false），
   用户确认后再执行（confirm=true）。`;

    // 回复格式要求：工具执行后必须输出可读总结，禁止直接展示原始 JSON
    prompt += `\n\n## 回复格式要求（强制生效）
1. 每次工具执行完成后，必须基于工具返回结果用简洁中文向用户输出总结（推荐用表格或要点）；禁止只输出 JSON 或工具原始数据。
2. 查询无数据时，如实说明"暂无相关数据"，并给出建议（如调整日期范围、检查筛选条件）。
3. 禁止把工具返回的原始 JSON 直接展示给用户。
4. 创建/执行类操作（如创建销售单）完成后，必须报告完整结果：
   - 单据号（如销售单号）、客户名称、商品明细（商品名+数量）、总金额；
   - 禁止只回复"已创建成功"或"已完成"而不带单据号和关键数据；
   - 示例："销售单 SB20260812001 创建成功：红星商行，五粮液 500ml×10箱，总金额 ¥9800。"
5. 你是一个推理型业务助手：用户要的是最终结果和结论，不是工具调用过程。回复中不要出现"正在调用工具""执行成功"等过程描述，直接给出结果。`;

    return prompt;
  }
}
