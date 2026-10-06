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
 * - POST /api/admin/ai-db/versions/:id/auto-close E5 自动闭环（评测+按总台策略自动激活/拦截）
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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin-auth.guard';
import {
  resolveAdminTenantId,
  resolveOptionalAdminTenantId,
} from '../tenant/admin-tenant-scope';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CaptureService } from '../evolution/capture.service';
import { AggregatorService } from '../evolution/aggregator.service';
import { ExperienceExtractorService } from '../evolution/experience-extractor.service';
import { EvolutionVersionService } from '../evolution/evolution-version.service';
import { E4DistillationService } from '../evolution/e4-distillation.service';
import { TenantContext } from '../tenant/tenant-context';
import { StructuredExtractor } from '../brain/extraction/structured-extractor';

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
    private readonly structuredExtractor: StructuredExtractor,
    private readonly e4: E4DistillationService,
    private readonly tenantContext: TenantContext,
  ) {}

  // ── 样本读取（2026-10-04 一并收口）────────────────────────────
  // 同型问题（报告未列，审查时发现）：这三个列表端点此前直接把查询参数
  // tenantId 透给服务层 —— 商户身份不传租户即返回**全部租户**的样本
  // （比越权读更糟，等于一份跨租户语料全量导出）。现：商户锁本租户，
  // 平台不传才表示"查全部"（传了就按指定租户过滤）。

  /** 经验样本列表 */
  @Get('experiences')
  listExperiences(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listExperiences(
      resolveOptionalAdminTenantId(req, tenantId),
      Number(limit) || 50,
    );
  }

  /** 纠正样本列表 */
  @Get('corrections')
  listCorrections(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listCorrections(
      resolveOptionalAdminTenantId(req, tenantId),
      Number(limit) || 50,
    );
  }

  /** 训练样本池列表 */
  @Get('samples')
  listSamples(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit = '50',
  ) {
    return this.capture.listSamples(
      resolveOptionalAdminTenantId(req, tenantId),
      Number(limit) || 50,
    );
  }

  /** 手动提交纠正（审核驳回/人工补正入口） */
  @Post('corrections')
  createCorrection(@Req() req: Request, @Body() dto: CreateCorrectionDto) {
    // tenantId 此前取请求体自报，商户可把纠正样本写进任意租户的样本池
    // （污染他人训练数据）。现按 JWT 身份收口。
    return this.capture.captureCorrection({
      tenantId: resolveAdminTenantId(req, dto.tenantId),
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

  /**
   * E5 自动闭环（评测 + 按总台策略自动激活/拦截）
   *
   * body.cases 缺省时自动从 ai_db 样本池拉取（taskType=版本 artifact、quality≥3、最新 20 条）。
   * 策略：t_platform_ai_config.evolution_auto_activate=1 时达标自动激活/未达标自动拦截；默认人工放行。
   */
  @Post('versions/:id/auto-close')
  async autoCloseVersion(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: {
      cases?: Array<{ prompt: string; completion: string }>;
      actor?: string;
      tenantId?: string;
    },
  ) {
    // E5 评测的抽取调用需租户上下文（aiConfig 解析），而管理路由不在
    // TenantMiddleware 覆盖内 —— 此前用 `getData()?.tenantId ?? 'default'`
    // 导致**真实租户永远取不到**（一律 'default'，评测按平台默认配置跑，
    // 结论对真实租户无效）。现改为从 AdminGuard 挂载的 JWT 身份解析：
    // 商户锁本租户、平台须显式指定目标租户（见 admin-tenant-scope.ts）。
    const tenantId = resolveAdminTenantId(req, dto.tenantId);
    return await this.tenantContext.run({ tenantId, userId: 'e5-eval' }, () =>
      this.versions.runAutoClosure(id, {
        extract: async (docType, utterance) =>
          await this.structuredExtractor.extract({ docType, utterance }),
        cases: dto.cases,
        actor: dto.actor,
      }),
    );
  }

  /** 触发萃取（纠正→staged 版本提案） */
  @Post('extract')
  extract(@Body() dto: { taskType?: string; limit?: number }) {
    return this.extractor.extract(dto.taskType, dto.limit ?? 20);
  }

  /** E4 提示词蒸馏：达标样本 → Ollama 专用模型（force 可跳过就绪门控） */
  @Post('e4/train')
  async e4Train(
    @Req() req: Request,
    @Body()
    dto: {
      taskType: string;
      force?: boolean;
      baseModel?: string;
      /** P1 修复（2026-10-04）：平台身份的目标租户——此前三端点没有
       * 任何传租户的通道，平台身份恒 400 死锁；商户传了也会被锁回本租户 */
      tenantId?: string;
    },
  ) {
    // 租户从 JWT 身份解析（此前 `getData()?.tenantId ?? 'default'` 在管理路由下
    // 恒为 'default'：真实租户的样本永远训练不到，且多租户会共用一份 'default'
    // 样本池互相污染）。商户锁本租户，平台须显式指定目标租户。
    const tenantId = resolveAdminTenantId(req, dto.tenantId);
    return this.e4.train(dto.taskType ?? '', {
      force: dto.force ?? false,
      baseModel: dto.baseModel,
      tenantId,
    });
  }

  /** E4 就绪度看板（各 taskType 的 quality≥4 样本量/平均质量/是否达训练阈值） */
  @Get('e4/readiness')
  e4Readiness(@Req() req: Request, @Query('tenantId') tenantId?: string) {
    return this.e4.readiness(resolveAdminTenantId(req, tenantId));
  }

  /** E4 训练集导出（JSONL messages 格式，quality≥4，供离线微调管线） */
  @Get('e4/dataset')
  e4Dataset(
    @Req() req: Request,
    @Query('taskType') taskType: string,
    @Query('limit') limit?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.e4.exportDataset(
      taskType ?? '',
      limit ? Number(limit) : 500,
      resolveAdminTenantId(req, tenantId),
    );
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
