/**
 * ProactivePushService 单元测试
 *
 * 覆盖：t_push_log 落库成功 / 落库失败不审计 / 审计留痕调用 / WebSocket 实时广播
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { AuditLogger } from '../../bridge/audit-logger';
import { PushGatewayService } from '../../gateway/push-gateway.service';
import { ProactivePushService } from './proactive-push.service';
import { ProactivePush } from './proactive.types';

describe('ProactivePushService', () => {
  let service: ProactivePushService;
  let dataSource: { query: jest.Mock };
  let auditLogger: { logAiCall: jest.Mock };
  let pushGateway: { broadcast: jest.Mock };

  const push: ProactivePush = {
    title: '⚠️ 库存预警',
    type: 'inventory',
    priority: 'urgent',
    content: '五粮液库存不足',
  };

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue(undefined) };
    auditLogger = { logAiCall: jest.fn() };
    pushGateway = { broadcast: jest.fn() };
    service = new ProactivePushService(
      dataSource as unknown as DataSource,
      auditLogger as unknown as AuditLogger,
      pushGateway as unknown as PushGatewayService,
    );
  });

  describe('push', () => {
    it('成功写入 t_push_log 并记录审计', async () => {
      const result = await service.push('tenant-1', 'inventory_warning', push);

      expect(result).toBe(true);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO t_push_log'),
        ['inventory', '⚠️ 库存预警', '五粮液库存不足'],
      );
      expect(auditLogger.logAiCall).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          intent: 'proactive_inventory_warning',
          success: true,
          promptTokens: 0,
          completionTokens: 0,
        }),
      );
      expect(pushGateway.broadcast).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          title: '⚠️ 库存预警',
          content: '五粮液库存不足',
          type: 'inventory',
          priority: 'urgent',
          pushedAt: expect.any(String) as string,
        }),
      );
    });

    it('WebSocket 广播失败不影响落库结果', async () => {
      pushGateway.broadcast.mockImplementationOnce(() => {
        throw new Error('连接已关闭');
      });

      const result = await service.push('tenant-1', 'inventory_warning', push);

      expect(result).toBe(true);
      expect(dataSource.query).toHaveBeenCalled();
    });

    it('超长内容在审计中截断为 500 字符', async () => {
      const longContent = 'x'.repeat(800);
      await service.push('tenant-1', 'task_a', {
        ...push,
        content: longContent,
      });

      const call = auditLogger.logAiCall.mock.calls[0] as [
        { toolCalls: Array<{ content: string }> },
      ];
      expect(call[0].toolCalls[0].content).toHaveLength(500);
    });

    it('t_push_log 写入失败时返回 false 且不记录审计', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('表不存在'));

      const result = await service.push('tenant-1', 'inventory_warning', push);

      expect(result).toBe(false);
      expect(auditLogger.logAiCall).not.toHaveBeenCalled();
    });

    it('t_push_log 写入抛非 Error 异常时返回 false（String 兜底）', async () => {
      dataSource.query.mockRejectedValueOnce('数据库连接丢失');

      const result = await service.push('tenant-1', 'inventory_warning', push);

      expect(result).toBe(false);
      expect(auditLogger.logAiCall).not.toHaveBeenCalled();
    });
  });
});
