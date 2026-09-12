/**
 * E4DistillationService — E4 本地训练的就绪度评估与数据集导出
 *
 * 依据：权威文档 26 章 E4 触发阈值——同 task_type 的 ai_sample ≥ 50 条且
 * quality ≥ 4（5 分制）。完整蒸馏（Ollama 微调）属服务器设施侧；本服务负责
 * 工程侧两件事：
 * 1. readiness：按 taskType 统计 quality≥4 样本量与平均质量，给出是否达到
 *    E4 训练阈值的看板数据；
 * 2. exportDataset：把达标样本导出为 JSONL 训练集（messages 格式，可直接
 *    供 Ollama/LLaMA-Factory 等离线微调管线消费）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/** E4 训练触发阈值（权威文档 26 章） */
export const E4_MIN_SAMPLES = 50;
export const E4_MIN_QUALITY = 4;

/** 单个 taskType 的 E4 就绪度 */
export interface E4ReadinessItem {
  taskType: string;
  /** quality≥4 的样本数 */
  qualifiedSamples: number;
  /** 全部样本的平均质量（1-5） */
  avgQuality: number;
  /** 是否达到 E4 训练阈值 */
  ready: boolean;
}

@Injectable()
export class E4DistillationService {
  constructor(
    @InjectRepository(AiSampleEntity, AI_DB_CONNECTION)
    private readonly sampleRepo: Repository<AiSampleEntity>,
  ) {}

  /**
   * E4 就绪度看板：按 taskType 统计 quality≥4 样本量、总样本量、平均质量
   */
  async readiness(): Promise<E4ReadinessItem[]> {
    const raw = await this.sampleRepo
      .createQueryBuilder('s')
      .select('s.task_type', 'taskType')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN s.quality >= :q THEN 1 ELSE 0 END)',
        'qualified',
      )
      .addSelect('AVG(s.quality)', 'avgQuality')
      .setParameter('q', E4_MIN_QUALITY)
      .groupBy('s.task_type')
      .orderBy('qualified', 'DESC')
      .getRawMany<{
        taskType: string;
        total: string | number;
        qualified: string | number;
        avgQuality: string | number;
      }>();

    return raw.map((r) => {
      const qualified = Number(r.qualified ?? 0);
      const avgQuality = Number(r.avgQuality ?? 0);
      return {
        taskType: r.taskType,
        qualifiedSamples: qualified,
        totalSamples: Number(r.total ?? 0),
        avgQuality: Math.round(avgQuality * 100) / 100,
        ready: qualified >= E4_MIN_SAMPLES && avgQuality >= E4_MIN_QUALITY,
        remaining: Math.max(0, E4_MIN_SAMPLES - qualified),
      };
    });
  }

  /**
   * 导出 JSONL 训练集（quality≥4 且 prompt/completion 齐备的样本）
   *
   * 训练集卫生：同 prompt 去重（重复样本会让微调过拟合到措辞）、
   * prompt 过短（<4 字符）剔除；格式为 messages：
   * {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
   */
  async exportDataset(
    taskType: string,
    limit = 500,
  ): Promise<{ taskType: string; count: number; jsonl: string }> {
    const samples = await this.sampleRepo.find({
      where: { taskType, quality: MoreThanOrEqual(E4_MIN_QUALITY) },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 2000),
    });

    const lines: string[] = [];
    const seenPrompts = new Set<string>();
    for (const s of samples) {
      const prompt = (s.prompt ?? '').trim();
      const completion = (s.completion ?? '').trim();
      if (prompt.length < 4 || seenPrompts.has(prompt)) continue;
      if (!completion) continue;
      seenPrompts.add(prompt);
      lines.push(
        JSON.stringify({
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: completion },
          ],
        }),
      );
    }

    return { taskType, count: lines.length, jsonl: lines.join('\n') };
  }
}
