/**
 * ReportService — 报表生成与 PDF 导出（批次3，文档 11.1 /ai/v2/report）
 *
 * A/B/C/D 类报表映射到现有只读工具：
 * - A 销售报表 → salesReport（日报/趋势）
 * - B 库存报表 → inventoryReport（按商品/门店分组）
 * - C 利润报表 → profitReport（销售收入/成本/毛利）
 * - D 经营总览 → api_get_business_overview（核心经营指标）
 *
 * PDF：@napi-rs/canvas 绘制（注册系统 CJK 字体保证中文），JPEG 内嵌到
 * 手写单页 PDF（DCTDecode XObject，无第三方 PDF 依赖）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { Injectable } from '@nestjs/common';
import { existsSync } from 'fs';
import { ToolExecutor } from '../../tools/tool-executor';
import type { ToolContext } from '../../tools/tool.interface';
import type { ToolCall } from '../../providers/provider.interface';

/** 报表类别 */
export type V2ReportType = 'A' | 'B' | 'C' | 'D';

/** 报表参数 */
export interface V2ReportParams {
  dateStart?: string;
  dateEnd?: string;
  storeId?: number;
  groupBy?: string;
  limit?: number;
  period?: string;
}

/** 报表结果 */
export interface V2ReportResult {
  type: V2ReportType;
  title: string;
  tool: string;
  generatedAt: string;
  data: unknown;
  summary: string;
}

/** 报表定义 */
export const REPORT_DEFS: Record<
  V2ReportType,
  { tool: string; label: string }
> = {
  A: { tool: 'salesReport', label: '销售报表' },
  B: { tool: 'inventoryReport', label: '库存报表' },
  C: { tool: 'profitReport', label: '利润报表' },
  D: { tool: 'api_get_business_overview', label: '经营总览' },
};

/** 常见字段 → 中文表头（PDF 展示） */
const HEADER_NAMES: Record<string, string> = {
  date: '日期',
  period: '周期',
  salesAmount: '销售额',
  orderCount: '订单数',
  customerCount: '客户数',
  avgOrderValue: '客单价',
  productName: '商品',
  skuName: '商品',
  storeName: '门店',
  qty: '数量',
  stockQty: '库存',
  costAmount: '成本',
  profit: '毛利',
  grossMargin: '毛利率',
  totalSales: '总销售额',
  totalOrders: '总订单',
  skuCount: 'SKU数',
};

/** 常见系统 CJK 字体路径（按序探测，命中即注册） */
const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/opentype/source-han-sans/SourceHanSansCN-Regular.otf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
];

@Injectable()
export class ReportService {
  constructor(private readonly executor: ToolExecutor) {}

  /**
   * 生成报表（A/B/C/D → 现有只读工具）
   *
   * @throws 工具执行失败时抛出带建议的 Error
   */
  async generate(
    type: V2ReportType,
    params: V2ReportParams,
    context: ToolContext,
  ): Promise<V2ReportResult> {
    const def = REPORT_DEFS[type];
    if (!def) {
      throw new Error(`未知报表类别：${type}（仅支持 A/B/C/D）`);
    }
    const args = buildArgs(type, params);
    const result = await this.executor.executeToolCall(
      toToolCall(def.tool, args),
      context,
    );
    if (!result.success) {
      throw new Error(
        `${def.label}生成失败：${result.error ?? '未知错误'}${result.suggestion ? `（${result.suggestion}）` : ''}`,
      );
    }
    return {
      type,
      title: def.label,
      tool: def.tool,
      generatedAt: new Date().toISOString(),
      data: result.data ?? {},
      summary: buildSummary(def.label, result.data),
    };
  }

  /**
   * 报表导出 PDF（canvas 渲染中文表格 → JPEG → 单页 PDF）
   *
   * @throws 渲染依赖不可用时抛出（保持 500 语义明确）
   */
  async renderPdf(report: V2ReportResult): Promise<Buffer> {
    let canvasModule: typeof import('@napi-rs/canvas');
    try {
      canvasModule = await import('@napi-rs/canvas');
    } catch (err) {
      throw new Error(
        `PDF 渲染依赖不可用：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const { createCanvas, GlobalFonts } = canvasModule;
    const fontFamily = registerCjkFont(GlobalFonts);

    // A4 纵向 @150dpi
    const W = 1240;
    const H = 1754;
    const canvas = createCanvas(W, H);
    const g = canvas.getContext('2d');
    const font = (bold: boolean, px: number): string =>
      `${bold ? 'bold ' : ''}${px}px ${fontFamily ?? 'sans-serif'}`;

    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);

    // 标题 + 元信息
    g.fillStyle = '#1f2937';
    g.font = font(true, 52);
    g.fillText(`${report.title}（${report.type} 类）`, 60, 90);
    g.font = font(false, 28);
    g.fillStyle = '#6b7280';
    g.fillText(
      `生成时间：${report.generatedAt}｜数据源工具：${report.tool}`,
      60,
      140,
    );
    g.fillText(report.summary.slice(0, 80), 60, 185);

    // 表格
    const rows = extractRows(report.data);
    if (rows.length === 0) {
      g.fillStyle = '#374151';
      g.font = font(false, 34);
      g.fillText('（无可展示的明细数据，请查看上方汇总）', 60, 260);
    } else {
      drawTable(g, rows, font, W);
    }

    const jpeg = canvas.toBuffer('image/jpeg', 85);
    return buildSinglePageImagePdf(jpeg, W, H);
  }
}

// ──────────────────────────────────────────────────────────
// 参数映射
// ──────────────────────────────────────────────────────────

function buildArgs(
  type: V2ReportType,
  params: V2ReportParams,
): Record<string, unknown> {
  switch (type) {
    case 'A':
      return {
        reportType: 'daily',
        dateStart: params.dateStart,
        dateEnd: params.dateEnd,
        storeId: params.storeId,
      };
    case 'B':
      return {
        groupBy: params.groupBy ?? 'product',
        storeId: params.storeId,
      };
    case 'C':
      return { dateStart: params.dateStart, dateEnd: params.dateEnd };
    case 'D':
      return { start: params.dateStart, end: params.dateEnd };
    default:
      return {};
  }
}

function toToolCall(tool: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: tool, arguments: JSON.stringify(args) },
  };
}

// ──────────────────────────────────────────────────────────
// 汇总与表格数据提取
// ──────────────────────────────────────────────────────────

function buildSummary(label: string, data: unknown): string {
  if (!data || typeof data !== 'object') {
    return `${label}：无数据`;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.summary === 'string') {
    return obj.summary;
  }
  const rows = extractRows(data);
  const numeric = Object.entries(obj)
    .filter(
      ([k, v]) =>
        typeof v === 'number' &&
        !Array.isArray(v) &&
        k !== 'id' &&
        k !== 'page',
    )
    .map(([k, v]) => `${HEADER_NAMES[k] ?? k}:${String(v)}`)
    .slice(0, 5)
    .join('，');
  return `${label}：共 ${rows.length} 行明细${numeric ? `｜${numeric}` : ''}`;
}

function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === 'object') as Array<
      Record<string, unknown>
    >;
  }
  if (data && typeof data === 'object') {
    for (const key of [
      'list',
      'records',
      'items',
      'data',
      'rows',
      'ranking',
      'trend',
    ]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        return v.filter((x) => x && typeof x === 'object') as Array<
          Record<string, unknown>
        >;
      }
    }
  }
  return [];
}

// ──────────────────────────────────────────────────────────
// PDF 渲染（canvas 表格 → JPEG → 单页 PDF）
// ──────────────────────────────────────────────────────────

function registerCjkFont(GlobalFonts: {
  registerFromPath: (path: string, name: string) => unknown;
}): string | undefined {
  for (const path of CJK_FONT_CANDIDATES) {
    try {
      if (existsSync(path)) {
        GlobalFonts.registerFromPath(path, 'CJK');
        return 'CJK';
      }
    } catch {
      // 继续探测下一个字体
    }
  }
  return undefined;
}

interface CanvasLike {
  fillStyle: unknown;
  strokeStyle: unknown;
  font: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  measureText(text: string): { width: number };
}

/** 绘制报表表格（最多 6 列 × 22 行，超出提示） */
function drawTable(
  g: CanvasLike,
  rows: Array<Record<string, unknown>>,
  font: (bold: boolean, px: number) => string,
  W: number,
): void {
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(
    0,
    6,
  );
  const colW = (W - 120) / keys.length;
  const rowH = 46;
  const headerH = 58;
  const maxRows = 22;
  const shown = rows.slice(0, maxRows);

  let y = 235;
  // 表头
  g.fillStyle = '#f3f4f6';
  g.fillRect(60, y, W - 120, headerH);
  g.fillStyle = '#111827';
  g.font = font(true, 30);
  keys.forEach((k, i) => {
    g.fillText(HEADER_NAMES[k] ?? k, 75 + i * colW, y + 38);
  });
  y += headerH;

  // 明细
  g.font = font(false, 28);
  shown.forEach((row, ri) => {
    if (ri % 2 === 1) {
      g.fillStyle = '#f9fafb';
      g.fillRect(60, y, W - 120, rowH);
    }
    g.fillStyle = '#374151';
    keys.forEach((k, ci) => {
      const text = cellText(row[k]).slice(0, 18);
      g.fillText(text, 75 + ci * colW, y + 34);
    });
    g.strokeStyle = '#e5e7eb';
    g.strokeRect(60, y, W - 120, rowH);
    y += rowH;
  });

  if (rows.length > maxRows) {
    g.fillStyle = '#6b7280';
    g.font = font(false, 26);
    g.fillText(`… 共 ${rows.length} 行，完整数据请查看在线报表`, 75, y + 30);
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? '-';
}

/** 手写单页 PDF：JPEG 图片内嵌（DCTDecode XObject） */
export function buildSinglePageImagePdf(
  jpeg: Buffer,
  widthPx: number,
  heightPx: number,
): Buffer {
  const pageW = 595.28;
  const pageH = 841.89;
  const scale = Math.min(pageW / widthPx, pageH / heightPx, 1);
  const drawW = Math.round(widthPx * scale);
  const drawH = Math.round(heightPx * scale);

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  // PDF 文件头（不计入对象偏移）
  chunks.push(Buffer.from('%PDF-1.4\n', 'binary'));
  const push = (s: string | Buffer): void => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(typeof s === 'string' ? Buffer.from(s, 'binary') : s);
  };

  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q\n${drawW} 0 0 ${drawH} 0 0 cm\n/Im0 Do\nQ\n`;
  push(
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}endstream\nendobj\n`,
  );
  const xrefPos = Buffer.concat(chunks).length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const o of offsets) {
    xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'binary'));
  return Buffer.concat(chunks);
}
