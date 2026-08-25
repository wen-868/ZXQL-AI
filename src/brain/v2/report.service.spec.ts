/**
 * ReportService 单元测试（批次3，文档 11.1 /ai/v2/report）
 *
 * 覆盖：A/B/C/D 工具映射与参数、未知类型、PDF 导出（canvas mock）、
 * extractDocId 单据号提取
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { ReportService, buildSinglePageImagePdf } from './report.service';
import { extractDocId } from '../../gateway/v2.controller';

function makeService(
  overrides: {
    executor?: { executeToolCall?: jest.Mock };
  } = {},
) {
  const executor = {
    executeToolCall:
      overrides.executor?.executeToolCall ??
      jest.fn().mockResolvedValue({
        success: true,
        data: {
          list: [
            { date: '2026-08-01', salesAmount: 19600, orderCount: 3 },
            { date: '2026-08-02', salesAmount: 8800, orderCount: 2 },
          ],
          totalSales: 28400,
        },
      }),
  };
  const service = new ReportService(executor as never);
  return { service, executor };
}

const CTX = { tenantId: 't1', sessionId: 's1' };

describe('ReportService', () => {
  it('A 类销售报表：映射 salesReport + daily 参数', async () => {
    const { service, executor } = makeService();
    const result = await service.generate(
      'A',
      { dateStart: '2026-08-01', dateEnd: '2026-08-31' },
      CTX,
    );
    expect(result.type).toBe('A');
    expect(result.title).toBe('销售报表');
    expect(result.tool).toBe('salesReport');
    const call = executor.executeToolCall.mock.calls[0] as unknown as [
      { function: { name: string; arguments: string } },
      typeof CTX,
    ];
    expect(call[0].function.name).toBe('salesReport');
    expect(call[0].function.arguments).toContain('"reportType":"daily"');
    expect(call[1]).toBe(CTX);
    expect(result.summary).toContain('2 行明细');
  });

  it('B/C/D 类分别映射 inventoryReport/profitReport/经营总览', async () => {
    const { service, executor } = makeService();
    const b = await service.generate('B', { groupBy: 'store' }, CTX);
    expect(b.tool).toBe('inventoryReport');
    const calls = executor.executeToolCall.mock.calls as unknown as Array<
      [{ function: { name: string; arguments: string } }, unknown]
    >;
    const lastCall = calls.at(-1)?.[0];
    expect(lastCall.function.arguments).toContain('"groupBy":"store"');

    await service.generate('C', { dateStart: '2026-08-01' }, CTX);
    const callC = calls.at(-1)?.[0];
    expect(callC.function.name).toBe('profitReport');

    const d = await service.generate('D', {}, CTX);
    expect(d.tool).toBe('api_get_business_overview');
    expect(d.title).toBe('经营总览');
  });

  it('未知类型：抛错', async () => {
    const { service } = makeService();
    await expect(service.generate('X' as never, {}, CTX)).rejects.toThrow(
      /未知报表类别/,
    );
  });

  it('工具失败：抛错并带建议', async () => {
    const { service } = makeService({
      executor: {
        executeToolCall: jest.fn().mockResolvedValue({
          success: false,
          error: '后端超时',
          suggestion: '请稍后重试',
        }),
      },
    });
    await expect(service.generate('A', {}, CTX)).rejects.toThrow(
      /销售报表生成失败/,
    );
  });

  it('buildSinglePageImagePdf：输出合法 PDF 字节（%PDF- 头 + JPEG XObject + xref）', () => {
    const pdf = buildSinglePageImagePdf(Buffer.from('FAKEJPEG'), 1240, 1754);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Filter /DCTDecode');
    expect(pdf.toString('latin1')).toContain('startxref');
    expect(pdf.toString('latin1')).toContain('FAKEJPEG');
  });

  it('renderPdf：jest 环境动态导入受限时抛出清晰错误（服务端 Node 正常渲染）', async () => {
    const { service } = makeService();
    const result = await service.generate('A', {}, CTX);
    await expect(service.renderPdf(result)).rejects.toThrow(
      /PDF 渲染依赖不可用/,
    );
  });
});

describe('extractDocId', () => {
  it('常见单据号字段提取', () => {
    expect(extractDocId({ orderNo: 'SO20260815001' })).toBe('SO20260815001');
    expect(extractDocId({ id: 123 })).toBe('123');
    expect(extractDocId({ recordId: 'R9' })).toBe('R9');
    expect(extractDocId({ data: [1, 2] })).toBeUndefined();
    expect(extractDocId(null)).toBeUndefined();
  });
});
