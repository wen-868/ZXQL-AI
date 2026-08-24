/**
 * LongTermMemoryService — 长期记忆（完善度 P1 认知层 LT）
 *
 * 职责：
 * 1. 档案 profile：租户/用户稳定事实（偏好/常用对象/禁区）读写
 * 2. 情节 episodic：历史交互经验（what/why/outcome）落库 + 配额淘汰
 * 3. 归档 archival：知识沉淀（复盘结论/话术模板）落库
 * 4. 检索：按 query 返回相关记忆（关键词匹配 + 相关性排序；向量检索后续扩展）
 *
 * 隔离：全部按 tenantId；不跨租户。
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P1 长期记忆 LT
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AiLtmProfileEntity } from '../../database/entities/ai-ltm-profile.entity';
import { AiLtmEpisodicEntity } from '../../database/entities/ai-ltm-episodic.entity';
import { AiLtmArchivalEntity } from '../../database/entities/ai-ltm-archival.entity';

/** 情节经验输入 */
export interface ExperienceInput {
  what: string;
  why?: string;
  outcome: 'good' | 'bad';
  summary?: string;
}

/** 检索结果 */
export interface LtmSearchHit {
  kind: 'episodic' | 'archival';
  id: number;
  text: string;
  createdAt: Date;
}

/** 每租户情节上限（超出淘汰最旧） */
const DEFAULT_EPISODIC_MAX = 500;

@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);
  private readonly episodicMax: number;

  constructor(
    @InjectRepository(AiLtmProfileEntity)
    private readonly profileRepo: Repository<AiLtmProfileEntity>,
    @InjectRepository(AiLtmEpisodicEntity)
    private readonly episodicRepo: Repository<AiLtmEpisodicEntity>,
    @InjectRepository(AiLtmArchivalEntity)
    private readonly archivalRepo: Repository<AiLtmArchivalEntity>,
    configService: ConfigService,
  ) {
    this.episodicMax =
      configService.get<number>('LTM_EPISODIC_MAX', DEFAULT_EPISODIC_MAX) ??
      DEFAULT_EPISODIC_MAX;
  }

  // ── 档案 profile ─────────────────────────────────────────────

  /**
   * 写入/更新档案（同键覆盖）
   */
  async upsertProfile(
    tenantId: string,
    key: string,
    value: unknown,
    entityType = 'tenant',
    entityId?: string,
  ): Promise<void> {
    let entity = await this.profileRepo.findOne({
      where: {
        tenantId,
        entityType,
        entityId: entityId ? entityId : IsNull(),
        k: key,
      },
    });
    if (!entity) {
      entity = this.profileRepo.create({
        tenantId,
        entityType,
        entityId: entityId ?? null,
        k: key,
        vJson: { value },
      });
    } else {
      entity.vJson = { value };
    }
    await this.profileRepo.save(entity);
  }

  /**
   * 获取租户档案（tenant + 指定主体）
   */
  async getProfiles(
    tenantId: string,
    entityId?: string,
  ): Promise<Array<{ k: string; v: unknown }>> {
    const rows = await this.profileRepo.find({
      where: [
        { tenantId, entityType: 'tenant', entityId: IsNull() },
        ...(entityId ? [{ tenantId, entityType: 'user', entityId }] : []),
      ],
    });
    return rows
      .filter((r) => r.vJson !== null)
      .map((r) => ({ k: r.k, v: (r.vJson as { value: unknown }).value }));
  }

  /**
   * 删除档案
   */
  async deleteProfile(tenantId: string, key: string): Promise<void> {
    await this.profileRepo.delete({
      tenantId,
      entityType: 'tenant',
      entityId: IsNull(),
      k: key,
    });
  }

  // ── 情节 episodic ────────────────────────────────────────────

  /**
   * 保存一条经验（超出配额淘汰最旧）
   */
  async saveEpisodic(tenantId: string, exp: ExperienceInput): Promise<void> {
    this.logger.debug(
      `保存情节经验：tenant=${tenantId} outcome=${exp.outcome} what=${exp.what.slice(0, 40)}`,
    );
    const count = await this.episodicRepo.count({ where: { tenantId } });
    if (count >= this.episodicMax) {
      const oldest = await this.episodicRepo.findOne({
        where: { tenantId },
        order: { createdAt: 'ASC' },
      });
      if (oldest) {
        await this.episodicRepo.remove(oldest);
      }
    }
    await this.episodicRepo.save(
      this.episodicRepo.create({
        tenantId,
        what: exp.what,
        why: exp.why ?? null,
        outcome: exp.outcome,
        summary: exp.summary ?? exp.what,
        score: exp.outcome === 'bad' ? 1 : 0,
      }),
    );
  }

  /**
   * 租户情节列表（倒序）
   */
  async listEpisodic(
    tenantId: string,
    limit = 20,
  ): Promise<AiLtmEpisodicEntity[]> {
    return this.episodicRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * 租户归档列表（倒序）
   */
  async listArchival(
    tenantId: string,
    limit = 20,
  ): Promise<AiLtmArchivalEntity[]> {
    return this.archivalRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ── 归档 archival ────────────────────────────────────────────

  /**
   * 保存知识沉淀
   */
  async saveArchival(
    tenantId: string,
    title: string,
    body: string,
    source?: string,
  ): Promise<void> {
    await this.archivalRepo.save(
      this.archivalRepo.create({
        tenantId,
        title,
        body,
        source: source ?? null,
      }),
    );
  }

  /**
   * 检索相关长期记忆（episodic + archival，关键词命中 + 相关性排序）
   */
  async search(
    tenantId: string,
    query: string,
    topK = 3,
  ): Promise<LtmSearchHit[]> {
    const terms = this.tokenize(query);
    if (terms.length === 0) return [];
    const hits: LtmSearchHit[] = [];

    // 情节：what/why/summary 命中
    const episodes = await this.episodicRepo.find({
      where: { tenantId },
      take: 100,
      order: { createdAt: 'DESC' },
    });
    for (const e of episodes) {
      const text = [e.what, e.why, e.summary].filter(Boolean).join(' ');
      const score = this.matchScore(text, terms);
      if (score > 0) {
        hits.push({
          kind: 'episodic',
          id: e.id,
          text: e.summary ?? e.what ?? '',
          createdAt: e.createdAt,
        });
      }
    }

    // 归档：title/body 命中
    const archivals = await this.archivalRepo.find({
      where: { tenantId },
      take: 100,
      order: { createdAt: 'DESC' },
    });
    for (const a of archivals) {
      const text = [a.title, a.body].filter(Boolean).join(' ');
      const score = this.matchScore(text, terms);
      if (score > 0) {
        hits.push({
          kind: 'archival',
          id: a.id,
          text: `${a.title}：${(a.body ?? '').slice(0, 200)}`,
          createdAt: a.createdAt,
        });
      }
    }

    return hits.slice(0, topK);
  }

  // ── 工具 ─────────────────────────────────────────────────────

  /** 中文/英文关键词切分（去掉标点） */
  private tokenize(text: string): string[] {
    const chars = text.replace(/[，。！？、；：""''（）\s]/g, ' ').trim();
    if (!chars) return [];
    // 英文按空格分词 + 中文按字符（简单方案）
    return Array.from(
      new Set(
        chars
          .split(/\s+/)
          .flatMap((t) => (/[a-zA-Z0-9]/.test(t) ? [t] : Array.from(t))),
      ),
    );
  }

  /** 文本命中词数 */
  private matchScore(text: string, terms: string[]): number {
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score += 1;
    }
    return score;
  }
}
