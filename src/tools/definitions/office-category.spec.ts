/**
 * AI-P2-1 ToolCategory office 归类 — 分类覆盖与工具注册完整性测试
 *
 * 硬验收对应：
 * 1. ToolCategory 新增 'office'（类型面：本 spec 编译通过即覆盖字面量合法性）
 * 2. 每个办公工具只保留一个 category（23 直属字面量 + 2 base 单点继承，无双分类）
 * 4. 非办公工具分类不变（5 个真报表工具仍为 'report'）
 * 5. 注册完整性：28 office + 5 report = 33 工具位守恒，registry 分类路由逐一命中
 *
 * 批量实例化仅读取 name/category 两个声明字段，构造依赖以 null 占位
 * （与生产 DI 无关），故文件级豁免 no-unsafe 系列。
 *
 * 负责人: 阿洲 | 创建日期: 2026-10-30
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- 批量实例化 28 个工具类做分类断言，构造依赖以 null 占位与被测属性无关 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ToolRegistry } from '../tool-registry';
import { AiDocCreateTool } from './ai-doc-create.tool';
import { AiDocListTool } from './ai-doc-list.tool';
import { AiDocUpdateTool } from './ai-doc-update.tool';
import { AiDocGetTool } from './ai-doc-get.tool';
import { AiDocArchiveTool } from './ai-doc-archive.tool';
import { AiDocSearchTool } from './ai-doc-search.tool';
import { AiDocAskTool } from './ai-doc-ask.tool';
import { AiTodoCreateTool } from './ai-todo-create.tool';
import { AiTodoUpdateTool } from './ai-todo-update.tool';
import { AiTodoListTool } from './ai-todo-list.tool';
import { AiTodoCancelTool } from './ai-todo-cancel.tool';
import { AiTodoCompleteTool } from './ai-todo-complete.tool';
import { AiApprovalCreateTool } from './ai-approval-create.tool';
import { AiApprovalUpdateTool } from './ai-approval-update.tool';
import { AiApprovalListTool } from './ai-approval-list.tool';
import { AiApprovalDraftDiscardTool } from './ai-approval-draft-discard.tool';
import { AiApprovalApproveTool } from './ai-approval-approve.tool';
import { AiApprovalRejectTool } from './ai-approval-reject.tool';
import { AiApprovalCancelTool } from './ai-approval-cancel.tool';
import { AiScheduleCreateTool } from './ai-schedule-create.tool';
import { AiScheduleListTool } from './ai-schedule-list.tool';
import { AiScheduleUpdateTool } from './ai-schedule-update.tool';
import { AiScheduleCompleteTool } from './ai-schedule-complete.tool';
import { AiScheduleCancelTool } from './ai-schedule-cancel.tool';
import { AiNoticeListTool } from './ai-notice-list.tool';
import { AiNoticeMarkReadTool } from './ai-notice-mark-read.tool';
import { AiNoticeUnreadCountTool } from './ai-notice-unread-count.tool';
import { AiNoticeArchiveTool } from './ai-notice-archive.tool';
import { InventoryReportTool } from './inventory-report.tool';
import { SalesReportTool } from './sales-report.tool';
import { ProfitReportTool } from './profit-report.tool';
import { ForecastSalesTool } from './forecast-sales.tool';
import { AnalyzePriceTrendTool } from './analyze-price-trend.tool';

/** 占位构造：仅读取 name/category 两个声明字段，构造依赖与被测属性无关 */
const make = (Ctor: any): any =>
  new Ctor(...Array.from({ length: 9 }, () => null));

// ── office 硬名单（28：23 直属字面量 + 5 经 base 继承）─────────────
const OFFICE_TOOLS: Array<[string, any]> = [
  ['aiDocCreate', AiDocCreateTool],
  ['aiDocList', AiDocListTool],
  ['aiDocUpdate', AiDocUpdateTool],
  ['aiDocGet', AiDocGetTool],
  ['aiDocArchive', AiDocArchiveTool],
  ['aiDocSearch', AiDocSearchTool],
  ['aiDocAsk', AiDocAskTool],
  ['aiTodoCreate', AiTodoCreateTool],
  ['aiTodoUpdate', AiTodoUpdateTool],
  ['aiTodoList', AiTodoListTool],
  ['aiTodoCancel', AiTodoCancelTool],
  ['aiTodoComplete', AiTodoCompleteTool],
  ['aiApprovalCreate', AiApprovalCreateTool],
  ['aiApprovalUpdate', AiApprovalUpdateTool],
  ['aiApprovalList', AiApprovalListTool],
  ['aiApprovalDraftDiscard', AiApprovalDraftDiscardTool],
  ['aiApprovalApprove', AiApprovalApproveTool],
  ['aiApprovalReject', AiApprovalRejectTool],
  ['aiApprovalCancel', AiApprovalCancelTool],
  ['aiScheduleCreate', AiScheduleCreateTool],
  ['aiScheduleList', AiScheduleListTool],
  ['aiScheduleUpdate', AiScheduleUpdateTool],
  ['aiScheduleComplete', AiScheduleCompleteTool],
  ['aiScheduleCancel', AiScheduleCancelTool],
  ['aiNoticeList', AiNoticeListTool],
  ['aiNoticeMarkRead', AiNoticeMarkReadTool],
  ['aiNoticeUnreadCount', AiNoticeUnreadCountTool],
  ['aiNoticeArchive', AiNoticeArchiveTool],
].map(([name, Ctor]) => [name as string, make(Ctor)]);

// ── report 保留名单（5 个真报表工具）─────────────────────────────
const REPORT_TOOLS: Array<[string, any]> = [
  ['inventoryReport', InventoryReportTool],
  ['salesReport', SalesReportTool],
  ['profitReport', ProfitReportTool],
  ['forecastSales', ForecastSalesTool],
  ['analyzePriceTrend', AnalyzePriceTrendTool],
].map(([name, Ctor]) => [name as string, make(Ctor)]);

const OFFICE_NAMES = OFFICE_TOOLS.map(([name]) => name).sort();
const REPORT_NAMES = REPORT_TOOLS.map(([name]) => name).sort();

describe('AI-P2-1 ToolCategory office 归类', () => {
  it('分类覆盖：28 个办公工具 category 均为 office 且逐一命中硬名单', () => {
    for (const [expectedName, tool] of OFFICE_TOOLS) {
      expect(tool.name).toBe(expectedName);
      expect(tool.category).toBe('office');
    }
  });

  it('单分类：office 与 report 名单零交集，工具名全局唯一', () => {
    const officeSet = new Set(OFFICE_NAMES);
    for (const name of REPORT_NAMES) {
      expect(officeSet.has(name)).toBe(false);
    }
    expect(new Set(OFFICE_NAMES).size).toBe(28);
    expect(new Set(REPORT_NAMES).size).toBe(5);
  });

  it('非办公工具分类不变：5 个真报表工具仍为 report', () => {
    for (const [expectedName, tool] of REPORT_TOOLS) {
      expect(tool.name).toBe(expectedName);
      expect(tool.category).toBe('report');
    }
  });

  it('注册完整性：registry 分类路由 28 office + 5 report，总数守恒', () => {
    const registry = new ToolRegistry();
    const seen = new Set<string>();
    for (const [, tool] of [...OFFICE_TOOLS, ...REPORT_TOOLS]) {
      const before = registry.size();
      registry.register(tool);
      expect(registry.size()).toBe(before + 1); // 名称唯一：每次注册都增长
      seen.add(tool.name);
    }
    expect(seen.size).toBe(33);
    expect(registry.size()).toBe(33);

    const office = registry
      .listByCategory('office')
      .map((m) => m.name)
      .sort();
    const report = registry
      .listByCategory('report')
      .map((m) => m.name)
      .sort();
    expect(office).toEqual(OFFICE_NAMES);
    expect(report).toEqual(REPORT_NAMES);
    for (const name of OFFICE_NAMES) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it('base 单点归属：approval/schedule base 的 category 字面量为 office（5 个继承工具的唯一来源）', () => {
    // category 是实例字段（构造期赋值），原型上不可见——用源码文件级断言
    // 保证 base 单点改写（approve/reject/cancel/schedule-cancel/complete 经继承获得）
    const approvalBase = readFileSync(
      join(__dirname, 'approval-decision.base.ts'),
      'utf8',
    );
    const scheduleBase = readFileSync(
      join(__dirname, 'schedule-state.base.ts'),
      'utf8',
    );
    expect(approvalBase).toContain("category = 'office'");
    expect(approvalBase).not.toContain("category = 'report'");
    expect(scheduleBase).toContain("category = 'office'");
    expect(scheduleBase).not.toContain("category = 'report'");
  });
});
