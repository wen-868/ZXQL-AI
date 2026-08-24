/**
 * Confirmation DTO — 写操作确认机制请求/响应 DTO（R70-15）
 *
 * 用途：
 * - ConfirmConfirmationDto：确认执行待确认操作
 * - RevokeOperationDto：撤销已执行操作
 * - PendingConfirmationResponse：待确认记录响应结构
 * - ExecutedOperationResponse：已执行操作响应结构
 *
 * 校验使用 class-validator + class-transformer（与 ChatDto 一致）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import { IsIn, IsOptional, IsString } from 'class-validator';

/** 撤销请求：可选携带撤销原因 */
export class RevokeOperationDto {
  /** 撤销原因（可选） */
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 确认执行请求：可选携带操作备注 */
export class ConfirmConfirmationDto {
  /** 执行备注（可选，透传工具） */
  @IsOptional()
  @IsString()
  remark?: string;
}

/** 待确认记录响应（供前端渲染预览卡片） */
export interface PendingConfirmationResponse {
  confirmationId: string;
  operationLabel: string;
  toolName: string;
  preview?: {
    operation?: string;
    summary?: string;
    details?: Record<string, unknown>;
  };
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'confirmed';
}

/** 已执行操作响应 */
export interface ExecutedOperationResponse {
  operationId: string;
  operationLabel: string;
  toolName: string;
  result?: unknown;
  executedAt: number;
  revokeExpiresAt: number;
  revocable: boolean;
}

/** 确认词识别响应 */
export interface ConfirmIntentResponse {
  isConfirm: boolean;
  isCancel: boolean;
  message: string;
}

/** 状态枚举（供前端约束） */
export const CONFIRMATION_ACTION = ['confirm', 'cancel', 'revoke'] as const;
export type ConfirmationAction = (typeof CONFIRMATION_ACTION)[number];

/** 校验确认动作参数 */
export class ConfirmationActionDto {
  @IsIn(['confirm', 'cancel', 'revoke'])
  action!: ConfirmationAction;
}
