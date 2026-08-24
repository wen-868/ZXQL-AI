/**
 * R70-21 TextSplitterService 单元测试
 *
 * 覆盖：
 * 1. 空文本 / 纯空白 → 空数组
 * 2. 非法 chunkSize（<=0）→ 整段返回
 * 3. 默认参数（chunk_size=500, overlap=50）
 * 4. 自定义 chunkSize / overlap
 * 5. 单句超过 chunkSize → 硬切
 * 6. overlap 继承（新块开头继承上一块末尾）
 * 7. overlap=0 不继承
 * 8. 纯标点文本 → 整体作为一句
 * 9. 换行切句
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { TextSplitterService } from './text-splitter.service';

describe('R70-21 TextSplitterService', () => {
  let splitter: TextSplitterService;

  beforeEach(() => {
    splitter = new TextSplitterService();
  });

  describe('split 边界处理', () => {
    it('空文本应返回空数组', () => {
      expect(splitter.split('')).toEqual([]);
    });

    it('纯空白文本应返回空数组', () => {
      expect(splitter.split('   \n\t ')).toEqual([]);
    });

    it('非法 chunkSize（<=0）应整段返回，避免死循环', () => {
      const text = '这是一段测试文本。';
      expect(splitter.split(text, { chunkSize: 0 })).toEqual([text]);
      expect(splitter.split(text, { chunkSize: -5 })).toEqual([text]);
    });
  });

  describe('split 分块策略', () => {
    it('短文本默认参数下应整体作为一块', () => {
      const text = '五粮液是浓香型白酒的代表。茅台是酱香型白酒的代表。';
      expect(splitter.split(text)).toEqual([text]);
    });

    it('自定义 chunkSize 应按句切分为多块', () => {
      const text = '句一。句二。句三。句四。';
      const chunks = splitter.split(text, { chunkSize: 6, overlap: 0 });
      // 每句 3 字符（含标点），chunkSize=6 恰好每块 2 句
      expect(chunks).toEqual(['句一。句二。', '句三。句四。']);
    });

    it('超过 chunkSize 的句子应硬切且末尾残留落盘', () => {
      const text = '一二三四五六七八九十。';
      const chunks = splitter.split(text, { chunkSize: 10 });
      expect(chunks).toEqual(['一二三四五六七八九十', '。']);
    });

    it('单句恰好等于 chunkSize 时不应硬切', () => {
      const text = '句一。';
      expect(splitter.split(text, { chunkSize: 3 })).toEqual(['句一。']);
    });

    it('overlap>0 时新块应继承上一块末尾 overlap 字符', () => {
      const text = '句一。句二。句三。';
      const chunks = splitter.split(text, { chunkSize: 6, overlap: 2 });
      // 块1：句一。句二。；块2 继承块1 末尾 2 字符（'二。'）+ 句三。
      expect(chunks).toEqual(['句一。句二。', '二。句三。']);
    });

    it('overlap=0 时新块不应继承上一块内容', () => {
      const text = '句一。句二。句三。';
      const chunks = splitter.split(text, { chunkSize: 6, overlap: 0 });
      expect(chunks).toEqual(['句一。句二。', '句三。']);
    });

    it('overlap 超过 chunkSize-1 时应收敛到 chunkSize-1', () => {
      const text = '句一。句二。句三。';
      // overlap=99 收敛为 min(99, 5)=5，继承上一块末尾 5 字符 = '句二。句'（无，块1 为 '句一。句二。'，slice(-5)='句一。句二。'去掉首字符）
      const chunks = splitter.split(text, { chunkSize: 6, overlap: 99 });
      // 块1：句一。句二。（6 字符），继承 slice(-5)='。句二。'？不——'句一。句二。' 是 '句','一','。','句','二','。'，slice(-5) = '一。句二。'
      expect(chunks).toEqual(['句一。句二。', '一。句二。句三。']);
    });
  });

  describe('splitIntoSentences 切句', () => {
    it('纯标点文本应整体作为一句返回', () => {
      const text = '。。。';
      expect(splitter.split(text)).toEqual(['。。。']);
    });

    it('换行应作为句子分隔符', () => {
      const text = '第一行\n第二行\n第三行。';
      const chunks = splitter.split(text, { chunkSize: 4, overlap: 0 });
      // 每句切分后为 '第一行'/'第二行'/'第三行。'，chunkSize=4 时各占一块
      expect(chunks).toEqual(['第一行', '第二行', '第三行。']);
    });

    it('问号与感叹号应作为句子分隔符', () => {
      const text = '还有库存吗？没有了！那就补货吧。';
      const chunks = splitter.split(text, { chunkSize: 6, overlap: 0 });
      // 每句 6/4/6 字符，chunkSize=6 时 '没有了！'（4 字符）与前句 6+4>6，单独成块
      expect(chunks).toEqual(['还有库存吗？', '没有了！', '那就补货吧。']);
    });
  });
});
