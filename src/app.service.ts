import { Injectable } from '@nestjs/common';

/**
 * 应用基础服务
 *
 * 提供健康检查等基础能力。
 * 后续业务能力由各业务模块（gateway/brain/tools 等）提供。
 */
@Injectable()
export class AppService {
  /**
   * 健康检查
   * @returns 服务状态信息
   */
  getHealth(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'zhixiang-ai-base',
      timestamp: new Date().toISOString(),
    };
  }
}
