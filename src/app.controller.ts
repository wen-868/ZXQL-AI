import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import { ReadinessService } from './ops/readiness.service';
import type { ReadinessReport } from './ops/readiness.service';

/**
 * 应用基础控制器
 *
 * 提供健康检查端点。
 * AI 业务接口（/api/admin/ai/chat、/api/platform/ai/*）将在 R70-06 Gateway 任务中实现。
 *
 * 健康检查分两级（2026-10-03）：
 * - `GET /api/health`       存活探针：只证明**进程活着**（历史行为，保持不变以免影响现有监控与 pm2 判定）
 * - `GET /api/health/ready` 就绪探针：额外校验**数据库表结构与代码期望是否一致**，
 *   用来发现"部署完成但迁移没跑"这类静默故障（详见 migrations/README.md 第六、七节）
 */
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly readinessService: ReadinessService,
  ) {}

  /**
   * 健康检查（存活）
   * @returns 服务状态
   */
  @Get('health')
  getHealth(): { status: string; service: string; timestamp: string } {
    return this.appService.getHealth();
  }

  /**
   * 就绪探针（存活 + 数据库结构）
   *
   * GET /api/health/ready
   *
   * 语义：
   * - `ready`    实体声明的表/列在数据库中全部就位
   * - `degraded` 有缺失的表/列，或数据库不可达（附缺失清单与修复指引）
   *
   * **恒返 HTTP 200**：`degraded` 时返回 5xx 会被容器编排/pm2 判为进程故障并重启，
   * 而重启补不上缺失的列，只会把"数据层不完整"放大成"服务不可用"。
   * 调用方请读 `status` 字段或 `X-AI-Readiness` 响应头，不要只看 HTTP 状态码。
   */
  @Get('health/ready')
  @Header('Cache-Control', 'no-store')
  async getReady(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessReport> {
    const report = await this.readinessService.check();
    res.setHeader('X-AI-Readiness', report.status);
    return report;
  }
}
