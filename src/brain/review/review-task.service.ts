/**
 * ReviewTaskService — AI 待审工单（完善度 P0-4 人工确认闸）
 *
 * 职责：
 * 1. 高危工具/图节点命中审核点时创建待审工单（t_ai_review_task）
 * 2. 审核状态机：pending → approved / rejected（对接现有审核流程）
 * 3. 供图执行器查询审核结果，审批通过后续跑、驳回则终止
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-4 人工确认闸对接审核流程
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiReviewTaskEntity } from '../../database/entities/ai-review-task.entity';

/** 待审工单创建载荷 */
export interface CreateReviewTaskInput {
  tenantId: string;
  sessionId?: string;
  graphId?: string;
  nodeId?: string;
  toolName?: string;
  payload?: Record<string, unknown>;
  createdBy?: string;
}

/** 待审工单对外视图 */
export interface ReviewTaskView {
  id: number;
  tenantId: string;
  sessionId: string | null;
  graphId: string | null;
  nodeId: string | null;
  toolName: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  rejectReason: string | null;
  createdBy: string | null;
  reviewedBy: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

@Injectable()
export class ReviewTaskService {
  private readonly logger = new Logger(ReviewTaskService.name);

  constructor(
    @InjectRepository(AiReviewTaskEntity)
    private readonly repo: Repository<AiReviewTaskEntity>,
  ) {}

  /**
   * 创建待审工单
   */
  async create(input: CreateReviewTaskInput): Promise<ReviewTaskView> {
    const entity = this.repo.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId ?? null,
      graphId: input.graphId ?? null,
      nodeId: input.nodeId ?? null,
      toolName: input.toolName ?? null,
      payload: input.payload ?? null,
      status: 'pending',
      createdBy: input.createdBy ?? null,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `待审工单已创建：id=${saved.id} tenant=${saved.tenantId} tool=${saved.toolName ?? '-'} node=${saved.nodeId ?? '-'}`,
    );
    return this.toView(saved);
  }

  /**
   * 查询待审工单（租户 + 状态过滤）
   */
  async list(tenantId: string, status?: string): Promise<ReviewTaskView[]> {
    const where: { tenantId: string; status?: string } = { tenantId };
    if (status) where.status = status;
    const rows = await this.repo.find({
      where,
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * 查询单条工单
   */
  async get(id: number): Promise<ReviewTaskView> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`待审工单不存在：id=${id}`);
    }
    return this.toView(entity);
  }

  /**
   * 审核通过（仅 pending 可批准）
   */
  async approve(id: number, reviewer: string): Promise<ReviewTaskView> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`待审工单不存在：id=${id}`);
    }
    if (entity.status !== 'pending') {
      throw new ConflictException(
        `工单状态为 ${entity.status}，仅 pending 可审核`,
      );
    }
    entity.status = 'approved';
    entity.reviewedBy = reviewer;
    entity.reviewedAt = new Date();
    await this.repo.save(entity);
    this.logger.log(`待审工单已批准：id=${id} reviewer=${reviewer}`);
    return this.toView(entity);
  }

  /**
   * 审核驳回（仅 pending 可驳回）
   */
  async reject(
    id: number,
    reviewer: string,
    reason: string,
  ): Promise<ReviewTaskView> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`待审工单不存在：id=${id}`);
    }
    if (entity.status !== 'pending') {
      throw new ConflictException(
        `工单状态为 ${entity.status}，仅 pending 可审核`,
      );
    }
    entity.status = 'rejected';
    entity.reviewedBy = reviewer;
    entity.rejectReason = reason || null;
    entity.reviewedAt = new Date();
    await this.repo.save(entity);
    this.logger.log(
      `待审工单已驳回：id=${id} reviewer=${reviewer} reason=${reason}`,
    );
    return this.toView(entity);
  }

  private toView(r: AiReviewTaskEntity): ReviewTaskView {
    return {
      id: r.id,
      tenantId: r.tenantId,
      sessionId: r.sessionId,
      graphId: r.graphId,
      nodeId: r.nodeId,
      toolName: r.toolName,
      payload: r.payload,
      status: r.status,
      rejectReason: r.rejectReason,
      createdBy: r.createdBy,
      reviewedBy: r.reviewedBy,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
    };
  }
}
