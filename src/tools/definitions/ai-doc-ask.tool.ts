/**
 * aiDocAsk — 文档中心 · 对话式问答（**读工具**；AI-P1-3）
 *
 * 商户体验目标（业主 2026-10-23 口径）：一句话问"这份合同的关键付款条款是什么"，
 * AI 读该商户**有权访问**的那篇文档正文，给出**基于原文、带出处**的回答。
 * 人工要"打开文档→翻找→作答"三步，AI 一步直达且每条答案可回溯原文。
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动（不进写审核门、不耗幂等键、读宽桶）。
 *
 * 两条硬约束的落点（派单卡 §二，均为调研核准的事实而非臆测）：
 * ① **无环**：LLM 经 `DocAskRunner`（tools 叶子 holder）调用，Brain 侧
 *   `DocAskBridge` 注册真实现 ⇒ ToolsModule **不 import BrainModule**。
 *   反测：`app.module.di.spec` 编译通过（全仓唯一无环铁证）。
 * ② **正文唯一来源 = 已入库分块**（`t_ai_knowledge_chunks`，`doc_name === t_ai_doc.id`）：
 *   `t_ai_doc` 不存正文。该 docId 无分块 ⇒ 如实返回「未建立索引」+ 可执行建议，
 *   **不回退读 storagePath 假装成功**（扩范围需另单）。
 *
 * 安全线（权限永远优先于相关性/可用性）：
 * - **必经 `OfficeAclService.getVisible`**：无权与不存在同一口径（防存在性泄漏，
 *   照抄 ai-doc-get.tool.ts）；ACL 不通过 ⇒ **零次 LLM 调用**（不消耗、不泄漏）。
 * - 只喂**该 docId** 的分块进 prompt ⇒ 天然防跨文档串料。
 * - **citations 由本工具按 chunkIndex 组装，不采信 LLM 自报出处**。
 * - LLM 失败/未装配 ⇒ success:false + 重试建议，**绝不返回编造答案**。
 * - 商户文案不出现 provider/chunks/embedding 等内部术语。
 *
 * 负责人: 阿澈 | 创建日期: 2026-10-24
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { DocAskRunner } from '../doc-ask-runner';
import { principalOf } from './ai-doc-list.tool';

/** 每篇文档进 prompt 的最大分块数（默认值，topK 入参可调） */
const DEFAULT_TOP_K = 6;
const MAX_TOP_K = 20;
/** 单分块进 prompt 的截断长度（控上下文成本，与答案依据性平衡） */
const PASSAGE_MAX_CHARS = 800;

/** DataSource.query 的行类型（照 vector-store.service.ts 同规范） */
type Row = Record<string, unknown>;

const CHUNKS_TABLE = 't_ai_knowledge_chunks';

interface ChunkRow {
  chunkIndex: number;
  text: string;
}

@Injectable()
export class AiDocAskTool implements ITool {
  private readonly logger = new Logger(AiDocAskTool.name);

  readonly name = 'aiDocAsk';
  readonly description =
    '文档中心-对一篇文档提问（只读）：在你有权访问的指定文档内，用自然语言提问，' +
    'AI 只依据该文档已建立索引的原文回答，并给出可核对的原文出处。' +
    '适合"这份合同的关键付款条款是什么""这个制度里请假流程怎么走"等场景。' +
    '若文档尚未建立内容索引，会明确告知而不是瞎答。' +
    '示例参数：{"docId":"12","question":"关键付款条款是什么？"}';
  readonly category = 'office' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      docId: {
        type: 'string',
        description: '文档 ID（必填，可由 aiDocList/aiDocSearch 获取）',
      },
      question: {
        type: 'string',
        description: '问题（必填，自然语言）',
      },
      topK: {
        type: 'number',
        description: `参考原文片段数（可选，默认 ${DEFAULT_TOP_K}，上限 ${MAX_TOP_K}）`,
      },
    },
  };

  constructor(
    private readonly docAcl: OfficeAclService,
    private readonly runner: DocAskRunner,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const docId =
      typeof args.docId === 'string' && args.docId.trim().length > 0
        ? args.docId.trim()
        : '';
    const question =
      typeof args.question === 'string' && args.question.trim().length > 0
        ? args.question.trim()
        : '';
    if (docId.length === 0) {
      return {
        success: false,
        error: 'docId 不能为空',
        suggestion: '请提供文档 ID（可由 aiDocList/aiDocSearch 获取）',
      };
    }
    if (question.length === 0) {
      return {
        success: false,
        error: 'question 不能为空',
        suggestion: '请用自然语言描述你要问的内容',
      };
    }
    const rawTopK =
      typeof args.topK === 'number' &&
      Number.isFinite(args.topK) &&
      args.topK >= 1
        ? Math.floor(args.topK)
        : DEFAULT_TOP_K;
    const topK = Math.min(rawTopK, MAX_TOP_K);

    try {
      // ── 硬约束：ACL 先行（无权/不存在同一口径，防存在性泄漏）──
      // LLM 调用在 ACL 之后 ⇒ 未授权文档零消耗、零泄漏（连"它存在"都不确认）
      const { doc } = await this.docAcl.getVisible(docId, {
        tenantId: context.tenantId,
        principal: principalOf(context),
      });
      if (!doc) {
        return {
          success: false,
          error: `文档不存在或无权访问：${docId}`,
          suggestion: '请用 aiDocList 查看你有权访问的文档',
        };
      }

      // ── 正文唯一来源：已入库分块（硬约束 2；doc_name === t_ai_doc.id）──
      const rows = await this.dataSource.query<Row[]>(
        `SELECT chunk_index, chunk_text FROM ${CHUNKS_TABLE}
         WHERE tenant_id = ? AND doc_name = ?
         ORDER BY chunk_index ASC`,
        [context.tenantId, doc.id],
      );
      const chunks: ChunkRow[] = rows
        .map((r) => ({
          chunkIndex: Number(r.chunk_index ?? 0),
          text: typeof r.chunk_text === 'string' ? r.chunk_text : '',
        }))
        .filter((c) => c.text.length > 0);

      if (chunks.length === 0) {
        // 如实降级：不编造、不读文件假装成功（扩范围需另单）
        return {
          success: true,
          data: {
            docId: doc.id,
            title: doc.title,
            status: 'not_indexed',
            answer: null,
            note:
              '该文档尚未建立可问答的内容索引（上传/建档后系统会自动处理，可能仍在排队）。' +
              '建议稍后再问，或先用 aiDocSearch 按关键词检索确认文档内容。',
          },
        };
      }

      // 取前 topK 分块（按序）；编号 index 即引用锚点
      const passages = chunks.slice(0, topK).map((c, i) => ({
        index: i + 1,
        chunkIndex: c.chunkIndex,
        text:
          c.text.length > PASSAGE_MAX_CHARS
            ? `${c.text.slice(0, PASSAGE_MAX_CHARS)}…`
            : c.text,
      }));

      // ── LLM 调用（经叶子 holder，Brain 侧 Bridge 注册实现 ⇒ 无环）──
      let answer: string;
      let providerName: string;
      let fallbackUsed: boolean;
      try {
        const out = await this.runner.ask({
          tenantId: context.tenantId,
          docId: doc.id,
          docTitle: doc.title,
          question,
          passages,
        });
        answer = out.answer.trim();
        providerName = out.provider;
        fallbackUsed = out.fallbackUsed;
      } catch (err) {
        // 模型全链失败/未装配 ⇒ 失败透明，绝不编造
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`文档问答模型调用失败（降级为失败结果）：${message}`);
        // ⚠️ 返回给商户的 error 固定话术：内部原因（执行器未注册等）只进日志，
        //   不外泄实现术语（商户体验判据 5）
        return {
          success: false,
          error: '暂时无法回答该问题（AI 服务暂不可用）',
          suggestion: '请稍后重试；若持续失败请联系管理员检查 AI 模型配置',
        };
      }

      if (answer.length === 0) {
        return {
          success: false,
          error: '暂时无法回答该问题（AI 服务未返回内容）',
          suggestion: '请换个问法稍后重试',
        };
      }

      return {
        success: true,
        data: {
          docId: doc.id,
          title: doc.title,
          status: 'answered',
          answer,
          // citations 由本工具组装（chunkIndex 可回溯原文），不采信模型自报出处
          citations: passages.map((p) => ({
            index: p.index,
            chunkIndex: p.chunkIndex,
            snippet: p.text.slice(0, 160),
          })),
          passagesUsed: passages.length,
          // 商户文案不含内部术语；此二元组仅供技术侧可观测
          meta: { model: providerName, fallbackUsed },
        },
      };
    } catch (err) {
      // AI-P1-3F1：DB/ACL 等基础设施异常**只进日志**，商户文案固定化。
      // 事故背景：DB 抛 "Table 'liquor_inventory.t_ai_knowledge_chunks' doesn't exist"
      // 时旧实现把原文拼进 error ⇒ 商户看到内部表名（信息泄漏 + 无法理解）。
      // 红线：不吞错误、不返回假成功 —— 仍是 success:false，只是文案脱敏。
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`文档问答失败（内部原因仅记日志）：${message}`);
      return {
        success: false,
        error: '当前暂时无法读取这份文档，请稍后重试',
        suggestion: '请稍后重试；若持续失败请联系管理员',
      };
    }
  }
}
