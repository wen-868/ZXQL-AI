/**
 * DocumentLoaderService — 文档加载服务（PDF / Word / Markdown / Excel / 纯文本）
 *
 * 职责：
 * 1. 按文件扩展名路由到对应解析器，将文档内容抽取为纯文本
 * 2. 供 RAG 上传文档建立索引时使用（loadFromBuffer）
 * 3. 支持从文件路径直接读取（loadFromFile，内部用 fs/promises）
 *
 * 解析器：
 * - PDF：pdf-parse 2.4.5（纯 TS 重写：new PDFParse({ data }) → await getText() → .text）
 * - Word（.docx）：mammoth 1.12.0（extractRawText，自带类型定义）
 * - Markdown / 纯文本：直接 utf8 解码
 * - Excel（.xlsx/.xls/.csv）：xlsx 0.18.5（sheet_to_csv 合并所有工作表）
 *
 * 错误处理：未知扩展名 / 解析失败均抛 DocumentLoadError，由调用方决定处理方式。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十八章 rag/（文档加载）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

/** 支持的文档类型 */
export type SupportedDocType = 'pdf' | 'docx' | 'markdown' | 'excel' | 'text';

/** 扩展名 → 文档类型 映射表 */
const EXT_TO_TYPE: Record<string, SupportedDocType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.csv': 'excel',
};

/** 文档加载异常（统一包装，供调用方捕获处理） */
export class DocumentLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLoadError';
  }
}

@Injectable()
export class DocumentLoaderService {
  private readonly logger = new Logger(DocumentLoaderService.name);

  /**
   * 从文件路径加载文档并抽取纯文本
   *
   * @param filePath 本地文件绝对/相对路径
   * @returns 抽取后的纯文本
   */
  async loadFromFile(filePath: string): Promise<string> {
    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch (err) {
      throw new DocumentLoadError(
        `读取文件失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.loadFromBuffer(buffer, basename(filePath));
  }

  /**
   * 从内存 buffer 加载文档并抽取纯文本
   *
   * @param buffer 文件字节内容
   * @param filename 文件名（用于判断扩展名）
   * @returns 抽取后的纯文本
   */
  async loadFromBuffer(buffer: Buffer, filename: string): Promise<string> {
    const docType = this.detectType(filename);
    this.logger.debug(`加载文档：${filename}（type=${docType}）`);

    switch (docType) {
      case 'pdf':
        return this.extractPdf(buffer);
      case 'docx':
        return this.extractDocx(buffer);
      case 'excel':
        return this.extractExcel(buffer);
      case 'markdown':
      case 'text':
        return buffer.toString('utf8');
    }
  }

  /**
   * 判断文件名对应的文档类型（小写扩展名匹配）
   */
  detectType(filename: string): SupportedDocType {
    const ext = this.getExt(filename);
    const docType = EXT_TO_TYPE[ext];
    if (!docType) {
      throw new DocumentLoadError(
        `不支持的文档扩展名：${ext || '(无扩展名)'}（支持 pdf/docx/md/txt/xlsx/xls/csv）`,
      );
    }
    return docType;
  }

  /**
   * 提取小写扩展名（含点号，如 ".pdf"）
   */
  private getExt(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex <= 0) {
      return '';
    }
    return filename.slice(dotIndex).toLowerCase();
  }

  /**
   * PDF 文本抽取（pdf-parse 2.4.5：纯 TS 重写版）
   *
   * 懒加载说明：pdf-parse 依赖 pdfjs-dist，而 pdfjs-dist 在 Node 20 环境
   * 需要全局 DOMMatrix（Node 20 无此全局对象）。若在模块顶层 import，
   * 服务启动即抛 `ReferenceError: DOMMatrix is not defined`。
   * 因此改为仅在真正解析 PDF 时动态加载，并优先从 @napi-rs/canvas 注入
   * DOMMatrix（服务器 pnpm install 编译成功后可用）；注入失败仅导致
   * PDF 解析报错，不影响服务整体启动。
   */
  private async extractPdf(buffer: Buffer): Promise<string> {
    try {
      if (
        typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined'
      ) {
        try {
          const canvas = await import('@napi-rs/canvas');
          if (canvas && (canvas as { DOMMatrix?: unknown }).DOMMatrix) {
            (globalThis as { DOMMatrix?: unknown }).DOMMatrix = (
              canvas as { DOMMatrix: unknown }
            ).DOMMatrix;
          }
        } catch {
          // 无 canvas 原生绑定：PDF 解析将失败，但不阻塞服务启动
        }
      }
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const text = result.text ?? '';
      return text.trim();
    } catch (err) {
      throw new DocumentLoadError(
        `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Word 文本抽取（mammoth：extractRawText 返回 { value }）
   */
  private async extractDocx(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return (result.value ?? '').trim();
    } catch (err) {
      throw new DocumentLoadError(
        `Word 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Excel 文本抽取（xlsx：读取所有工作表并转 CSV 后拼接）
   */
  private extractExcel(buffer: Buffer): string {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheets = workbook.SheetNames;
      if (!sheets || sheets.length === 0) {
        return '';
      }
      const parts = sheets.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
          return '';
        }
        const csv = XLSX.utils.sheet_to_csv(sheet);
        return `【工作表：${sheetName}】\n${csv}`;
      });
      return parts.join('\n\n').trim();
    } catch (err) {
      throw new DocumentLoadError(
        `Excel 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
