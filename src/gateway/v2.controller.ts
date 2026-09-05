/**
 * V2Controller — v2 报表/自然语言协议（批次3，文档 11.1/11.3）
 *
 * 端点：
 * - POST /api/ai/v2/handle      自然语言入口（读自动 / 写挂起 pendingWrite JSON）
 * - POST /api/ai/v2/confirm     受控写确认（等价 WriteGuard /ai/agent/confirm）
 * - POST /api/ai/v2/report      生成报表（A/B/C/D 类）
 * - POST /api/ai/v2/report/pdf  报表导出 PDF
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { Body, Controller, Header, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { V2HandleService, V2HandleResult } from '../brain/v2/v2-handle.service';
import { ReportService } from '../brain/v2/report.service';
import { ConfirmationService } from '../brain/confirmation.service';
import { TenantContext } from '../tenant/tenant-context';
import type { ToolContext } from '../tools/tool.interface';
import {
  V2ConfirmDto,
  V2HandleDto,
  V2ReportDto,
  V2ReportPdfDto,
} from './dto/v2.dto';

@Controller('ai/v2')
export class V2Controller {
  private readonly logger = new Logger(V2Controller.name);

  constructor(
    private readonly handleService: V2HandleService,
    private readonly reportService: ReportService,
    private readonly confirmationService: ConfirmationService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * 自然语言入口（JSON；SSE 能力由 /ai/chat 与 /ai/agent/run 提供）
   *
   * POST /api/ai/v2/handle
   * 读/分析 → { intent:'analysis', message }
   * 写意图 → { intent:'write', pendingWrite:{ token, docType, risk, summary } }
   * 缺参   → { intent:'clarify', message }
   */
  @Post('handle')
  async handle(@Body() dto: V2HandleDto): Promise<V2HandleResult> {
    // 2026-09-05 鉴权链收紧：身份只认 JWT（TenantContext），请求体字段仅为前端兼容保留
    const ctx = this.tenantContext.getData();
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      return {
        intent: 'clarify',
        message: '未认证：请在 Authorization Header 中携带 JWT（AI_001）',
      };
    }
    // scope=platform 仅限平台（总台）身份（AI_010）
    if (dto.scope === 'platform' && ctx?.authType !== 'platform') {
      return {
        intent: 'clarify',
        message: '无权限：platform 工具域仅限总台平台身份调用（AI_010）',
      };
    }
    return this.handleService.handle(dto.input, {
      tenantId,
      userId: ctx?.userId,
      role: ctx?.role,
      customerId: ctx?.customerId,
      authToken: ctx?.authToken,
      sessionId: dto.sessionId,
      model: dto.model,
      scope: dto.scope,
    });
  }

  /**
   * 受控写确认
   *
   * POST /api/ai/v2/confirm  { token, remark? }
   * 响应：{ ok, docId?, needsSecondConfirm?, message?, error?, suggestion? }
   */
  @Post('confirm')
  async confirm(@Body() dto: V2ConfirmDto): Promise<{
    ok: boolean;
    docId?: string;
    needsSecondConfirm?: boolean;
    message?: string;
    error?: string;
    suggestion?: string;
  }> {
    const ctx = this.tenantContext.getData();
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      return { ok: false, error: '未认证：无法确定租户身份' };
    }
    const toolContext: ToolContext = {
      tenantId,
      userId: ctx?.userId,
      sessionId: ctx?.sessionId,
      role: ctx?.role,
      customerId: ctx?.customerId,
      authToken: ctx?.authToken,
    };
    const result = await this.confirmationService.confirmAndExecute(
      dto.token,
      tenantId,
      toolContext,
      dto.remark,
    );
    if (!result.success) {
      return {
        ok: false,
        error: result.error,
        suggestion: result.suggestion,
      };
    }
    if (result.needsSecondConfirm) {
      return {
        ok: true,
        needsSecondConfirm: true,
        message: '高危操作需二次确认，请再次确认执行',
      };
    }
    const docId = extractDocId(result.data);
    this.logger.log(
      `v2/confirm 执行成功：token=${dto.token.slice(0, 12)}… tenant=${tenantId} docId=${docId ?? '-'}`,
    );
    return { ok: true, docId, message: result.message };
  }

  /**
   * 生成报表
   *
   * POST /api/ai/v2/report  { type:'A'|'B'|'C'|'D', params? }
   */
  @Post('report')
  async report(@Body() dto: V2ReportDto) {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }
    try {
      const result = await this.reportService.generate(
        dto.type,
        dto.params ?? {},
        this.buildToolContext(tenantId),
      );
      return { success: true, report: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * 报表导出 PDF
   *
   * POST /api/ai/v2/report/pdf  { type, params? }
   * 响应：application/pdf（Content-Disposition: attachment）
   */
  @Post('report/pdf')
  @Header('Content-Type', 'application/pdf')
  async reportPdf(
    @Body() dto: V2ReportPdfDto,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      res
        .status(401)
        .json({ success: false, error: '未认证：无法确定租户身份' });
      return;
    }
    try {
      const result = await this.reportService.generate(
        dto.type,
        dto.params ?? {},
        this.buildToolContext(tenantId),
      );
      const pdf = await this.reportService.renderPdf(result);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="report-${dto.type}-${Date.now()}.pdf"`,
      );
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`PDF 导出失败：${msg}`);
      res.status(500).json({ success: false, error: `PDF 导出失败：${msg}` });
    }
  }

  private buildToolContext(tenantId: string): ToolContext {
    const ctx = this.tenantContext.getData();
    return {
      tenantId,
      userId: ctx?.userId,
      sessionId: ctx?.sessionId,
      role: ctx?.role,
      customerId: ctx?.customerId,
      authToken: ctx?.authToken,
    };
  }
}

/**
 * 从写工具返回值提取业务单据号（orderNo/docNo/orderId/id/recordId/no/code 等）
 */
export function extractDocId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const candidates = [
    'orderNo',
    'docNo',
    'orderId',
    'recordId',
    'id',
    'no',
    'code',
    'purchaseNo',
    'planNo',
  ];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'string' && v) {
      return v;
    }
    if (typeof v === 'number' && v > 0) {
      return String(v);
    }
  }
  return undefined;
}
