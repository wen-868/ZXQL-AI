/**
 * api_* 目录生成工具结果总结单元测试
 *
 * 覆盖 buildApiToolSummary：
 * - 列表类（records/list/rows/items）→ 条数 + 首条名称
 * - 空列表 → 未查询到相关记录
 * - 聚合字段（total/count/totalCount）
 * - 统计对象类（金额/数量）
 * - 兜底输出
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { buildApiToolSummary } from './api-summary';

describe('buildApiToolSummary（api_* 通用总结）', () => {
  it('records 列表返回条数与首条名称', () => {
    const text = buildApiToolSummary('api_query_coupon_templates', {
      total: 3,
      records: [{ templateName: '满100减10', status: 'ACTIVE' }],
    });
    expect(text).toContain('已查询到 1 条记录');
    expect(text).toContain('满100减10');
  });

  it('list 列表兼容并取 skuName', () => {
    const text = buildApiToolSummary('api_query_flash_sales', {
      list: [{ skuName: '五粮液52度' }],
    });
    expect(text).toBe('已查询到 1 条记录，如「五粮液52度」。');
  });

  it('空列表返回未查询到', () => {
    expect(
      buildApiToolSummary('api_query_expenses', { list: [], total: 0 }),
    ).toBe('未查询到相关记录。');
  });

  it('聚合 total 返回共 N 条', () => {
    expect(
      buildApiToolSummary('api_query_customer_visits', { total: 42 }),
    ).toBe('查询完成，共 42 条。');
  });

  it('统计对象返回可读指标', () => {
    const text = buildApiToolSummary('api_get_business_overview', {
      totalSales: '128000.00',
      orderCount: 320,
    });
    expect(text).toContain('总销售额 128000.00');
    expect(text).toContain('订单数 320');
  });

  it('无结构数据兜底输出', () => {
    expect(buildApiToolSummary('api_query_credit_list', undefined)).toBe(
      '「api_query_credit_list」查询完成。',
    );
  });
});
