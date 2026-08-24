/**
 * R70-15 ConfirmationService 单元测试
 *
 * 测试覆盖：
 * 1. create/get/listPending — 待确认操作管理 + TTL + 租户隔离
 * 2. confirm/cancel — 确认与取消 + 边界校验
 * 3. registerExecuted/canRevoke/markRevoked — 3分钟撤销窗口
 * 4. isConfirmMessage/isCancelMessage — 确认词/拒绝词识别
 * 5. cleanupExpired — 过期清理
 *
 * 验收标准覆盖：
 * - 写操作生成预览（confirmationId）✅
 * - 用户确认→执行（confirm 端点）✅
 * - 3分钟内可撤销（canRevoke 窗口校验）✅
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import {
  ConfirmationService,
  CONFIRM_TTL_MS,
  REVOKE_TTL_MS,
} from './confirmation.service';

describe('R70-15 ConfirmationService', () => {
  let service: ConfirmationService;

  beforeEach(() => {
    service = new ConfirmationService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const baseInput = {
    tenantId: 'tenant-A',
    conversationId: 'conv-1',
    toolName: 'createSalesOrder',
    args: { customerId: 1, items: [{ skuId: 101, boxQty: 5 }] },
    preview: {
      operation: '创建销售单',
      summary: '红星商行 5 箱五粮液，合计 4900 元',
      details: { customerName: '红星商行', totalAmount: 4900 },
    },
    operationLabel: '创建销售单',
  };

  // ── 1. create / get / listPending ──
  describe('create/get/listPending', () => {
    it('创建待确认记录应生成唯一 confirmationId 且 TTL 为 5 分钟', () => {
      const record = service.create(baseInput);

      expect(record.confirmationId).toBeDefined();
      expect(record.confirmationId.length).toBeGreaterThan(0);
      expect(record.status).toBe('pending');
      expect(record.expiresAt - record.createdAt).toBe(CONFIRM_TTL_MS);
      expect(record.preview?.operation).toBe('创建销售单');
    });

    it('重复创建应生成不同的 confirmationId', () => {
      const r1 = service.create(baseInput);
      const r2 = service.create(baseInput);
      expect(r1.confirmationId).not.toBe(r2.confirmationId);
    });

    it('get 应返回未过期的记录', () => {
      const record = service.create(baseInput);
      const found = service.get(record.confirmationId);
      expect(found?.toolName).toBe('createSalesOrder');
      expect(found?.tenantId).toBe('tenant-A');
    });

    it('get 不存在的 ID 应返回 null', () => {
      expect(service.get('not-exist')).toBeNull();
    });

    it('get 过期记录应返回 null 并清除', () => {
      const record = service.create(baseInput);
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);
      expect(service.get(record.confirmationId)).toBeNull();
    });

    it('listPending 应按租户隔离并排除过期记录', () => {
      // 先创建会过期的记录（tenant-A）
      const expired = service.create({
        ...baseInput,
        tenantId: 'tenant-A',
        toolName: 'createPurchaseOrder',
      });

      // 时间推进超过 TTL，expired 过期
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);

      // 过期后再创建有效记录（tenant-A 与 tenant-B）
      service.create(baseInput); // tenant-A
      service.create({ ...baseInput, tenantId: 'tenant-B' }); // tenant-B

      const pendingA = service.listPending('tenant-A');
      // expired 过期被清除，只剩 tenant-A 的有效记录
      expect(pendingA).toHaveLength(1);
      expect(pendingA[0].toolName).toBe('createSalesOrder');
      expect(service.get(expired.confirmationId)).toBeNull();
    });
  });

  // ── 2. confirm / cancel ──
  describe('confirm/cancel', () => {
    it('confirm 成功应将状态置为 confirmed', () => {
      const record = service.create(baseInput);
      const result = service.confirm(record.confirmationId, 'tenant-A');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.confirmation.status).toBe('confirmed');
      }
    });

    it('confirm 不存在的 ID 应返回失败', () => {
      const result = service.confirm('not-exist', 'tenant-A');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('不存在');
      }
    });

    it('confirm 过期记录应返回失败', () => {
      const record = service.create(baseInput);
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);
      const result = service.confirm(record.confirmationId, 'tenant-A');
      expect(result.success).toBe(false);
    });

    it('confirm 其他租户的记录应返回失败', () => {
      const record = service.create(baseInput);
      const result = service.confirm(record.confirmationId, 'tenant-B');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('其他租户');
      }
    });

    it('重复 confirm 应返回失败', () => {
      const record = service.create(baseInput);
      service.confirm(record.confirmationId, 'tenant-A');
      const again = service.confirm(record.confirmationId, 'tenant-A');
      expect(again.success).toBe(false);
    });

    it('cancel 成功应移除记录', () => {
      const record = service.create(baseInput);
      const cancelled = service.cancel(record.confirmationId, 'tenant-A');
      expect(cancelled).toBe(true);
      expect(service.get(record.confirmationId)).toBeNull();
    });

    it('cancel 其他租户的记录应返回 false', () => {
      const record = service.create(baseInput);
      expect(service.cancel(record.confirmationId, 'tenant-B')).toBe(false);
    });
  });

  // ── 3. 撤销窗口管理 ──
  describe('registerExecuted/canRevoke/markRevoked', () => {
    it('registerExecuted 应开启 3 分钟撤销窗口', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        confirmationId: 'c-1',
        toolName: 'createSalesOrder',
        args: { customerId: 1, confirm: true },
        result: { billNo: 'SB20260801001' },
        operationLabel: '创建销售单',
      });

      expect(operation.operationId).toBeDefined();
      expect(operation.status).toBe('executed');
      expect(operation.revokeExpiresAt - operation.executedAt).toBe(
        REVOKE_TTL_MS,
      );
    });

    it('3 分钟窗口内 canRevoke 返回 ok', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      expect(service.canRevoke(operation.operationId, 'tenant-A').ok).toBe(
        true,
      );
    });

    it('超过 3 分钟 canRevoke 返回失败', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      jest.advanceTimersByTime(REVOKE_TTL_MS + 1000);
      const check = service.canRevoke(operation.operationId, 'tenant-A');
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('3 分钟');
    });

    it('其他租户的操作不可撤销', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      expect(service.canRevoke(operation.operationId, 'tenant-B').ok).toBe(
        false,
      );
    });

    it('markRevoked 成功应移除记录，再次查询不可撤销', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      expect(service.markRevoked(operation.operationId, 'tenant-A')).toBe(true);
      expect(service.canRevoke(operation.operationId, 'tenant-A').ok).toBe(
        false,
      );
      expect(service.getExecuted(operation.operationId)).toBeNull();
    });

    it('撤销已撤销/超时的操作应返回 false', () => {
      const operation = service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });
      service.markRevoked(operation.operationId, 'tenant-A');
      expect(service.markRevoked(operation.operationId, 'tenant-A')).toBe(
        false,
      );
    });
  });

  // ── 4. 确认词/拒绝词识别 ──
  describe('isConfirmMessage/isCancelMessage', () => {
    it('确认词应被识别为确认', () => {
      expect(ConfirmationService.isConfirmMessage('确认')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('可以')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('没问题')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('执行')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('开单')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('确认创建')).toBe(true);
    });

    it('带前后缀的确认语应被识别', () => {
      expect(ConfirmationService.isConfirmMessage('确认，就这么办')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('好的，创建吧')).toBe(true);
    });

    it('非确认词不应被误判为确认', () => {
      expect(ConfirmationService.isConfirmMessage('查一下库存')).toBe(false);
      expect(ConfirmationService.isConfirmMessage('帮我改一下价格')).toBe(
        false,
      );
    });

    it('单字确认词的常见词语不应被误判（行李箱/对比一下）', () => {
      expect(ConfirmationService.isConfirmMessage('行李箱多少钱')).toBe(false);
      expect(ConfirmationService.isConfirmMessage('对比一下两家价格')).toBe(
        false,
      );
      expect(ConfirmationService.isConfirmMessage('对，就这么办')).toBe(true);
      expect(ConfirmationService.isConfirmMessage('行，可以')).toBe(true);
    });

    it('取消词应被识别为取消', () => {
      expect(ConfirmationService.isCancelMessage('取消')).toBe(true);
      expect(ConfirmationService.isCancelMessage('算了')).toBe(true);
      expect(ConfirmationService.isCancelMessage('不要了')).toBe(true);
      expect(ConfirmationService.isCancelMessage('等等，我改一下')).toBe(true);
      expect(ConfirmationService.isCancelMessage('撤销刚才的单子')).toBe(true);
    });
  });

  // ── 5. cleanupExpired ──
  describe('cleanupExpired', () => {
    it('应清理过期的待确认与已执行记录', () => {
      service.create(baseInput);
      service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      jest.advanceTimersByTime(Math.max(CONFIRM_TTL_MS, REVOKE_TTL_MS) + 1000);
      const cleaned = service.cleanupExpired();

      expect(cleaned).toBe(2);
      expect(service.listPending('tenant-A')).toHaveLength(0);
    });

    it('无过期记录时清理数量为 0', () => {
      service.create(baseInput);
      expect(service.cleanupExpired()).toBe(0);
    });
  });
});
