/**
 * 主动能力管理接口
 *
 * 端点列表：
 * - GET  /api/admin/proactive/jobs             — 列出全部巡检任务及运行状态
 * - POST /api/admin/proactive/jobs/:name/run   — 手动触发单个巡检任务（全部启用租户）
 *
 * 用途：
 * - 工作台查看 AI 主动服务调度情况（调度表达式/优先级/最近运行结果）
 * - 手动触发巡检用于验收验证（如"库存低于安全线自动推送预警"）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import {
  Controller,
  Get,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../tenant/admin-auth.guard';
import { ProactiveService } from './proactive.service';
import { ProactiveJobInfo, ProactiveTaskResult } from './proactive.types';

@UseGuards(AdminGuard)
@Controller('admin/proactive')
export class ProactiveController {
  private readonly logger = new Logger(ProactiveController.name);

  constructor(private readonly proactiveService: ProactiveService) {}

  /**
   * 列出全部巡检任务及运行状态
   *
   * GET /api/admin/proactive/jobs
   */
  @Get('jobs')
  listJobs(): { total: number; jobs: ProactiveJobInfo[] } {
    const jobs = this.proactiveService.listJobs();
    this.logger.log(`收到 proactive/jobs 请求，返回 ${jobs.length} 个巡检任务`);
    return { total: jobs.length, jobs };
  }

  /**
   * 手动触发单个巡检任务（对全部启用租户执行）
   *
   * POST /api/admin/proactive/jobs/:name/run
   *
   * @param name 任务名（如 inventory_warning）
   * @throws NotFoundException 任务不存在
   */
  @Post('jobs/:name/run')
  async runJob(
    @Param('name') name: string,
  ): Promise<{ job: ProactiveJobInfo; results: ProactiveTaskResult[] }> {
    this.logger.log(`收到 proactive/jobs/${name}/run 请求，开始手动巡检`);
    return this.proactiveService.runJob(name);
  }
}
