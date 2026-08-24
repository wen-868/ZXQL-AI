/**
 * HealthMonitorService 单元测试
 *
 * 覆盖：健康时不推送、依赖异常推送告警、状态翻转去重、监控关闭跳过
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import type { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HealthMonitorService } from './health-monitor.service';
import { ServiceClient } from '../bridge/service-client';
import { ProactivePushService } from '../brain/proactive/proactive-push.service';

/** 构造服务（监控开关可配置） */
function makeService(enabled = 'true'): {
  service: HealthMonitorService;
  dataSource: { query: jest.Mock };
  client: { healthCheck: jest.Mock };
  push: { push: jest.Mock };
} {
  const config = {
    get: jest.fn((key: string) =>
      key === 'HEALTH_MONITOR_ENABLED' ? enabled : undefined,
    ),
  };
  const dataSource = { query: jest.fn().mockResolvedValue(undefined) };
  const client = {
    healthCheck: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 3 }),
  };
  const push = { push: jest.fn().mockResolvedValue(true) };
  const service = new HealthMonitorService(
    dataSource as unknown as DataSource,
    client as unknown as ServiceClient,
    push as unknown as ProactivePushService,
    config as unknown as ConfigService,
  );
  return { service, dataSource, client, push };
}

describe('HealthMonitorService', () => {
  it('依赖健康时不推送告警', async () => {
    const { service, push } = makeService();
    const result = await service.checkAndAlert();
    expect(result.healthy).toBe(true);
    expect(result.failures).toEqual([]);
    expect(push.push).not.toHaveBeenCalled();
  });

  it('数据库异常时推送紧急告警（default 租户）', async () => {
    const { service, dataSource, push } = makeService();
    dataSource.query.mockRejectedValueOnce(new Error('连接超时'));

    const result = await service.checkAndAlert();

    expect(result.healthy).toBe(false);
    expect(result.failures[0]).toContain('数据库不可达');
    expect(push.push).toHaveBeenCalledWith(
      'default',
      'health_monitor',
      expect.objectContaining({
        title: expect.stringContaining('健康异常') as string,
        priority: 'urgent',
        content: expect.stringContaining('数据库不可达') as string,
      }),
    );
  });

  it('状态翻转去重：持续异常只推送一次', async () => {
    const { service, dataSource, push } = makeService();
    dataSource.query.mockRejectedValue(new Error('连接超时'));

    const first = await service.checkAndAlert();
    const second = await service.checkAndAlert();

    expect(first.alerted).toBe(true);
    expect(second.alerted).toBe(false);
    expect(push.push).toHaveBeenCalledTimes(1);
  });

  it('健康恢复后再次故障可重新告警', async () => {
    const { service, dataSource, push } = makeService();

    dataSource.query.mockRejectedValueOnce(new Error('连接超时'));
    await service.checkAndAlert(); // 故障 → 告警
    await service.checkAndAlert(); // 仍故障 → 去重
    dataSource.query.mockResolvedValue(undefined); // 恢复
    await service.checkAndAlert();
    dataSource.query.mockRejectedValueOnce(new Error('再次故障'));
    await service.checkAndAlert(); // 再次故障 → 重新告警

    expect(push.push).toHaveBeenCalledTimes(2);
  });

  it('监控关闭时跳过自检', async () => {
    const { service, dataSource, push } = makeService('false');
    const result = await service.checkAndAlert();
    expect(result.healthy).toBe(true);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(push.push).not.toHaveBeenCalled();
  });
});
