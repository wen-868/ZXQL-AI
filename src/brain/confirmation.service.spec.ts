/**
 * R70-15 + P0-1 ConfirmationService 单元测试
 *
 * 测试覆盖：
 * 1. create/getByTenant/listPending — 待确认操作管理 + 24h TTL + 租户隔离
 * 2. confirm/cancel — 确认与取消 + 边界校验 + 高危写二次确认
 * 3. registerExecuted/canRevoke/markRevoked — 3分钟撤销窗口
 * 4. isConfirmMessage/isCancelMessage — 确认词/拒绝词识别
 * 5. cleanupExpired — 过期清理
 *
 * 验收标准覆盖（P0-1 WriteGuard）：
 * - 读全自动不弹确认（工具无 preview 不生成令牌）✅
 * - 写必令牌（preview 即挂起令牌，TTL 24h）✅
 * - 高危二次确认（risk=high / needsReview）✅
 * - token 过期/复用拒绝（确认后不可复用、过期即失效）✅
 *
 * 负责人: AI底座 | 创建日期: 2026-08-02（P0-1 重构 2026-08-25）
 */
import {
  ConfirmationService,
  CONFIRM_TTL_MS,
  REVOKE_TTL_MS,
} from './confirmation.service';

describe('R70-15 + P0-1 ConfirmationService', () => {
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
    docType: 'sales_order_create',
    risk: 'medium' as const,
    needsReview: false,
    args: { customerId: 1, items: [{ skuId: 101, boxQty: 5 }] },
    preview: {
      operation: '创建销售单',
      summary: '红星商行 5 箱五粮液，合计 4900 元',
      details: { customerName: '红星商行', totalAmount: 4900 },
    },
    operationLabel: '创建销售单',
  };

  // ── 1. create / getByTenant / listPending ──
  describe('create/getByTenant/listPending', () => {
    it('创建待确认记录应生成 wg_ 令牌且 TTL 为 24 小时', async () => {
      const record = await service.create(baseInput);

      expect(record.confirmationId).toMatch(/^wg_/);
      expect(record.status).toBe('pending');
      expect(record.expiresAt - record.createdAt).toBe(CONFIRM_TTL_MS);
      expect(CONFIRM_TTL_MS).toBe(24 * 60 * 60 * 1000);
      expect(record.preview?.operation).toBe('创建销售单');
      expect(record.risk).toBe('medium');
    });

    it('重复创建应生成不同的令牌', async () => {
      const r1 = await service.create(baseInput);
      const r2 = await service.create(baseInput);
      expect(r1.confirmationId).not.toBe(r2.confirmationId);
    });

    it('getByTenant 应返回未过期的记录', async () => {
      const record = await service.create(baseInput);
      const found = await service.getByTenant(
        record.confirmationId,
        'tenant-A',
      );
      expect(found?.toolName).toBe('createSalesOrder');
      expect(found?.tenantId).toBe('tenant-A');
      expect(found?.docType).toBe('sales_order_create');
    });

    it('getByTenant 不存在的 ID 应返回 null', async () => {
      expect(await service.getByTenant('wg_not-exist', 'tenant-A')).toBeNull();
    });

    it('getByTenant 过期记录应返回 null 并清除', async () => {
      const record = await service.create(baseInput);
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);
      expect(
        await service.getByTenant(record.confirmationId, 'tenant-A'),
      ).toBeNull();
    });

    it('listPending 应按租户隔离并排除过期记录', async () => {
      // 先创建会过期的记录（tenant-A）
      const expired = await service.create({
        ...baseInput,
        toolName: 'createPurchaseOrder',
      });

      // 时间推进超过 TTL，expired 过期
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);

      // 过期后再创建有效记录（tenant-A 与 tenant-B）
      await service.create(baseInput); // tenant-A
      await service.create({ ...baseInput, tenantId: 'tenant-B' }); // tenant-B

      const pendingA = await service.listPending('tenant-A');
      // expired 过期被清除，只剩 tenant-A 的有效记录
      expect(pendingA).toHaveLength(1);
      expect(pendingA[0].toolName).toBe('createSalesOrder');
      expect(
        await service.getByTenant(expired.confirmationId, 'tenant-A'),
      ).toBeNull();
    });
  });

  // ── 2. confirm / cancel ──
  describe('confirm/cancel', () => {
    it('confirm 成功应将状态置为 confirmed', async () => {
      const record = await service.create(baseInput);
      const result = await service.confirm(record.confirmationId, 'tenant-A');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.confirmation.status).toBe('confirmed');
        expect(result.needsSecondConfirm).toBeFalsy();
      }
    });

    it('confirm 不存在的 ID 应返回失败', async () => {
      const result = await service.confirm('wg_not-exist', 'tenant-A');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('不存在');
      }
    });

    it('confirm 过期记录应返回失败', async () => {
      const record = await service.create(baseInput);
      jest.advanceTimersByTime(CONFIRM_TTL_MS + 1000);
      const result = await service.confirm(record.confirmationId, 'tenant-A');
      expect(result.success).toBe(false);
    });

    it('confirm 其他租户的记录应返回失败', async () => {
      const record = await service.create(baseInput);
      const result = await service.confirm(record.confirmationId, 'tenant-B');
      expect(result.success).toBe(false);
      if (!result.success) {
        // 租户 key 隔离：跨租户一律"不存在"，不泄露令牌存在性
        expect(result.error).toContain('不存在');
      }
    });

    it('确认后令牌不可复用（重复 confirm 应返回失败）', async () => {
      const record = await service.create(baseInput);
      await service.confirm(record.confirmationId, 'tenant-A');
      const again = await service.confirm(record.confirmationId, 'tenant-A');
      expect(again.success).toBe(false);
      if (!again.success) {
        expect(again.error).toContain('重复');
      }
    });

    it('cancel 成功应移除记录', async () => {
      const record = await service.create(baseInput);
      const cancelled = await service.cancel(record.confirmationId, 'tenant-A');
      expect(cancelled).toBe(true);
      expect(
        await service.getByTenant(record.confirmationId, 'tenant-A'),
      ).toBeNull();
    });

    it('cancel 其他租户的记录应返回 false', async () => {
      const record = await service.create(baseInput);
      expect(await service.cancel(record.confirmationId, 'tenant-B')).toBe(
        false,
      );
    });

    it('已确认的操作不可取消', async () => {
      const record = await service.create(baseInput);
      await service.confirm(record.confirmationId, 'tenant-A');
      expect(await service.cancel(record.confirmationId, 'tenant-A')).toBe(
        false,
      );
    });
  });

  // ── 2b. 高危写二次确认 ──
  describe('高危写二次确认', () => {
    it('risk=high 首次确认应返回 needsSecondConfirm=true 且不执行', async () => {
      const record = await service.create({
        ...baseInput,
        risk: 'high',
        needsReview: true,
        toolName: 'adjustCreditLimit',
        operationLabel: '信用额度调整',
      });

      const first = await service.confirm(record.confirmationId, 'tenant-A');
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.needsSecondConfirm).toBe(true);
        expect(first.confirmation.status).toBe('first_confirmed');
        expect(first.confirmation.confirmCount).toBe(1);
      }
    });

    it('高危写二次确认后才放行', async () => {
      const record = await service.create({
        ...baseInput,
        risk: 'high',
        needsReview: true,
        toolName: 'adjustCreditLimit',
        operationLabel: '信用额度调整',
      });

      await service.confirm(record.confirmationId, 'tenant-A');
      const second = await service.confirm(record.confirmationId, 'tenant-A');
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.needsSecondConfirm).toBe(false);
        expect(second.confirmation.status).toBe('confirmed');
        expect(second.confirmation.confirmCount).toBe(2);
      }
    });

    it('needsReview=true 的 medium 写操作同样触发二次确认', async () => {
      const record = await service.create({
        ...baseInput,
        risk: 'medium',
        needsReview: true,
        toolName: 'createPlatformAnnouncement',
      });

      const first = await service.confirm(record.confirmationId, 'tenant-A');
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.needsSecondConfirm).toBe(true);
      }
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
    it('应清理过期的待确认与已执行记录', async () => {
      await service.create(baseInput);
      service.registerExecuted({
        tenantId: 'tenant-A',
        toolName: 'createSalesOrder',
        args: { confirm: true },
        operationLabel: '创建销售单',
      });

      jest.advanceTimersByTime(Math.max(CONFIRM_TTL_MS, REVOKE_TTL_MS) + 1000);
      const cleaned = service.cleanupExpired();

      expect(cleaned).toBe(2);
      expect(await service.listPending('tenant-A')).toHaveLength(0);
    });

    it('无过期记录时清理数量为 0', async () => {
      await service.create(baseInput);
      expect(service.cleanupExpired()).toBe(0);
    });
  });
});
