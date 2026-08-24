/**
 * EvolutionService — 自主进化（完善度 P3 认知层 SE，门控）
 *
 * 状态机：proposed → review（复用待审工单）→ gray（灰度）→ rolled_out / rejected / rolled_back
 *
 * 进化对象：
 * - prompt：审核通过 → 更新租户 system_prompt（AiConfigAdminService）
 * - newtool：审核通过 → 生成并注册动态工具（仅包装既有 /api/ 后端端点）
 * - tool / graph：支持记录与状态机，但自动应用需人工部署（rolled_out 时返回提示）
 *
 * 安全边界（强制）：
 * - 全部按 tenantId 隔离，不跨租户
 * - 无免审路径：所有进化必经 review 工单
 * - newtool 仅允许 /api/ 前缀（既有后端 API），risk 不得为 low（新建默认保守）
 * - current_snapshot 保证一键回滚
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P3 自主进化（门控）
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiEvolutionEntity } from '../../database/entities/ai-evolution.entity';
import { AiConfigAdminService } from '../../tenant/ai-config-admin.service';
import { ReviewTaskService } from '../review/review-task.service';
import { ToolGeneratorService } from '../../tools/catalog/tool-generator.service';
import { ToolRegistry } from '../../tools/tool-registry';
import { ApiRouteDef } from '../../tools/catalog/api-catalog';

/** 进化目标 */
export type EvolutionTarget = 'prompt' | 'tool' | 'graph' | 'newtool';

/** 提案输入 */
export interface ProposalInput {
  tenantId: string;
  target: EvolutionTarget;
  currentSnapshot?: string;
  proposed: string;
  rationale?: string;
  proposedBy?: string;
}

const TARGETS: EvolutionTarget[] = ['prompt', 'tool', 'graph', 'newtool'];

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);
  private readonly defaultGrayPercent: number;

  constructor(
    @InjectRepository(AiEvolutionEntity)
    private readonly repo: Repository<AiEvolutionEntity>,
    private readonly reviewTask: ReviewTaskService,
    private readonly aiConfigAdmin: AiConfigAdminService,
    private readonly toolGenerator: ToolGeneratorService,
    private readonly registry: ToolRegistry,
    configService: ConfigService,
  ) {
    this.defaultGrayPercent =
      Number(configService.get<string>('EVOLUTION_GRAY_PERCENT', '20')) || 20;
  }

  /**
   * 提出进化提案（proposed → 自动创建审核工单）
   */
  async propose(input: ProposalInput): Promise<AiEvolutionEntity> {
    if (!TARGETS.includes(input.target)) {
      throw new ConflictException(`不支持的进化目标：${input.target}`);
    }
    // 安全边界：newtool 仅允许既有 /api/ 后端端点，risk 不得为 low
    if (input.target === 'newtool') {
      const def = this.parseNewTool(input.proposed);
      if (!def.path.startsWith('/api/')) {
        throw new ConflictException('newtool 仅允许包装既有 /api/ 后端端点');
      }
      if (def.risk === 'low') {
        throw new ConflictException('新建工具风险不得为 low（默认保守）');
      }
    }

    const version =
      (await this.repo.count({ where: { tenantId: input.tenantId } })) + 1;
    const entity = this.repo.create({
      tenantId: input.tenantId,
      target: input.target,
      version,
      status: 'proposed',
      currentSnapshot: input.currentSnapshot ?? null,
      proposedDiff: input.proposed,
      rationale: input.rationale ?? null,
      proposedBy: input.proposedBy ?? null,
      grayPercent: 0,
    });
    const saved = await this.repo.save(entity);

    // 自动创建审核工单（复用 P0-4 ReviewTask，无免审路径）
    const review = await this.reviewTask.create({
      tenantId: input.tenantId,
      toolName: `evolution:${input.target}`,
      nodeId: `evolution_${saved.id}`,
      payload: {
        evolutionId: saved.id,
        target: input.target,
        rationale: input.rationale,
        proposed: input.proposed.slice(0, 1000),
      },
      createdBy: input.proposedBy,
    });
    saved.reviewId = review.id;
    await this.repo.save(saved);

    this.logger.log(
      `进化提案已提交：id=${saved.id} tenant=${input.tenantId} target=${input.target} review=${review.id}`,
    );
    return saved;
  }

  /**
   * 审核通过：proposed → gray（灰度，比例可配）
   */
  async approve(id: number, reviewer: string): Promise<AiEvolutionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['proposed']);
    entity.status = 'gray';
    entity.grayPercent = this.defaultGrayPercent;
    entity.reviewedBy = reviewer;
    await this.repo.save(entity);
    // 同步审核工单状态
    if (entity.reviewId) {
      await this.reviewTask.approve(entity.reviewId, reviewer);
    }
    this.logger.log(`进化审核通过：id=${id} → gray（${entity.grayPercent}%）`);
    return entity;
  }

  /**
   * 审核驳回：proposed → rejected
   */
  async reject(
    id: number,
    reviewer: string,
    reason: string,
  ): Promise<AiEvolutionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['proposed']);
    entity.status = 'rejected';
    entity.reviewedBy = reviewer;
    await this.repo.save(entity);
    if (entity.reviewId) {
      await this.reviewTask.reject(entity.reviewId, reviewer, reason);
    }
    this.logger.log(`进化审核驳回：id=${id} reason=${reason}`);
    return entity;
  }

  /**
   * 灰度转正式生效：gray → rolled_out（并应用进化）
   */
  async rollout(id: number): Promise<AiEvolutionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['gray']);
    entity.status = 'rolled_out';
    entity.rolledOutAt = new Date();
    await this.repo.save(entity);

    const applyNote = await this.apply(entity);
    if (applyNote) {
      this.logger.log(
        `进化已生效：id=${id} target=${entity.target} ${applyNote}`,
      );
    }
    return entity;
  }

  /**
   * 回滚：rolled_out → rolled_back（快照还原）
   */
  async rollback(id: number, reviewer: string): Promise<AiEvolutionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['rolled_out']);
    await this.revert(entity);
    entity.status = 'rolled_back';
    entity.reviewedBy = reviewer;
    await this.repo.save(entity);
    this.logger.log(`进化已回滚：id=${id} target=${entity.target}`);
    return entity;
  }

  /**
   * 列表（租户内）
   */
  async list(tenantId: string, status?: string): Promise<AiEvolutionEntity[]> {
    const where: { tenantId: string; status?: string } = { tenantId };
    if (status) where.status = status;
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  // ── 应用与回滚 ──────────────────────────────────────────────

  /**
   * 应用进化（prompt 更新租户配置 / newtool 注册动态工具）
   *
   * @returns 应用说明；tool/graph 返回「需人工部署」提示
   */
  private async apply(entity: AiEvolutionEntity): Promise<string | null> {
    switch (entity.target) {
      case 'prompt': {
        await this.aiConfigAdmin.updateTenantConfig(entity.tenantId, {
          enabled: 1,
          systemPrompt: entity.proposedDiff ?? undefined,
        });
        return '租户系统提示词已更新';
      }
      case 'newtool': {
        const def = this.parseNewTool(entity.proposedDiff ?? '');
        this.toolGenerator.generateAndRegister(this.registry, [def]);
        return `动态工具 ${def.name} 已注册`;
      }
      case 'tool':
      case 'graph':
        return '该目标需人工部署（自动应用未支持）';
      default:
        return null;
    }
  }

  /**
   * 回滚进化（prompt 还原快照 / newtool 注销）
   */
  private async revert(entity: AiEvolutionEntity): Promise<void> {
    switch (entity.target) {
      case 'prompt': {
        await this.aiConfigAdmin.updateTenantConfig(entity.tenantId, {
          enabled: 1,
          systemPrompt: entity.currentSnapshot ?? undefined,
        });
        break;
      }
      case 'newtool': {
        const def = this.parseNewTool(entity.proposedDiff ?? '');
        this.registry.unregister(def.name);
        break;
      }
      default:
        break;
    }
  }

  /** 解析 newtool 提案（必须是合法 ApiRouteDef JSON） */
  private parseNewTool(proposed: string): ApiRouteDef {
    try {
      return JSON.parse(proposed) as ApiRouteDef;
    } catch {
      throw new ConflictException('newtool 提案必须是合法的 ApiRouteDef JSON');
    }
  }

  private async getOrThrow(id: number): Promise<AiEvolutionEntity> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`进化提案不存在：id=${id}`);
    }
    return entity;
  }

  private assertStatus(entity: AiEvolutionEntity, allowed: string[]): void {
    if (!allowed.includes(entity.status)) {
      throw new ConflictException(
        `进化状态为 ${entity.status}，仅 ${allowed.join('/')} 可操作`,
      );
    }
  }
}
