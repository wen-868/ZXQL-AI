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
  let pushGateway: { broadcast: jest.Mock; sendToUser: jest.Mock };

  const push: ProactivePush = {
    title: '⚠️ 库存预警',
    type: 'inventory',
    priority: 'urgent',
    content: '五粮液库存不足',
  };

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue(undefined) };
    auditLogger = { logAiCall: jest.fn() };
    pushGateway = { broadcast: jest.fn(), sendToUser: jest.fn() };
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
        // 阶段0 B-1：INSERT 首参为租户（迁移 012 加列后写入归属）
        // R101-AI-45：首参前新增 user_id（定向推送落真实用户；缺省 0=系统触发，历史行为）
        [0, 'tenant-1', 'inventory', '⚠️ 库存预警', '五粮液库存不足'],
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

  // ── R101-AI-45：定向推送（targetUserId） ──
  describe('定向推送（targetUserId）', () => {
    const targeted = {
      ...push,
      title: '📅 日程提醒',
      content: '与供应商洽谈价格，30 分钟后开始',
      targetUserId: 42,
    };

    it('① 带 targetUserId ⇒ t_push_log 落真实 user_id + 走 sendToUser 而非 broadcast', async () => {
      const result = await service.push(
        'tenant-1',
        'schedule_reminder',
        targeted,
      );

      expect(result).toBe(true);
      // user_id 落真实用户（不再硬编码 0）⇒ "这是给谁的"在流水里可追溯
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO t_push_log'),
        [
          42,
          'tenant-1',
          'inventory',
          '📅 日程提醒',
          '与供应商洽谈价格，30 分钟后开始',
        ],
      );
      // 🔴 定向 ⇒ 只投该用户，绝不回落广播（避免私人提醒被同租户他人看到）
      expect(pushGateway.sendToUser).toHaveBeenCalledWith(
        'tenant-1',
        42,
        expect.objectContaining({ title: '📅 日程提醒', type: 'inventory' }),
      );
      expect(pushGateway.broadcast).not.toHaveBeenCalled();
    });

    it('② 不带 targetUserId ⇒ user_id=0 + 维持租户级广播（向后兼容）', async () => {
      await service.push('tenant-1', 'inventory_warning', push);

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO t_push_log'),
        [0, 'tenant-1', 'inventory', '⚠️ 库存预警', '五粮液库存不足'],
      );
      expect(pushGateway.broadcast).toHaveBeenCalledTimes(1);
      expect(pushGateway.sendToUser).not.toHaveBeenCalled();
    });

    it('③ sendToUser 失败（用户不在线等）不影响落库结果', async () => {
      pushGateway.sendToUser.mockImplementationOnce(() => {
        throw new Error('连接已关闭');
      });

      const result = await service.push(
        'tenant-1',
        'schedule_reminder',
        targeted,
      );

      expect(result).toBe(true);
      expect(dataSource.query).toHaveBeenCalled();
    });
  });
});
