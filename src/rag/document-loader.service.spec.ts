/**
 * R70-21 DocumentLoaderService 单元测试
 *
 * 覆盖：
 * 1. loadFromFile — 读取成功 / 读取失败（fs/promises）
 * 2. loadFromBuffer — pdf / docx / excel / markdown / text 各解析分支
 * 3. 解析失败 — PDF / Word / Excel 异常包装为 DocumentLoadError
 * 4. detectType — 各扩展名映射 / 大写扩展名 / 无扩展名 / 未知扩展名
 * 5. Excel — 多工作表拼接 / 空工作表集合 / 缺 sheet 对象
 *
 * 第三方库均被 mock（pdf-parse / mammoth / xlsx / fs/promises）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { readFile } from 'fs/promises';
import * as XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import {
  DocumentLoadError,
  DocumentLoaderService,
} from './document-loader.service';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

jest.mock('mammoth', () => ({
  extractRawText: jest.fn(),
}));

jest.mock('xlsx', () => ({
  read: jest.fn(),
  utils: {
    sheet_to_csv: jest.fn(),
  },
}));

/** mock readFile 断言辅助 */
const mockReadFile = readFile as jest.Mock;
/** mock PDFParse 构造器 */
const mockPDFParseCtor = PDFParse as unknown as jest.Mock;
/** mock mammoth.extractRawText（requireMock 避免 unbound-method） */
const mockExtractRawText = jest.requireMock<{ extractRawText: unknown }>(
  'mammoth',
).extractRawText as jest.Mock;
/** mock XLSX.read */
const mockXlsxRead = XLSX.read as jest.Mock;
/** mock XLSX.utils.sheet_to_csv（requireMock 避免 unbound-method） */
const mockSheetToCsv = jest.requireMock<{
  utils: { sheet_to_csv: unknown };
}>('xlsx').utils.sheet_to_csv as jest.Mock;

describe('R70-21 DocumentLoaderService', () => {
  let loader: DocumentLoaderService;

  beforeEach(() => {
    loader = new DocumentLoaderService();
    jest.clearAllMocks();
  });

  describe('loadFromFile', () => {
    it('读取成功应返回解析后的文本（markdown）', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('# 标题\n正文内容', 'utf8'));
      const text = await loader.loadFromFile('/tmp/doc.md');
      expect(text).toBe('# 标题\n正文内容');
      expect(mockReadFile).toHaveBeenCalledWith('/tmp/doc.md');
    });

    it('读取失败应抛出 DocumentLoadError', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await expect(loader.loadFromFile('/tmp/none.md')).rejects.toThrow(
        DocumentLoadError,
      );
      await expect(loader.loadFromFile('/tmp/none.md')).rejects.toThrow(
        '读取文件失败',
      );
    });
  });

  describe('loadFromBuffer markdown / text', () => {
    it('markdown 直接 utf8 解码', async () => {
      const text = await loader.loadFromBuffer(
        Buffer.from('# 标题\n内容'),
        'guide.md',
      );
      expect(text).toBe('# 标题\n内容');
    });

    it('.markdown 扩展名同样按 markdown 处理', async () => {
      const text = await loader.loadFromBuffer(
        Buffer.from('**粗体**'),
        'guide.markdown',
      );
      expect(text).toBe('**粗体**');
    });

    it('txt 与 log 按 text 处理', async () => {
      await expect(
        loader.loadFromBuffer(Buffer.from('日志内容'), 'app.log'),
      ).resolves.toBe('日志内容');
      await expect(
        loader.loadFromBuffer(Buffer.from('纯文本'), 'note.txt'),
      ).resolves.toBe('纯文本');
    });
  });

  describe('loadFromBuffer pdf', () => {
    it('PDF 解析成功返回文本', async () => {
      mockPDFParseCtor.mockImplementation(() => ({
        getText: jest.fn().mockResolvedValue({ text: '  PDF 内容  ' }),
      }));
      const text = await loader.loadFromBuffer(
        Buffer.from('pdf-bytes'),
        'a.pdf',
      );
      expect(text).toBe('PDF 内容');
      expect(mockPDFParseCtor).toHaveBeenCalledWith({
        data: Buffer.from('pdf-bytes'),
      });
    });

    it('PDF 解析失败应抛出 DocumentLoadError', async () => {
      mockPDFParseCtor.mockImplementation(() => ({
        getText: jest.fn().mockRejectedValue(new Error('corrupt pdf')),
      }));
      await expect(
        loader.loadFromBuffer(Buffer.from('bad'), 'a.pdf'),
      ).rejects.toThrow('PDF 解析失败');
    });
  });

  describe('loadFromBuffer docx', () => {
    it('Word 解析成功返回文本', async () => {
      mockExtractRawText.mockResolvedValue({ value: '  Word 文本  ' });
      const text = await loader.loadFromBuffer(
        Buffer.from('docx-bytes'),
        'a.docx',
      );
      expect(text).toBe('Word 文本');
      expect(mockExtractRawText).toHaveBeenCalledWith({
        buffer: Buffer.from('docx-bytes'),
      });
    });

    it('Word 解析失败应抛出 DocumentLoadError', async () => {
      mockExtractRawText.mockRejectedValue(new Error('invalid docx'));
      await expect(
        loader.loadFromBuffer(Buffer.from('bad'), 'a.docx'),
      ).rejects.toThrow('Word 解析失败');
    });
  });

  describe('loadFromBuffer excel', () => {
    it('多工作表应拼接 CSV', async () => {
      mockXlsxRead.mockReturnValue({
        SheetNames: ['库存', '价格'],
        Sheets: { 库存: {}, 价格: {} },
      });
      mockSheetToCsv.mockImplementation((_sheet: unknown, _opts?: unknown) => {
        // 按工作表对象模拟不同 CSV
        return 'csv-content';
      });
      const text = await loader.loadFromBuffer(
        Buffer.from('xlsx-bytes'),
        'data.xlsx',
      );
      expect(text).toBe(
        '【工作表：库存】\ncsv-content\n\n【工作表：价格】\ncsv-content',
      );
    });

    it('xls 与 csv 扩展名同样按 excel 处理', async () => {
      mockXlsxRead.mockReturnValue({ SheetNames: ['S1'], Sheets: { S1: {} } });
      mockSheetToCsv.mockReturnValue('a,b\n1,2');
      await expect(
        loader.loadFromBuffer(Buffer.from('x'), 'a.xls'),
      ).resolves.toBe('【工作表：S1】\na,b\n1,2');
      mockXlsxRead.mockReturnValue({ SheetNames: ['S1'], Sheets: { S1: {} } });
      await expect(
        loader.loadFromBuffer(Buffer.from('x'), 'a.csv'),
      ).resolves.toBe('【工作表：S1】\na,b\n1,2');
    });

    it('无工作表应返回空字符串', async () => {
      mockXlsxRead.mockReturnValue({ SheetNames: [], Sheets: {} });
      await expect(
        loader.loadFromBuffer(Buffer.from('x'), 'a.xlsx'),
      ).resolves.toBe('');
    });

    it('工作表对象缺失应跳过该工作表', async () => {
      mockXlsxRead.mockReturnValue({
        SheetNames: ['存在', '缺失'],
        Sheets: { 存在: {} },
      });
      mockSheetToCsv.mockReturnValue('内容');
      const text = await loader.loadFromBuffer(Buffer.from('x'), 'a.xlsx');
      expect(text).toBe('【工作表：存在】\n内容');
    });

    it('Excel 解析失败应抛出 DocumentLoadError', async () => {
      mockXlsxRead.mockImplementation(() => {
        throw new Error('invalid xlsx');
      });
      await expect(
        loader.loadFromBuffer(Buffer.from('bad'), 'a.xlsx'),
      ).rejects.toThrow('Excel 解析失败');
    });
  });

  describe('loadFromBuffer 未知类型', () => {
    it('不支持的扩展名应抛出 DocumentLoadError', async () => {
      await expect(
        loader.loadFromBuffer(Buffer.from('x'), 'virus.exe'),
      ).rejects.toThrow('不支持的文档扩展名');
    });
  });

  describe('detectType', () => {
    it('各扩展名映射正确', () => {
      expect(loader.detectType('a.pdf')).toBe('pdf');
      expect(loader.detectType('a.docx')).toBe('docx');
      expect(loader.detectType('a.md')).toBe('markdown');
      expect(loader.detectType('a.markdown')).toBe('markdown');
      expect(loader.detectType('a.txt')).toBe('text');
      expect(loader.detectType('a.log')).toBe('text');
      expect(loader.detectType('a.xlsx')).toBe('excel');
      expect(loader.detectType('a.xls')).toBe('excel');
      expect(loader.detectType('a.csv')).toBe('excel');
    });

    it('大写扩展名应归一化为小写', () => {
      expect(loader.detectType('A.PDF')).toBe('pdf');
      expect(loader.detectType('A.DOCX')).toBe('docx');
      expect(loader.detectType('A.XLSX')).toBe('excel');
    });

    it('无扩展名应抛出 DocumentLoadError', () => {
      expect(() => loader.detectType('README')).toThrow(DocumentLoadError);
      expect(() => loader.detectType('README')).toThrow('无扩展名');
    });

    it('未知扩展名应抛出 DocumentLoadError', () => {
      expect(() => loader.detectType('a.rar')).toThrow(DocumentLoadError);
      expect(() => loader.detectType('a.rar')).toThrow('不支持的文档扩展名');
    });
  });
});
