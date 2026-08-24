/**
 * EvolutionVersionService — 反哺层版本化（P1-1，E3）
 *
 * 依据：权威文档 26.2/26.4/26.6——Schema/模板/话术校准版本化、
 * 可回滚、不静默改红线（人工确认 staged→active）。
 *
 * 反哺落地机制（文档 26.2）：
 * - 内容本体存于代码常量（如 write-schema-registry.ts）；
 * - ai_evolution_version 仅记录 artifact + from/to 版本号 + 变更摘要，
 *   作为可回滚的版本指针；
 * - 自动学习生成的版本默认 staged，人工确认后才 active（不静默改红线）；
 * - 回滚按版本号定位代码常量还原（DB 不重复存放大段内容）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiEvolutionVersionEntity } from '../database/entities/ai-evolution-version.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/** 版本触发方式 */
export type EvolutionTrigger = 'auto_learn' | 'manual';
/** 版本状态 */
export type EvolutionVersionStatus = 'staged' | 'active' | 'rolled_back';

/** 版本提案输入 */
export interface StageVersionInput {
  /** 制品（如 write_schema.customer_create） */
  artifact: string;
  /** 变更前版本 */
  fromVersion?: string;
  /** 变更后版本 */
  toVersion: string;
  /** 变更摘要 */
  changeSummary?: string;
  /** 触发方式 */
  trigger?: EvolutionTrigger;
}

@Injectable()
export class EvolutionVersionService {
  private readonly logger = new Logger(EvolutionVersionService.name);

  constructor(
    @InjectRepository(AiEvolutionVersionEntity, AI_DB_CONNECTION)
    private readonly repo: Repository<AiEvolutionVersionEntity>,
  ) {}

  /**
   * 生成 staged 版本提案（自动学习产物，待人工确认）
   */
  async stage(input: StageVersionInput): Promise<AiEvolutionVersionEntity> {
    const entity = this.repo.create({
      artifact: input.artifact,
      fromVersion: input.fromVersion ?? null,
      toVersion: input.toVersion,
      changeSummary: input.changeSummary ?? null,
      trigger: input.trigger ?? 'auto_learn',
      status: 'staged',
      approvedBy: null,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `版本提案已生成（staged）：artifact=${input.artifact} ${input.fromVersion ?? '-'}→${input.toVersion}`,
    );
    return saved;
  }

  /**
   * 人工确认激活：staged → active
   */
  async activate(
    id: number,
    approver: string,
  ): Promise<AiEvolutionVersionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['staged']);
    entity.status = 'active';
    entity.approvedBy = approver;
    await this.repo.save(entity);
    this.logger.log(
      `版本已激活：id=${id} artifact=${entity.artifact} approver=${approver}`,
    );
    return entity;
  }

  /**
   * 回滚：active → rolled_back（按版本指针还原代码常量，发布流程落盘）
   */
  async rollback(
    id: number,
    reviewer: string,
  ): Promise<AiEvolutionVersionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['active']);
    entity.status = 'rolled_back';
    entity.approvedBy = reviewer;
    await this.repo.save(entity);
    this.logger.warn(
      `版本已回滚：id=${id} artifact=${entity.artifact} 还原至 ${entity.fromVersion ?? '上一版本'}`,
    );
    return entity;
  }

  /**
   * 版本列表（按制品/状态过滤）
   */
  async list(
    artifact?: string,
    status?: string,
  ): Promise<AiEvolutionVersionEntity[]> {
    const qb = this.repo.createQueryBuilder('v').orderBy('v.id', 'DESC');
    if (artifact) {
      qb.where('v.artifact = :artifact', { artifact });
    }
    if (status) {
      qb.andWhere('v.status = :status', { status });
    }
    return qb.getMany();
  }

  /**
   * 当前 active 版本号（供回滚定位/展示）
   */
  async currentVersion(artifact: string): Promise<string | null> {
    const active = await this.repo.findOne({
      where: { artifact, status: 'active' },
      order: { id: 'DESC' },
    });
    return active?.toVersion ?? null;
  }

  private async getOrThrow(id: number): Promise<AiEvolutionVersionEntity> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`进化版本不存在：id=${id}`);
    }
    return entity;
  }

  private assertStatus(
    entity: AiEvolutionVersionEntity,
    allowed: string[],
  ): void {
    if (!allowed.includes(entity.status)) {
      throw new ConflictException(
        `版本状态为 ${entity.status}，仅 ${allowed.join('/')} 可操作`,
      );
    }
  }
}
