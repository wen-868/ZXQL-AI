/**
 * UsageAlertService 单元测试
 *
 * 覆盖：未配置阈值跳过、费用超阈值触发推送、同日去重、Token 阈值、无超限不推送
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import type { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { UsageAlertService } from './usage-alert.service';
import { ProactivePushService } from '../brain/proactive/proactive-push.service';

/** 构造服务（阈值可配置） */
function makeService(
  cost?: string,
  tokens?: string,
): {
  service: UsageAlertService;
  dataSource: { query: jest.Mock };
  push: { push: jest.Mock };
} {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'USAGE_DAILY_ALERT_COST') return cost ?? '';
      if (key === 'USAGE_DAILY_ALERT_TOKENS') return tokens ?? '';
      return undefined;
    }),
  };
  const dataSource = { query: jest.fn().mockResolvedValue([]) };
  const push = { push: jest.fn().mockResolvedValue(true) };
  const service = new UsageAlertService(
    dataSource as unknown as DataSource,
    push as unknown as ProactivePushService,
    config as unknown as ConfigService,
  );
  return { service, dataSource, push };
}

describe('UsageAlertService', () => {
  it('未配置阈值时跳过检查', async () => {
    const { service, dataSource, push } = makeService('', '');
    const count = await service.checkAndAlert();
    expect(count).toBe(0);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(push.push).not.toHaveBeenCalled();
  });

  it('当日费用超阈值触发推送（含明细）', async () => {
    const { service, dataSource, push } = makeService('1', '');
    const today = new Date().toISOString().slice(0, 10);
    dataSource.query.mockResolvedValueOnce([
      {
        tenant_id: 't1',
        chat_count: 3,
        tool_call_count: 5,
        total_tokens: 800,
        total_cost: '1.5000',
      },
    ]);

    const count = await service.checkAndAlert();

    expect(count).toBe(1);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE stat_date = ?'),
      [today],
    );
    expect(push.push).toHaveBeenCalledWith(
      't1',
      'usage_alert',
      expect.objectContaining({
        title: expect.stringContaining('AI 用量超阈值') as string,
        type: 'system',
        priority: 'important',
        content: expect.stringContaining('费用 ¥1.50 超阈值 ¥1.00') as string,
      }),
    );
  });

  it('同日同租户去重（第二次检查不再推送）', async () => {
    const { service, dataSource, push } = makeService('1', '');
    dataSource.query.mockResolvedValue([
      {
        tenant_id: 't1',
        chat_count: 1,
        tool_call_count: 0,
        total_tokens: 100,
        total_cost: '2.0000',
      },
    ]);

    await service.checkAndAlert();
    const second = await service.checkAndAlert();

    expect(second).toBe(0);
    expect(push.push).toHaveBeenCalledTimes(1);
  });

  it('Token 阈值触发推送（费用未超限时）', async () => {
    const { service, dataSource, push } = makeService('', '1000');
    dataSource.query.mockResolvedValueOnce([
      {
        tenant_id: 't1',
        chat_count: 1,
        tool_call_count: 0,
        total_tokens: 1500,
        total_cost: '0.1000',
      },
    ]);

    const count = await service.checkAndAlert();

    expect(count).toBe(1);
    expect(push.push).toHaveBeenCalledWith(
      't1',
      'usage_alert',
      expect.objectContaining({
        content: expect.stringContaining('Token 1500 超阈值 1000') as string,
      }),
    );
  });

  it('无超限租户不推送', async () => {
    const { service, dataSource, push } = makeService('10', '');
    dataSource.query.mockResolvedValueOnce([
      {
        tenant_id: 't1',
        chat_count: 1,
        tool_call_count: 0,
        total_tokens: 100,
        total_cost: '0.5000',
      },
    ]);

    const count = await service.checkAndAlert();
    expect(count).toBe(0);
    expect(push.push).not.toHaveBeenCalled();
  });
});
