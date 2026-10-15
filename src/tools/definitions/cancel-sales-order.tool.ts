/**
 * cancelSalesOrder — 取消销售单（SO/SB）（**写工具**；R101-AI-36 · P1-3 兑现）
 *
 * MS 端点（2026-10-15 上线）：`POST /api/admin/sale-bills/:billNo/cancel`
 * - 入参：`{ reason?: string, source?: 'admin'|'ai' }` ⇒ **AI 侧必传 `source:'ai'`**
 *   （不传会被记成 admin ⇒ "AI 改动可追溯"断链；同 P0-3 教训）
 * - 权限码：`sale:cancel`；状态：仅 `UNPAID` / `PARTIAL` 可取消；`PAID` ⇒ 400 +「已结清需走冲销流程」
 * - 出参：`{ billNo, status:'CANCELLED', businessStatus:'VOIDED', reversedStock, ... }`
 * - 幂等：重复取消返回既有结果、**库存不二次回滚**（MS 侧保证）
 * - 原子性：作废 + 库存回滚 + 应收/提成调整同一事务（MS 侧保证）
 *
 * ⚠️ **双字段陷阱（MS 特意提醒）**：
 * - 契约字段 `status` 返回 `CANCELLED`
 * - 库内 `business_status` 是 **`VOIDED`**（MS 6 处统计按 `NOT IN ('DRAFT','VOIDED')` 过滤）
 * ⇒ 本工具**绝不写/校验** `business_status='CANCELLED'`；识别"已取消"一律看
 *   `businessStatus === 'VOIDED' || status === 'CANCELLED'`。
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）；`risk='high'`。
 * 幂等：`idempotencyKeyFields = ['billNo']`（业务键口径 AI-25 —— 同一张单重复取消 ⇒ 同一业务键 ⇒ 回放）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 取消结果（MS 契约；注意 businessStatus 是 VOIDED） */
interface CancelSaleBillResult {
  billNo?: string;
  status?: string;
  businessStatus?: string;
  reversedStock?: boolean;
  [key: string]: unknown;
}

/** 解析后的入参 */
interface CancelArgs {
  billNo: string;
  reason?: string;
  confirm: boolean;
}

/** 取消后可作废的业务状态（仅提示用途；真实判定在 MS） */
const CANCELLABLE_HINT = 'UNPAID/PARTIAL';

@Injectable()
export class CancelSalesOrderTool implements ITool {
  private readonly logger = new Logger(CancelSalesOrderTool.name);

  readonly name = 'cancelSalesOrder';
  readonly description =
    '取消销售单（**高危写操作**，需确认）：作废指定销售单（SO/SB 单号），' +
    '**同步回滚库存、调整应收与提成**（MS 侧同一事务）。仅未结清/部分结清可取消；' +
    '已结清会被后端拒绝并提示走冲销流程。重复取消不会二次回滚库存。' +
    '示例参数：{"billNo":"SO202610010001","reason":"客户取消订货","confirm":false}';
  readonly category = 'order' as const;
  readonly isWriteOperation = true;
  /** 高危：作废类写操作（同 cancelOrder 口径） */
  readonly risk = 'high' as const;
  /** 幂等业务键（AI-25）：同一张单重复取消 ⇒ 同一键 ⇒ 回放 */
  readonly idempotencyKeyFields = ['billNo'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      billNo: {
        type: 'string',
        description: '销售单号（必填，SO/SB 前缀；如 SO202610010001）',
      },
      reason: {
        type: 'string',
        description: '取消原因（可选，建议填写便于追溯）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不执行取消）',
      },
    },
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const { billNo, reason, confirm } = parsed.data;

    // ── 预览阶段：不调后端、不改任何状态 ──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '取消销售单',
          summary: `将作废销售单 ${billNo}${reason ? `（原因：${reason}）` : ''}`,
          details: {
            billNo,
            reason: reason ?? null,
            // 来源标记：AI 发起的改动必须可追溯（MS 缺省记 admin）
            source: 'ai',
            consequence:
              '取消后库存将回滚、应收与提成同步调整（MS 侧同一事务）；仅未结清/部分结清可取消',
            cancellableHint: CANCELLABLE_HINT,
          },
          reviewRequired: true,
        },
      };
    }

    try {
      const result = await this.serviceClient.post<CancelSaleBillResult>(
        `${API_ENDPOINTS.SALE_BILLS}/${billNo}/cancel`,
        {
          ...(reason ? { reason } : {}),
          // 🔴 必传：不传则来源记 admin，"AI 改动可追溯"断链
          source: 'ai',
        },
        context,
      );

      // 双字段口径：契约 status=CANCELLED / 库内 business_status=VOIDED
      const cancelled =
        result?.status === 'CANCELLED' || result?.businessStatus === 'VOIDED';

      return {
        success: true,
        data: {
          billNo: result?.billNo ?? billNo,
          status: result?.status ?? null,
          businessStatus: result?.businessStatus ?? null,
          reversedStock: result?.reversedStock ?? null,
          source: 'ai',
          cancelled,
          message: `销售单 ${result?.billNo ?? billNo} 已取消（作废）${
            result?.reversedStock ? '，库存已回滚' : ''
          }`,
        },
      };
    } catch (err) {
      // MS 400（已结清 ⇒ "已结清需走冲销流程"）及其它错误：**原样透出可读文案**（R101-AI-27）
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(`取消销售单失败：${errorMsg}`);
      return {
        success: false,
        error: `取消销售单失败：${errorMsg}`,
        suggestion:
          '请确认：① 单号正确（SO/SB）② 该单为未结清/部分结清（已结清需走冲销流程）③ 当前账号具备 sale:cancel 权限',
      };
    }
  }

  /** 入参解析（billNo 必填；confirm 透传） */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CancelArgs }
    | { valid: false; error: string; suggestion: string } {
    const billNo =
      typeof args.billNo === 'string' && args.billNo.trim().length > 0
        ? args.billNo.trim()
        : '';
    if (billNo.length === 0) {
      return {
        valid: false,
        error: 'billNo 不能为空',
        suggestion: '请提供要取消的销售单号（SO/SB 前缀）',
      };
    }
    const reason =
      typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason.trim()
        : undefined;
    return {
      valid: true,
      data: { billNo, reason, confirm: args.confirm === true },
    };
  }
}
