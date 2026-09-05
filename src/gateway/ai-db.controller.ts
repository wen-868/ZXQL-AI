/**
 * AiDbController — ai_db 认知闭环管理 API（P1-1）
 *
 * 端点（全局前缀 /api，总台/管理员）：
 * - GET  /api/admin/ai-db/experiences       经验样本列表
 * - GET  /api/admin/ai-db/corrections       纠正样本列表
 * - GET  /api/admin/ai-db/samples           训练样本池列表
 * - POST /api/admin/ai-db/corrections       手动提交纠正（审核驳回/人工补正）
 * - GET  /api/admin/ai-db/versions          进化版本列表
 * - POST /api/admin/ai-db/versions/:id/activate   人工确认激活（staged→active）
 * - POST /api/admin/ai-db/versions/:id/rollback   一键回滚（active→rolled_back）
 * - POST /api/admin/ai-db/extract           触发萃取（纠正→版本提案）
 * - POST /api/admin/ai-db/aggregate         触发跨租户聚合（脱敏公共模式）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CaptureService } from '../evolution/capture.service';
import { AggregatorService } from '../evolution/aggregator.service';
import { ExperienceExtractorService } from '../evolution/experience-extractor.service';
import { EvolutionVersionService } from '../evolution/evolution-version.service';

/** 手动提交纠正 */
export class CreateCorrectionDto {
  @IsString()
  @IsNotEmpty({ message: 'tenantId 不能为空' })
  tenantId!: string;

  @IsString()
  @IsNotEmpty({ message: 'taskType 不能为空' })
  taskType!: string;

  @IsOptional()
  wrongPayload?: Record<string, unknown>;

  @IsOptional()
  rightPayload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  reason?: string;
}

@UseGuards(AdminGuard)
@Controller('admin/ai-db')
export class AiDbController {
  constructor(
    private readonly capture: CaptureService,
    private readonly extractor: ExperienceExtractorService,
    private readonly aggregator: AggregatorService,
    private readonly versions: EvolutionVersionService,
  ) {}

  /** 经验样本列表 */
  @Get('experiences')
  listExperiences(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listExperiences(tenantId, Number(limit) || 50);
  }

  /** 纠正样本列表 */
  @Get('corrections')
  listCorrections(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listCorrections(tenantId, Number(limit) || 50);
  }

  /** 训练样本池列表 */
  @Get('samples')
  listSamples(
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listSamples(tenantId, Number(limit) || 50);
  }

  /** 手动提交纠正（审核驳回/人工补正入口） */
  @Post('corrections')
  createCorrection(@Body() dto: CreateCorrectionDto) {
    return this.capture.captureCorrection({
      tenantId: dto.tenantId,
      taskType: dto.taskType,
      wrongPayload: dto.wrongPayload,
      rightPayload: dto.rightPayload,
      reason: dto.reason,
    });
  }

  /** 进化版本列表 */
  @Get('versions')
  listVersions(
    @Query('artifact') artifact?: string,
    @Query('status') status?: string,
  ) {
    return this.versions.list(artifact, status);
  }

  /** 人工确认激活（staged→active） */
  @Post('versions/:id/activate')
  activateVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { approver?: string },
  ) {
    return this.versions.activate(id, dto.approver ?? 'admin');
  }

  /** 一键回滚（active→rolled_back） */
  @Post('versions/:id/rollback')
  rollbackVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ) {
    return this.versions.rollback(id, dto.reviewer ?? 'admin');
  }

  /** 触发萃取（纠正→staged 版本提案） */
  @Post('extract')
  extract(@Body() dto: { taskType?: string; limit?: number }) {
    return this.extractor.extract(dto.taskType, dto.limit ?? 20);
  }

  /** 触发跨租户聚合（脱敏公共模式） */
  @Post('aggregate')
  aggregate(@Body() dto: { taskType?: string; limit?: number }) {
    if (dto.taskType) {
      return this.aggregator.aggregateByTaskType(
        dto.taskType,
        dto.limit ?? 100,
      );
    }
    return this.aggregator.aggregateAll(dto.limit ?? 100);
  }
}
