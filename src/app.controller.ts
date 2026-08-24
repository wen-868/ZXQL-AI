import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

/**
 * 应用基础控制器
 *
 * 提供健康检查端点。
 * AI 业务接口（/api/admin/ai/chat、/api/platform/ai/*）将在 R70-06 Gateway 任务中实现。
 */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * 健康检查
   * @returns 服务状态
   */
  @Get('health')
  getHealth(): { status: string; service: string; timestamp: string } {
    return this.appService.getHealth();
  }
}
