/**
 * normalizeCaptureIntent 归一矩阵测试（AI-P2-4-CAPTURE-INTENT-NORMALIZE-01）
 *
 * 口径：normalizeCaptureIntent(toolOrIntent, fallback='chat')
 *       = docTypeForTool(trimmed) ?? trimmed ?? fallback
 * - 映射命中 → 裸 docType（唯一映射真源 = write-schema-registry）；
 * - 未映射工具名保持原值（不得折叠成 chat）；
 * - 非工具意图（office_document/write/analysis/agent_plan/graph）保持原值；
 * - 空值/纯空白回退 fallback。
 */
import { normalizeCaptureIntent } from './capture-intent';

describe('normalizeCaptureIntent（三通道 Capture intent 归一矩阵）', () => {
  describe('映射命中 → 裸 docType（卡面三.1 七例全覆盖）', () => {
    it.each([
      ['createSalesOrder', 'sales_order'],
      ['createCustomer', 'customer_create'],
      ['updateProductPrice', 'price_update'],
      ['inventoryTransfer', 'inventory_transfer'],
      ['stockCheck', 'inventory_check'],
      ['createRefund', 'refund'],
      ['api_create_flash_sale', 'promotion'],
    ] as const)('%s ⇒ %s', (tool, expected) => {
      expect(normalizeCaptureIntent(tool)).toBe(expected);
    });
  });

  describe('未映射与非工具意图保持原值（不得折叠成 chat）', () => {
    it('未映射工具名保持原值', () => {
      expect(normalizeCaptureIntent('querySaleBills')).toBe('querySaleBills');
    });

    it.each([
      'office_document',
      'write',
      'analysis',
      'agent_plan',
      'graph',
    ] as const)("非工具意图 '%s' 保持原值", (intent) => {
      expect(normalizeCaptureIntent(intent)).toBe(intent);
    });

    it('前后空白先 trim 再查表（空白包裹的映射名仍命中）', () => {
      expect(normalizeCaptureIntent('  createSalesOrder  ')).toBe(
        'sales_order',
      );
    });

    it('trim 后原值返回（不带尾随空白）', () => {
      expect(normalizeCaptureIntent('  querySaleBills  ')).toBe(
        'querySaleBills',
      );
    });
  });

  describe('空值回退', () => {
    it.each([undefined, null, '', '   '] as const)(
      '空值 %p ⇒ 缺省 fallback chat',
      (v) => {
        expect(normalizeCaptureIntent(v)).toBe('chat');
      },
    );

    it('显式 fallback：graph 通道空工具回退 graph', () => {
      expect(normalizeCaptureIntent(undefined, 'graph')).toBe('graph');
    });

    it('显式 fallback：agent 通道空值回退 agent', () => {
      expect(normalizeCaptureIntent('', 'agent')).toBe('agent');
    });
  });

  describe('反测边界（防回归）', () => {
    it('未知工具不得被折叠成 chat（M2 反测锚）', () => {
      const result = normalizeCaptureIntent('totallyUnknownTool');
      expect(result).not.toBe('chat');
      expect(result).toBe('totallyUnknownTool');
    });

    it('非工具意图不得被规则推导成假 docType', () => {
      // write/analysis 若被驼峰转下划线之类推导会凭空造出注册表不存在的值
      expect(normalizeCaptureIntent('write')).toBe('write');
      expect(normalizeCaptureIntent('analysis')).toBe('analysis');
    });
  });
});
