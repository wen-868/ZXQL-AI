/**
 * WriteGuard DTO — 写全审核令牌统一确认接口（P0-1）
 *
 * 对应端点：POST /api/ai/agent/confirm
 * 请求体：{ token, action: 'confirm'|'cancel', remark? }
 *
 * 校验使用 class-validator（与 ChatDto 一致）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** 写审核令牌动作 */
export const WRITE_GUARD_ACTIONS = ['confirm', 'cancel'] as const;
export type WriteGuardAction = (typeof WRITE_GUARD_ACTIONS)[number];

/** WriteGuard 统一确认请求 */
export class WriteGuardActionDto {
  /** 写审核令牌（由 SSE tool_result.confirmationId 下发） */
  @IsString()
  @IsNotEmpty({ message: 'token 不能为空' })
  token!: string;

  /** 动作：confirm=确认执行（高危写需二次确认）/ cancel=取消 */
  @IsIn(WRITE_GUARD_ACTIONS, {
    message: 'action 仅支持 confirm 或 cancel',
  })
  action!: WriteGuardAction;

  /** 执行备注（可选，透传工具） */
  @IsOptional()
  @IsString()
  remark?: string;
}
