/**
 * 写操作工具结果通用总结单元测试
 *
 * 覆盖 buildWriteSummary：
 * - 各写操作工具成功结论（名称/单号/数量/ID 提取）
 * - 无匹配规则返回 null（走目录通用总结）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { buildWriteSummary } from './write-summary';

describe('buildWriteSummary（写操作成功总结）', () => {
  it('创建优惠券模板输出名称', () => {
    expect(
      buildWriteSummary('api_create_coupon_template', {
        id: 1,
        name: '满100减10',
      }),
    ).toBe('已创建优惠券模板「满100减10」（ID 1）');
  });

  it('创建采购计划输出单号与商品数', () => {
    expect(
      buildWriteSummary('api_create_purchase_plan', {
        planNo: 'JH202608160001',
        itemsCount: 3,
      }),
    ).toBe('已创建采购计划 JH202608160001（3 种商品）');
  });

  it('采购付款单输出单号并标注待审批', () => {
    expect(
      buildWriteSummary('api_create_purchase_payment', {
        payment_no: 'FK202608160001',
      }),
    ).toBe('已创建采购付款单 FK202608160001（待审批）');
  });

  it('调整授信额度输出客户与额度', () => {
    expect(
      buildWriteSummary('api_adjust_credit_limit', {
        customerId: 88,
        creditLimit: 50000,
      }),
    ).toBe('已调整客户 #88 授信额度为 50000 元');
  });

  it('创建平台公告输出标题', () => {
    expect(
      buildWriteSummary('api_platform_create_announcement', {
        title: '系统维护通知',
      }),
    ).toBe('已发布平台公告「系统维护通知」');
  });

  it('有规则但 data 无关键字段时输出动作成功兜底', () => {
    expect(buildWriteSummary('api_create_flash_sale', {})).toBe(
      '创建秒杀活动成功。',
    );
  });

  it('无匹配规则（目录查询工具）返回 null', () => {
    expect(
      buildWriteSummary('api_query_coupon_templates', { total: 3 }),
    ).toBeNull();
  });

  it('精调非 api_ 前缀工具不匹配规则', () => {
    expect(
      buildWriteSummary('createSalesOrder', { billNo: 'XS001' }),
    ).toBeNull();
  });
});
