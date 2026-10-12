/**
 * 业务幂等字段声明守卫（R101-AI-25）
 *
 * 目的：`idempotencyKeyFields` 是**声明式**元数据 —— 若字段名拼错，闸门会静默走
 * payload 兜底（机制不崩但形同未声明）。本文件把这条守成断言：
 * 1. 首批覆盖 3~5 个 B 类工具（本单 4 个），不得一次铺满
 * 2. 每个声明字段必须真实存在于该工具的 `parameters.properties`
 * 3. 未声明的工具（如 create-sales-order 等 items 驱动类）保持无声明 ⇒ 行为零变化
 * 4. 声明中不得出现流程噪音字段（confirm/force/requestId/sessionId/timestamp）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { CreateExpenseTool } from './definitions/create-expense.tool';
import { CreatePurchasePaymentTool } from './definitions/create-purchase-payment.tool';
import { CreatePurchaseContractTool } from './definitions/create-purchase-contract.tool';
import { CreateCustomerTool } from './definitions/create-customer.tool';
import { CreateSalesOrderTool } from './definitions/create-sales-order.tool';
import { CreatePurchaseOrderTool } from './definitions/create-purchase-order.tool';
import type { ITool } from './tool.interface';

/** 流程噪音字段：列入会让防重失效（每跳都变或与业务身份无关） */
const PLUMBING_FIELDS = [
  'confirm',
  'force',
  'requestId',
  'sessionId',
  'timestamp',
  'idempotencyKey',
];

/** 首批声明的 B 类工具（R101-AI-25，务实起步：只做最易误拦的 4 个） */
const DECLARED: ITool[] = [
  new CreateExpenseTool({} as never),
  new CreatePurchasePaymentTool({} as never),
  new CreatePurchaseContractTool({} as never),
  new CreateCustomerTool({} as never),
];

/** 明确**不**声明的 items 驱动类（同 items 重复下单/退货是常见合法行为，收窄键更危险） */
const UNDECLARED: ITool[] = [
  new CreateSalesOrderTool({} as never, {} as never, {} as never),
  new CreatePurchaseOrderTool({} as never, {} as never, {} as never),
];

describe('idempotencyKeyFields 声明守卫（R101-AI-25）', () => {
  it('首批覆盖 3~5 个工具（本单 4 个），不得一次铺满', () => {
    expect(DECLARED.length).toBeGreaterThanOrEqual(3);
    expect(DECLARED.length).toBeLessThanOrEqual(5);
    for (const tool of DECLARED) {
      expect(tool.idempotencyKeyFields?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it.each(DECLARED.map((t) => [t.name, t] as const))(
    '%s：声明字段全部存在于 parameters.properties',
    (_name, tool) => {
      const properties = (
        tool.parameters as { properties?: Record<string, unknown> }
      ).properties;
      expect(properties).toBeDefined();
      const declared = tool.idempotencyKeyFields ?? [];
      for (const field of declared) {
        expect(Object.keys(properties ?? {})).toContain(field);
      }
    },
  );

  it.each(DECLARED.map((t) => [t.name, t] as const))(
    '%s：声明中不含流程噪音字段',
    (_name, tool) => {
      for (const field of tool.idempotencyKeyFields ?? []) {
        expect(PLUMBING_FIELDS).not.toContain(field);
      }
    },
  );

  it.each(DECLARED.map((t) => [t.name, t] as const))(
    '%s：声明包含「备注」类易变字段（本单提精度的实际来源）',
    (_name, tool) => {
      expect(tool.idempotencyKeyFields).toContain('remark');
    },
  );

  it.each(UNDECLARED.map((t) => [t.name, t] as const))(
    '%s：未声明 ⇒ 走 payload 兜底（行为零变化）',
    (_name, tool) => {
      expect(tool.idempotencyKeyFields).toBeUndefined();
    },
  );
});
