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
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  EXPLICIT_KEY_PATTERN,
  MAX_EXPLICIT_KEY_LENGTH,
  MIN_EXPLICIT_KEY_LENGTH,
} from '../../tools/idempotency-gate.service';

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

  /**
   * 调用方显式幂等键（可选；R101-AI-24）
   *
   * 用途：确认执行时显式声明**业务唯一键**（ERP 单号 / 工单号 / 外部提交 id），
   * 使「同一业务操作被重复确认/重发」回放首次结果而不是重复落单。
   * 规则：8~128 字符、字母数字开头、仅 `A-Z a-z 0-9 . _ : -`（与闸门共用同一正则，唯一真源）。
   * 不传 ⇒ 该次确认执行按「确认令牌 → 业务参数指纹」自动取键，行为与接线前完全一致。
   * 非法/超长 ⇒ 400（本 DTO）或闸门明确拒绝（内部调用方），绝不静默忽略。
   */
  @IsOptional()
  @IsString()
  @Matches(EXPLICIT_KEY_PATTERN, {
    message: `idempotencyKey 需为 ${MIN_EXPLICIT_KEY_LENGTH}~${MAX_EXPLICIT_KEY_LENGTH} 字符、字母数字开头，仅可用 A-Z a-z 0-9 . _ : -`,
  })
  idempotencyKey?: string;
}
