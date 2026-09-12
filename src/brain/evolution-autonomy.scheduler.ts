/**
 * EvolutionAutonomyScheduler — E5 自治闭环定时调度（持续进化）
 *
 * 依据：权威文档 26 章 E5「自动 staging→回归→激活闭环」——闭环由定时器驱动，
 * 不再依赖人工点触发端点。安全护栏：
 * - 总台策略开关（t_platform_ai_config.evolution_auto_activate）关闭时空转；
 * - 每轮最多处理 3 个 staged 版本；单日自动激活上限 5 次（防雪崩）；
 * - 单版本闭包异常不中断本轮（记日志继续）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { EvolutionVersionService } from '../evolution/evolution-version.service';
import { StructuredExtractor } from './extraction/structured-extractor';

/** 每轮最多处理的 staged 版本数 */
const MAX_PROCESSES_PER_RUN = 3;
/** 单日自动激活上限（防样本异常导致雪崩式激活） */
const MAX_AUTO_ACTIVATIONS_PER_DAY = 5;

@Injectable()
export class EvolutionAutonomyScheduler {
  private readonly logger = new Logger(EvolutionAutonomyScheduler.name);
  /** 单日激活计数（内存态，重启即清零——上限是护栏不是记账） */
  private activationCount = { date: '', count: 0 };

  constructor(
    private readonly versions: EvolutionVersionService,
    private readonly structuredExtractor: StructuredExtractor,
    @InjectRepository(PlatformAiConfigEntity)
    private readonly platformRepo: Repository<PlatformAiConfigEntity>,
  ) {}

  /** 每 30 分钟一轮自治巡检 */
  @Cron('0 */30 * * * *')
  async handleCron(): Promise<void> {
    try {
      const result = await this.runOnce();
      if (!result.skipped && result.processed.length > 0) {
        this.logger.log(
          `E5 自治巡检：${result.processed
            .map((p) => `#${p.versionId}:${p.action}`)
            .join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `E5 自治巡检异常（本轮跳过）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 单轮自治闭环（策略门控在轮首，关闭时仅一次配置查询的开销） */
  async runOnce(): Promise<{
    skipped: boolean;
    reason?: string;
    processed: Array<{ versionId: number; action: string }>;
  }> {
    const cfg = await this.platformRepo.findOne({ where: { id: 1 } });
    if (cfg?.evolutionAutoActivate !== 1) {
      return { skipped: true, reason: '策略未开启（人工放行）', processed: [] };
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.activationCount.date !== today) {
      this.activationCount = { date: today, count: 0 };
    }

    const staged = await this.versions.list(undefined, 'staged');
    if (staged.length === 0) {
      return { skipped: true, reason: '无 staged 版本', processed: [] };
    }

    const processed: Array<{ versionId: number; action: string }> = [];
    for (const v of staged.slice(0, MAX_PROCESSES_PER_RUN)) {
      if (this.activationCount.count >= MAX_AUTO_ACTIVATIONS_PER_DAY) {
        this.logger.warn(
          `E5 自治巡检：已达单日自动激活上限（${MAX_AUTO_ACTIVATIONS_PER_DAY}），本轮提前收工`,
        );
        break;
      }
      try {
        const result = await this.versions.runAutoClosure(v.id, {
          extract: async (docType, utterance) =>
            await this.structuredExtractor.extract({ docType, utterance }),
          actor: 'e5-cron',
        });
        processed.push({ versionId: v.id, action: result.action });
        if (result.action === 'auto_activated') {
          this.activationCount.count += 1;
        }
      } catch (err) {
        this.logger.warn(
          `E5 自治闭包失败（跳过该版本）：id=${v.id} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { skipped: false, processed };
  }
}
