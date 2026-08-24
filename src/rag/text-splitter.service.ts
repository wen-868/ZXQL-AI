/**
 * TextSplitterService — 文本分块服务
 *
 * 职责：
 * 1. 将长文本按语义句切分为固定大小（chunk_size=500 字符）的块
 * 2. 相邻块之间保留 overlap（默认 50 字符）重叠，避免语义在边界被切断
 *
 * 分块策略：
 * - 先按句号/问号/感叹号/分号/换行切句（保留分隔符，保证句子完整）
 * - 贪心聚合句子到 chunkSize 上限；超限时硬切
 * - 新块开头继承上一块末尾 overlap 个字符，保证检索上下文连续
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十八章 rag/（文本分块）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable } from '@nestjs/common';

/** 分块参数 */
export interface SplitOptions {
  /** 每块最大字符数（默认 500） */
  chunkSize?: number;
  /** 相邻块重叠字符数（默认 50，需小于 chunkSize） */
  overlap?: number;
}

@Injectable()
export class TextSplitterService {
  /**
   * 将文本切分为多个块
   *
   * @param text 原始文本
   * @param options 分块参数（chunkSize=500 / overlap=50 为默认值）
   * @returns 分块数组（空文本返回空数组）
   */
  split(text: string, options?: SplitOptions): string[] {
    const chunkSize = options?.chunkSize ?? 500;
    const overlap = options?.overlap ?? 50;

    // 空文本 / 仅空白 → 空数组
    if (!text || text.trim().length === 0) {
      return [];
    }

    // 非法 chunkSize：退化为整段返回（避免死循环）
    if (chunkSize <= 0) {
      return [text];
    }

    // overlap 收敛到 [0, chunkSize-1]，保证新块至少有一个新句子位置
    const safeOverlap = overlap > 0 ? Math.min(overlap, chunkSize - 1) : 0;

    const sentences = this.splitIntoSentences(text);
    const chunks: string[] = [];
    let current = '';
    // 记录上一块用于 overlap 继承（仅记录非空块）
    let previousChunk = '';

    for (const sentence of sentences) {
      // 放得下则追加
      if (current.length + sentence.length <= chunkSize) {
        current += sentence;
        continue;
      }

      // 放不下：先落盘当前块
      if (current.length > 0) {
        chunks.push(current);
        previousChunk = current;
        current = '';
      }

      // 单个句子超过 chunkSize 时硬切（此时 current 已被落盘或为空）
      if (sentence.length > chunkSize) {
        let rest = sentence;
        while (rest.length > chunkSize) {
          chunks.push(rest.slice(0, chunkSize));
          previousChunk = rest.slice(0, chunkSize);
          rest = rest.slice(chunkSize);
        }
        current = rest;
      } else {
        // 常规：句子作为新块起点（继承 overlap）
        if (previousChunk.length > 0 && safeOverlap > 0) {
          current = previousChunk.slice(-safeOverlap) + sentence;
        } else {
          current = sentence;
        }
      }
    }

    // 末尾残留
    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  /**
   * 按标点/换行切句（保留分隔符，保证句子完整）
   *
   * 匹配：连续非分隔符字符 + 可选的分隔符（。！？!?；;\n）
   * 若切分结果为空（如纯标点文本）则整体作为一句返回。
   */
  private splitIntoSentences(text: string): string[] {
    const parts: string[] = [];
    const regex = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const sentence = match[0].trim();
      if (sentence.length > 0) {
        parts.push(sentence);
      }
    }
    return parts.length > 0 ? parts : [text];
  }
}
