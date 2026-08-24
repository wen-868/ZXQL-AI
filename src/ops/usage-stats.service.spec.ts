/**
 * UsageStatsService 单元测试
 *
 * 覆盖：租户明细查询与字段映射、区间汇总 SUM、跨租户概览、日期过滤参数
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import type { DataSource } from 'typeorm';
import { UsageStatsService } from './usage-stats.service';

describe('UsageStatsService', () => {
  let service: UsageStatsService;
  let dataSource: { query: jest.Mock };

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    service = new UsageStatsService(dataSource as unknown as DataSource);
  });

  it('getDailyUsage 查询租户明细并映射字段', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        tenant_id: 't1',
        stat_date: '2026-08-15',
        chat_count: 3,
        tool_call_count: 5,
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        total_cost: '0.0120',
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    ]);

    const list = await service.getDailyUsage('t1', '2026-08-01', '2026-08-15');

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'WHERE tenant_id = ? AND stat_date >= ? AND stat_date <= ?',
      ),
      ['t1', '2026-08-01', '2026-08-15'],
    );
    expect(list).toEqual([
      {
        tenantId: 't1',
        statDate: '2026-08-15',
        chatCount: 3,
        toolCallCount: 5,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        totalCost: 0.012,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    ]);
  });

  it('getTenantTotals 返回 SUM 汇总（空数据返回全 0）', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        days: 2,
        chat_count: 10,
        tool_call_count: 4,
        total_tokens: 500,
        total_cost: '0.0500',
      },
    ]);

    const totals = await service.getTenantTotals('t1');

    expect(totals).toEqual({
      tenantId: 't1',
      days: 2,
      chatCount: 10,
      toolCallCount: 4,
      totalTokens: 500,
      totalCost: 0.05,
    });
  });

  it('getTenantTotals 空结果回退 0', async () => {
    dataSource.query.mockResolvedValueOnce([]);
    const totals = await service.getTenantTotals('t1');
    expect(totals.totalCost).toBe(0);
    expect(totals.days).toBe(0);
  });

  it('listTenantUsage 跨租户概览按费用倒序', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        tenant_id: 't2',
        days: 1,
        chat_count: 1,
        tool_call_count: 0,
        total_tokens: 10,
        total_cost: '0.0200',
      },
      {
        tenant_id: 't1',
        days: 3,
        chat_count: 5,
        tool_call_count: 2,
        total_tokens: 30,
        total_cost: '0.0100',
      },
    ]);

    const list = await service.listTenantUsage('2026-08-01', '2026-08-15');

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE stat_date >= ? AND stat_date <= ?'),
      ['2026-08-01', '2026-08-15'],
    );
    expect(list).toHaveLength(2);
    expect(list[0].tenantId).toBe('t2');
    expect(list[1].tenantId).toBe('t1');
  });
});
