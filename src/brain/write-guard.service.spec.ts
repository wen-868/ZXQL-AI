/**
 * P0-1 WriteGuardService 单元测试
 *
 * 覆盖：
 * 1. suspend/get/listPending — 令牌生成 + 24h TTL + 租户隔离
 * 2. confirm — 非高危一次放行 / 高危二次确认 / 复用拒绝
 * 3. cancel — 取消 + 已确认不可取消
 * 4. cleanupExpired + maskToken 脱敏
 *
 * 存储：测试环境无 Redis（不调用 onModuleInit），自动走内存降级模式。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { ConfigService } from '@nestjs/config';
import {
  WriteGuardService,
  WRITE_TOKEN_TTL_MS,
  maskToken,
} from './write-guard.service';

function createService(): WriteGuardService {
  return new WriteGuardService({
    get: () => undefined,
  } as unknown as ConfigService);
}

describe('P0-1 WriteGuardService', () => {
  let service: WriteGuardService;

  beforeEach(() => {
    service = createService();
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

  describe('suspend/get/listPending', () => {
    it('挂起应生成 wg_ 令牌，TTL 24 小时，状态 pending', async () => {
      const write = await service.suspend(baseInput);

      expect(write.token).toMatch(/^wg_/);
      expect(write.status).toBe('pending');
      expect(write.confirmCount).toBe(0);
      expect(write.expiresAt - write.createdAt).toBe(WRITE_TOKEN_TTL_MS);
      expect(WRITE_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
      expect(write.docType).toBe('sales_order_create');
    });

    it('get 应返回未过期记录并校验租户隔离', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.get(write.token, 'tenant-A')).not.toBeNull();
      expect(await service.get(write.token, 'tenant-B')).toBeNull();
    });

    it('get 不存在的令牌返回 null', async () => {
      expect(await service.get('wg_not-exist', 'tenant-A')).toBeNull();
    });

    it('过期令牌返回 null 并清除', async () => {
      const write = await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      expect(await service.get(write.token, 'tenant-A')).toBeNull();
      expect(await service.listPending('tenant-A')).toHaveLength(0);
    });

    it('listPending 按租户隔离且按创建时间倒序', async () => {
      await service.suspend(baseInput);
      await service.suspend({ ...baseInput, tenantId: 'tenant-B' });
      // 推进时钟确保 later 的 createdAt 更晚（同毫秒排序不稳定）
      jest.advanceTimersByTime(10);
      const later = await service.suspend(baseInput);

      const pendingA = await service.listPending('tenant-A');
      expect(pendingA).toHaveLength(2);
      expect(pendingA[0].token).toBe(later.token);
    });
  });

  describe('confirm', () => {
    it('非高危写操作一次确认即放行', async () => {
      const write = await service.suspend(baseInput);
      const result = await service.confirm(write.token, 'tenant-A');

      expect(result.success).toBe(true);
      expect(result.needsSecondConfirm).toBe(false);
      expect(result.pendingWrite?.status).toBe('confirmed');
      expect(result.pendingWrite?.confirmCount).toBe(1);
    });

    it('高危写操作首次确认进入 first_confirmed，二次确认才放行', async () => {
      const write = await service.suspend({
        ...baseInput,
        toolName: 'adjustCreditLimit',
        docType: 'credit_limit_adjust',
        risk: 'high',
        needsReview: true,
        operationLabel: '信用额度调整',
      });

      const first = await service.confirm(write.token, 'tenant-A');
      expect(first.success).toBe(true);
      expect(first.needsSecondConfirm).toBe(true);
      expect(first.pendingWrite?.status).toBe('first_confirmed');
      expect(first.pendingWrite?.confirmCount).toBe(1);

      const second = await service.confirm(write.token, 'tenant-A');
      expect(second.success).toBe(true);
      expect(second.needsSecondConfirm).toBe(false);
      expect(second.pendingWrite?.status).toBe('confirmed');
      expect(second.pendingWrite?.confirmCount).toBe(2);
    });

    it('needsReview=true 即使 medium 风险也触发二次确认', async () => {
      const write = await service.suspend({
        ...baseInput,
        toolName: 'createPlatformAnnouncement',
        risk: 'medium',
        needsReview: true,
      });
      const first = await service.confirm(write.token, 'tenant-A');
      expect(first.needsSecondConfirm).toBe(true);
    });

    it('确认后令牌不可复用', async () => {
      const write = await service.suspend(baseInput);
      await service.confirm(write.token, 'tenant-A');
      const again = await service.confirm(write.token, 'tenant-A');
      expect(again.success).toBe(false);
      expect(again.error).toContain('重复');
    });

    it('已取消的令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      await service.cancel(write.token, 'tenant-A');
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(false);
      // 取消后令牌即删除，按"不存在"处理（不留可复用凭证）
      expect(result.error).toContain('不存在');
    });

    it('过期令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('其他租户令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      const result = await service.confirm(write.token, 'tenant-B');
      expect(result.success).toBe(false);
      // 租户 key 隔离：跨租户一律"不存在"，不泄露令牌存在性
      expect(result.error).toContain('不存在');
    });
  });

  describe('cancel', () => {
    it('pending 可取消并移除', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.cancel(write.token, 'tenant-A')).toBe(true);
      expect(await service.get(write.token, 'tenant-A')).toBeNull();
    });

    it('first_confirmed 可取消', async () => {
      const write = await service.suspend({
        ...baseInput,
        risk: 'high',
        needsReview: true,
      });
      await service.confirm(write.token, 'tenant-A');
      expect(await service.cancel(write.token, 'tenant-A')).toBe(true);
    });

    it('已确认不可取消', async () => {
      const write = await service.suspend(baseInput);
      await service.confirm(write.token, 'tenant-A');
      expect(await service.cancel(write.token, 'tenant-A')).toBe(false);
    });

    it('其他租户不可取消', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.cancel(write.token, 'tenant-B')).toBe(false);
    });
  });

  describe('cleanupExpired / maskToken', () => {
    it('cleanupExpired 清理内存模式过期令牌', async () => {
      await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      expect(service.cleanupExpired()).toBe(1);
      expect(await service.listPending('tenant-A')).toHaveLength(0);
    });

    it('maskToken 应脱敏令牌（保留首尾）', () => {
      const masked = maskToken('wg_12345678-1234-1234-1234-123456789abc');
      expect(masked).toContain('…');
      expect(masked.startsWith('wg_12345')).toBe(true);
      expect(masked.endsWith('9abc')).toBe(true);
      expect(masked).not.toContain('1234-1234-1234-1234');
    });
  });
});
