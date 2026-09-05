/**
 * CircuitBreakerController — 工具熔断管理 API（P1-3，文档 17.3）
 *
 * 端点：
 * - GET  /api/admin/circuit-breakers         熔断状态列表
 * - POST /api/admin/circuit-breakers/reset   重置全部熔断
 * - POST /api/admin/circuit-breakers/:name/reset  重置指定工具熔断
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { CircuitBreakerService } from '../tools/circuit-breaker.service';

@UseGuards(AdminGuard)
@Controller('admin/circuit-breakers')
export class CircuitBreakerController {
  constructor(private readonly breaker: CircuitBreakerService) {}

  /** 熔断状态列表 */
  @Get()
  list() {
    const list = this.breaker.status();
    return { total: list.length, list };
  }

  /** 重置全部熔断 */
  @Post('reset')
  resetAll() {
    const count = this.breaker.reset();
    return { success: true, message: `已重置 ${count} 个工具熔断` };
  }

  /** 重置指定工具熔断 */
  @Post(':name/reset')
  resetOne(@Param('name') name: string) {
    const count = this.breaker.reset(name);
    return count > 0
      ? { success: true, message: `已重置工具 ${name} 的熔断` }
      : { success: false, message: `工具 ${name} 无熔断记录` };
  }
}
