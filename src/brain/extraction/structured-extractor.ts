/**
 * StructuredExtractor — 写入文档结构化抽取器（P0-2）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 23 章
 * 原则：所有写入类型统一结构化抽取；**写入字段抽取禁用正则**（字段由 LLM
 * function calling 产出）；nl-parser/param-coercer 仅作数量/价格语义辅助。
 *
 * 流程：
 * 1. LLM function calling（extract_{docType} 工具）抽取结构化参数
 * 2. 无 tool_calls → JSON mode 兜底（提示词要求仅输出 JSON）
 * 3. 类型强制 + 枚举校验 + 必填校验（param-coercer 辅助）
 * 4. 必填缺失/非法 → 生成澄清问题（反问用户，不挂残缺草稿）
 * 5. 数量语义辅助：items 缺数量但口语含"10箱/一箱半"时用 nl-parser 补全
 *
 * E3 样本回流（2026-09-05 持续进化）：抽取前自动拉取 ai_db 中同 taskType 的
 * 高质量历史样本（纠错样本 quality=4 优先）注入 few-shot——AI 被纠正过的
 * 话术口径，10 分钟内即成为后续抽取的运行时经验，无需改代码发版。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-09-05 样本回流 few-shot
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { ProviderRouterService } from '../router/provider-router.service';
import { AiConfigService } from '../../tenant/ai-config.service';
import { coerceParam } from '../../nlp/param-coercer';
import { parseQuantity } from '../../nlp/nl-parser';
import { AiSampleEntity } from '../../database/entities/ai-sample.entity';
import { AI_DB_CONNECTION } from '../../database/ai-db.module';
import type { ChatMessage } from '../../providers/provider.interface';
import {
  WriteDocSchema,
  WriteFieldSchema,
  docTypeForTool,
  getWriteSchema,
  schemaToExtractTool,
} from './write-schema-registry';

/** 抽取问题项（澄清用） */
export interface ExtractionIssue {
  /** 字段路径（如 items[0].skuName） */
  field: string;
  /** 问题原因 */
  reason: 'required' | 'type' | 'enum' | 'items';
  /** 面向用户的说明 */
  message: string;
  /** 澄清问题（可直接展示给用户） */
  question: string;
}

/** 抽取结果 */
export interface ExtractionResult {
  /** 是否完成抽取（false=LLM 异常/未命中 Schema） */
  success: boolean;
  /** docType */
  docType: string;
  /** 是否判定为写入意图（LLM 认为与 Schema 无关时为 false） */
  matched: boolean;
  /** 抽取的结构化参数（用户意图层） */
  data: Record<string, unknown>;
  /** 校验是否通过 */
  valid: boolean;
  /** 问题清单（valid=false 时非空） */
  issues: ExtractionIssue[];
  /** 澄清问题（面向用户） */
  clarifyingQuestions: string[];
  /** 错误信息（LLM 调用失败等） */
  error?: string;
}

/** 写分支增强结果（Orchestrator 用） */
export interface WriteEnhanceResult {
  /** 是否命中写入 Schema（false=非本层职责，走原流程） */
  used: boolean;
  /** 是否需要反问澄清（true=不挂残缺草稿） */
  needsClarification: boolean;
  /** 澄清问题列表 */
  questions?: string[];
  /** 增强后的工具参数（needsClarification=false 时携带） */
  args?: Record<string, unknown>;
  /** 问题明细 */
  issues?: ExtractionIssue[];
}

/** 抽取输入 */
export interface ExtractInput {
  docType: string;
  /** 用户原始消息 */
  utterance: string;
  /** 对话级模型覆盖（可选） */
  model?: string;
}

@Injectable()
export class StructuredExtractor {
  private readonly logger = new Logger(StructuredExtractor.name);

  /** few-shot 缓存（docType → 文本），TTL 10 分钟：纠错样本分钟级生效且不逐请求查库 */
  private readonly fewShotCache = new Map<
    string,
    { text: string; at: number }
  >();
  private static readonly FEW_SHOT_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly router: ProviderRouterService,
    private readonly aiConfigService: AiConfigService,
    private readonly configService: ConfigService,
    @InjectRepository(AiSampleEntity, AI_DB_CONNECTION)
    private readonly sampleRepo: Repository<AiSampleEntity>,
  ) {}

  /**
   * E3 样本回流：拉取同 taskType 的高质量历史样本，生成 few-shot 提示块
   *
   * 来源：采集层对话样本（quality：成功路径=3、纠错路径=4），纠错样本优先；
   * 仅收 completion 可解析为非空 JSON 对象的样本（抽取器的标准答案形态）；
   * 读取失败静默降级为无示例（不阻断抽取）。
   */
  private async fewShotBlockFor(docType: string): Promise<string> {
    const cached = this.fewShotCache.get(docType);
    if (
      cached &&
      Date.now() - cached.at < StructuredExtractor.FEW_SHOT_TTL_MS
    ) {
      return cached.text;
    }

    let text = '';
    try {
      const base = docType.replace(/^write_schema\./, '');
      const samples = await this.sampleRepo.find({
        where: [
          { taskType: base, quality: MoreThanOrEqual(4) },
          { taskType: base, quality: MoreThanOrEqual(3) },
        ],
        order: { createdAt: 'DESC' },
        take: 8,
      });

      const shots: string[] = [];
      const seen = new Set<number>();
      for (const s of samples) {
        if (shots.length >= 3) break;
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const trimmed = (s.completion ?? '').trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            Object.keys(parsed).length > 0
          ) {
            shots.push(
              `示例：${(s.prompt ?? '').slice(0, 80)} => ${JSON.stringify(parsed)}`,
            );
          }
        } catch {
          // 非法 JSON 样本跳过
        }
      }
      if (shots.length > 0) {
        text =
          '\n\n历史正确示例（口径参考；数量/名称以本次用户话语为准，勿照抄）：\n' +
          shots.join('\n');
        this.logger.debug(
          `E3 样本回流：docType=${docType} 注入 ${shots.length} 条 few-shot`,
        );
      }
      this.fewShotCache.set(docType, { text, at: Date.now() });
    } catch (err) {
      this.logger.warn(
        `E3 样本回流读取失败（降级为无 few-shot）：${err instanceof Error ? err.message : String(err)}`,
      );
      this.fewShotCache.set(docType, { text: '', at: Date.now() });
    }
    return text;
  }

  /**
   * 结构化抽取（LLM function calling → JSON 兜底 → 校验 → 澄清）
   *
   * @param input 抽取输入
   * @returns 抽取结果（valid=false 时 clarifyingQuestions 供反问）
   */
  async extract(input: ExtractInput): Promise<ExtractionResult> {
    const schema = getWriteSchema(input.docType);
    if (!schema) {
      return {
        success: false,
        docType: input.docType,
        matched: false,
        data: {},
        valid: false,
        issues: [],
        clarifyingQuestions: [],
        error: `未知写入文档类型：${input.docType}`,
      };
    }

    let raw: Record<string, unknown> | null = null;
    let llmError: string | undefined;
    // E3 样本回流：拉取同 taskType 高质量样本注入 few-shot（失败静默降级为无示例）
    const fewShots = await this.fewShotBlockFor(input.docType);
    try {
      raw = await this.callExtractLlM(
        schema,
        input.utterance,
        input.model,
        fewShots,
      );
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `结构化抽取 LLM 调用失败：docType=${input.docType} err=${llmError}`,
      );
    }

    // LLM 正常返回但未产出抽取（回复"无关"/空）→ 判定为未命中写入意图
    if (raw === null && !llmError) {
      return {
        success: true,
        docType: input.docType,
        matched: false,
        data: {},
        valid: false,
        issues: [],
        clarifyingQuestions: [],
      };
    }

    // LLM 调用失败：降级为未命中（调用方走原 function calling 流程，不阻断业务）
    if (raw === null) {
      return {
        success: false,
        docType: input.docType,
        matched: false,
        data: {},
        valid: false,
        issues: [],
        clarifyingQuestions: [],
        error: llmError ?? '抽取结果为空',
      };
    }

    // 数量语义辅助：口语数量（"10箱/一箱半"）补全 items 数量字段
    this.assistQuantity(input.utterance, schema, raw);

    const { data, issues } = this.validateAndCoerce(schema, raw);
    const clarifyingQuestions = issues.map((i) => i.question);

    return {
      success: true,
      docType: input.docType,
      matched: true,
      data,
      valid: issues.length === 0,
      issues,
      clarifyingQuestions,
    };
  }

  /**
   * 写分支增强入口（Orchestrator 在写工具执行前调用）
   *
   * - 未命中写入 Schema → used=false（走原流程）
   * - 抽取成功 → 合并进现有工具参数（只补缺失字段）
   * - 必填缺失 → needsClarification=true（不挂残缺草稿）
   * - LLM 异常 → 降级原流程（不阻断业务）
   *
   * @param toolName 写工具名
   * @param utterance 用户原始消息
   * @param args      LLM function calling 已产出的工具参数
   * @param model     对话级模型（可选）
   */
  async tryEnhance(input: {
    toolName: string;
    utterance: string;
    args: Record<string, unknown>;
    model?: string;
  }): Promise<WriteEnhanceResult> {
    const docType = docTypeForTool(input.toolName);
    if (!docType) {
      return { used: false, needsClarification: false };
    }

    const result = await this.extract({
      docType,
      utterance: input.utterance,
      model: input.model,
    });

    // LLM 异常/未命中：降级原流程
    if (!result.success || !result.matched) {
      return { used: true, needsClarification: false, args: input.args };
    }

    // 必填缺失/非法：反问澄清，不挂残缺草稿
    if (!result.valid) {
      this.logger.log(
        `写参数需澄清：tool=${input.toolName} docType=${docType} 缺失 ${result.issues.length} 项`,
      );
      return {
        used: true,
        needsClarification: true,
        questions: result.clarifyingQuestions,
        issues: result.issues,
      };
    }

    // 反编造护栏（2026-09-05 真机测试发现）：合并前核对数值字段——
    // 用户话语中完全不存在的价格/金额，若 LLM 参数里冒出来（编造），
    // 拦下反问而不是挂一个带幻觉价格的草稿。仅核对我方定义的"来源=用户话语"字段。
    const fabricated = this.detectFabricatedNumbers(docType, input.utterance, {
      ...input.args,
      ...result.data,
    });
    if (fabricated.length > 0) {
      this.logger.warn(
        `写参数疑似编造已拦截：tool=${input.toolName} 字段=${fabricated.join(',')}`,
      );
      return {
        used: true,
        needsClarification: true,
        questions: [
          `检测到您未在消息中提到${fabricated.join('、')}的具体数值，请明确提供后再执行（避免按臆测价格创建）`,
        ],
        issues: fabricated.map((f) => ({
          field: f,
          reason: 'required' as const,
          message: `参数 ${f} 在用户消息中无依据`,
          question: `请提供${f}的数值`,
        })),
      };
    }

    // 抽取成功：合并进现有参数（只补缺失）
    return {
      used: true,
      needsClarification: false,
      args: this.mergeArgs(input.args, result.data),
    };
  }

  /**
   * 反编造核对：price/amount 类字段的数值必须能在用户话语中找到
   * （数字或其中文口语形态，如 "两百" 不核——仅核阿拉伯数字）。
   * 数量类字段跳过（parseQuantity 有合法语义换算，如 "一箱半"→1.5）。
   */
  private detectFabricatedNumbers(
    docType: string,
    utterance: string,
    args: Record<string, unknown>,
  ): string[] {
    if (docType !== 'product_create') return [];
    const FIELDS: Array<[string, string]> = [
      ['retailPrice', '零售价'],
      ['wholesalePrice', '批发价'],
    ];
    const fabricated: string[] = [];
    for (const [f, label] of FIELDS) {
      const v = args[f];
      if (v === undefined || v === null) continue;
      const digits = String(v).replace(/\.0+$/, '');
      if (digits && !utterance.includes(digits)) {
        fabricated.push(label);
      }
    }
    return fabricated;
  }

  // ── LLM 抽取 ──

  private async callExtractLlM(
    schema: WriteDocSchema,
    utterance: string,
    model?: string,
    fewShots = '',
  ): Promise<Record<string, unknown> | null> {
    const resolved = await this.aiConfigService.getResolvedConfig();
    const routed = this.router.route({
      requestedModel: model,
      resolved,
      systemScope: this.configService.get<string>('SYSTEM_SCOPE', 'mgmt'),
    });

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是业务参数抽取器。从用户话语中抽取「' +
          schema.label +
          '」所需的结构化参数，调用 extract 函数返回。' +
          '只抽取用户明确提到的信息；缺失的可选字段不要编造；' +
          '数量保留数值（"一箱半"→1.5，"两三瓶"取大值3）；' +
          '金额统一为数字（元）。若用户话语与「' +
          schema.label +
          '」无关，直接回复"无关"两字，不调用函数。' +
          fewShots,
      },
      { role: 'user', content: utterance },
    ];

    // 1. Function Calling 抽取
    const toolCallResult = await routed.provider.chatSync(messages, {
      tools: [schemaToExtractTool(schema)],
      temperature: 0,
      max_tokens: 1024,
    });

    if (toolCallResult.tool_calls && toolCallResult.tool_calls.length > 0) {
      const call = toolCallResult.tool_calls[0];
      if (call.function && call.function.arguments) {
        const parsed = this.safeParseJson(call.function.arguments);
        if (parsed) {
          return parsed;
        }
      }
    }

    // 2. JSON mode 兜底：无 tool_calls（部分模型/未触发），解析纯 JSON 输出
    const content = toolCallResult.content?.trim() ?? '';
    if (content && content !== '无关') {
      // 剥离 markdown 代码块围栏（字符串处理，不做正则字段抽取）
      let jsonText = content;
      if (jsonText.startsWith('```')) {
        const firstNl = jsonText.indexOf('\n');
        if (firstNl >= 0) {
          jsonText = jsonText.slice(firstNl + 1);
        }
        if (jsonText.endsWith('```')) {
          jsonText = jsonText.slice(0, -3);
        }
        jsonText = jsonText.trim();
      }
      const parsed = this.safeParseJson(jsonText);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  private safeParseJson(text: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── 校验与类型强制 ──

  private validateAndCoerce(
    schema: WriteDocSchema,
    raw: Record<string, unknown>,
  ): { data: Record<string, unknown>; issues: ExtractionIssue[] } {
    const data: Record<string, unknown> = {};
    const issues: ExtractionIssue[] = [];

    for (const [name, field] of Object.entries(schema.fields)) {
      const value = raw[name];
      if (value === undefined || value === null || value === '') {
        if (field.required) {
          issues.push({
            field: name,
            reason: 'required',
            message: `缺少必填字段：${field.description}`,
            question: `请提供${field.description}？`,
          });
        }
        continue;
      }

      if (field.type === 'items') {
        this.validateItems(name, field, value, data, issues);
        continue;
      }

      const coerced = this.coerceField(field, value);
      if (coerced === undefined) {
        issues.push({
          field: name,
          reason: 'type',
          message: `${field.description}格式不正确`,
          question: `${field.description}的格式不对，请确认后重新告诉我？`,
        });
        continue;
      }
      data[name] = coerced;
    }

    return { data, issues };
  }

  private validateItems(
    name: string,
    field: WriteFieldSchema,
    value: unknown,
    data: Record<string, unknown>,
    issues: ExtractionIssue[],
  ): void {
    if (!Array.isArray(value) || value.length === 0) {
      if (field.required) {
        issues.push({
          field: name,
          reason: 'items',
          message: `${field.description}不能为空`,
          question: `请告诉我具体${field.description}（至少一项）？`,
        });
      }
      return;
    }

    const arr = value as unknown[];
    const items: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issues.push({
          field: `${name}[${i}]`,
          reason: 'type',
          message: `第 ${i + 1} 项${field.description}格式不正确`,
          question: `第 ${i + 1} 项${field.description}的信息不完整，请补充？`,
        });
        continue;
      }

      const record = item as Record<string, unknown>;
      const coercedItem: Record<string, unknown> = {};
      let itemOk = true;
      for (const [subName, subField] of Object.entries(
        field.itemFields ?? {},
      )) {
        const subValue = record[subName];
        if (subValue === undefined || subValue === null || subValue === '') {
          if (subField.required) {
            issues.push({
              field: `${name}[${i}].${subName}`,
              reason: 'required',
              message: `第 ${i + 1} 项缺少${subField.description}`,
              question: `第 ${i + 1} 项的${subField.description}是什么？`,
            });
            itemOk = false;
          }
          continue;
        }
        const coercedSub = this.coerceField(subField, subValue);
        if (coercedSub === undefined) {
          issues.push({
            field: `${name}[${i}].${subName}`,
            reason: 'type',
            message: `第 ${i + 1} 项的${subField.description}格式不正确`,
            question: `第 ${i + 1} 项的${subField.description}格式不对，请确认？`,
          });
          itemOk = false;
          continue;
        }
        coercedItem[subName] = coercedSub;
      }
      items.push(itemOk ? coercedItem : record);
    }
    data[name] = items;
  }

  private coerceField(field: WriteFieldSchema, value: unknown): unknown {
    // 枚举校验（字符串 trim 后比对）
    if (field.enum && field.enum.length > 0) {
      const str = typeof value === 'string' ? value.trim() : String(value);
      if (!field.enum.includes(str)) {
        return undefined;
      }
      return str;
    }

    switch (field.type) {
      case 'string':
        return typeof value === 'string' ? value.trim() : String(value);
      case 'number':
      case 'money':
      case 'quantity': {
        const n = coerceParam<number>(value, 'number');
        return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
      }
      case 'boolean': {
        const b = coerceParam<boolean>(value, 'boolean');
        return typeof b === 'boolean' ? b : undefined;
      }
      case 'date': {
        if (typeof value !== 'string') {
          return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      default:
        return value;
    }
  }

  // ── 数量语义辅助（nl-parser，仅补全口语数量，不做字段正则抽取）──

  private assistQuantity(
    utterance: string,
    schema: WriteDocSchema,
    raw: Record<string, unknown>,
  ): void {
    const itemsField = schema.fields.items;
    if (!itemsField || itemsField.type !== 'items' || !itemsField.itemFields) {
      return;
    }
    const hasBox = 'boxQty' in itemsField.itemFields;
    const hasBottle = 'bottleQty' in itemsField.itemFields;
    const hasQty = 'quantity' in itemsField.itemFields;
    if (!hasBox && !hasBottle && !hasQty) {
      return;
    }

    const items = raw.items;
    if (!Array.isArray(items)) {
      return;
    }

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const skuName =
        typeof record.skuName === 'string' ? record.skuName.trim() : '';
      if (!skuName) {
        continue;
      }

      const hasBoxValue = record.boxQty !== undefined && record.boxQty !== null;
      const hasBottleValue =
        record.bottleQty !== undefined && record.bottleQty !== null;
      const hasQtyValue =
        record.quantity !== undefined && record.quantity !== null;
      if ((hasBox || hasBottle) && (hasBoxValue || hasBottleValue)) {
        continue;
      }
      if (hasQty && hasQtyValue) {
        continue;
      }

      // 在 utterance 中定位商品名，取其前 12 字符作为数量候选片段
      const idx = utterance.indexOf(skuName);
      if (idx < 0) {
        continue;
      }
      const candidate = utterance.slice(Math.max(0, idx - 12), idx).trim();
      const quantity = this.extractQuantityFromFragment(candidate);
      if (!quantity) {
        continue;
      }

      if (hasBox && quantity.unit === 'box') {
        record.boxQty = quantity.qty;
      } else if (hasBottle && quantity.unit === 'bottle') {
        record.bottleQty = quantity.qty;
      } else if (hasQty && quantity.unit === 'bottle') {
        record.quantity = quantity.qty;
      }
    }
  }

  /**
   * 从候选片段提取数量：
   * 1. 优先循环剥离动作词前缀后调用 nl-parser（"来10箱" → 10 箱）
   * 2. 兜底从片段末尾向前扫描最近单位字符（"给红星商行来10箱" → 10 箱）
   *
   * 候选片段示例："来10箱"、"给我订5箱"、"要一箱半"、"商行来10箱"。
   */
  private extractQuantityFromFragment(
    fragment: string,
  ): { qty: number; unit: 'box' | 'bottle' | 'piece' } | null {
    const PREFIXES = [
      '给我',
      '帮我',
      '来点',
      '来',
      '要',
      '订',
      '买',
      '拿',
      '进',
      '送',
    ];
    let text = fragment.trim();
    let changed = true;
    while (changed && text) {
      changed = false;
      for (const p of PREFIXES) {
        if (text.startsWith(p)) {
          text = text.slice(p.length).trim();
          changed = true;
          break;
        }
      }
    }
    const parsed = parseQuantity(text);
    if (!parsed) {
      // 兜底：从末尾向前找单位字符（箱/瓶/件/提/扎），提取其前数字片段
      const UNIT_CHARS = '箱瓶件提扎';
      for (let i = fragment.length - 1; i >= 0; i--) {
        if (!UNIT_CHARS.includes(fragment[i])) {
          continue;
        }
        let start = i;
        while (start > 0) {
          const prev = fragment[start - 1];
          if (
            (prev >= '0' && prev <= '9') ||
            prev === '.' ||
            '零一二两三四五六七八九十半'.includes(prev)
          ) {
            start--;
          } else {
            break;
          }
        }
        // 单位后紧跟"半"（如"一箱半"）也纳入
        const end = fragment[i + 1] === '半' ? i + 2 : i + 1;
        const qtyText = fragment.slice(start, end);
        const qtyParsed = parseQuantity(qtyText);
        if (qtyParsed) {
          return { qty: qtyParsed.qty, unit: qtyParsed.unit };
        }
      }
      return null;
    }
    return { qty: parsed.qty, unit: parsed.unit };
  }

  // ── 参数合并 ──

  /**
   * 合并抽取结果到现有工具参数（只补缺失，不覆盖已有值）
   */
  private mergeArgs(
    args: Record<string, unknown>,
    extracted: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...args };

    for (const [key, value] of Object.entries(extracted)) {
      if (value === undefined || value === null) {
        continue;
      }
      const existing = merged[key];
      if (existing === undefined || existing === null || existing === '') {
        merged[key] = value;
      } else if (
        key === 'items' &&
        Array.isArray(value) &&
        (!Array.isArray(existing) || existing.length === 0)
      ) {
        merged[key] = value;
      }
    }

    return merged;
  }
}
