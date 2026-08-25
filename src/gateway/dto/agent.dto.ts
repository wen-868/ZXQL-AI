/**
 * Agent 自主执行内核 DTO（批次2，文档 22.6）
 *
 * 对应端点：
 * - POST /api/ai/agent/run（SSE 流式自主任务）
 * - POST /api/ai/agent/plan（提交长任务）
 * - POST /api/ai/agent/plans/:id/run（续跑/断点续跑）
 * - POST /api/ai/agent/plans/:id/approve|reject|cancel
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** 发起自主任务（规划 + 执行，SSE） */
export class AgentRunDto {
  /** 用户目标（复合任务描述） */
  @IsString({ message: 'goal 必须是字符串' })
  @IsNotEmpty({ message: 'goal 不能为空' })
  @MaxLength(4000, { message: 'goal 不能超过 4000 字符' })
  goal!: string;

  /** 会话 ID（可选） */
  @IsOptional()
  @IsString()
  conversationId?: string;

  /** 租户 ID（可选，JWT 自动解析后的兼容字段） */
  @IsOptional()
  @IsString()
  tenantId?: string;

  /** 用户 ID（可选） */
  @IsOptional()
  @IsString()
  userId?: string;

  /** 用户角色（可选） */
  @IsOptional()
  @IsString()
  role?: string;

  /** 客户 ID（可选，运营客户端 customerScope 隔离） */
  @IsOptional()
  @IsString()
  customerId?: string;

  /** 对话级模型标识（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  /** 工具作用域：mgmt=租户域（默认）/ platform=总台域 */
  @IsOptional()
  @IsIn(['mgmt', 'platform'], { message: 'scope 仅支持 mgmt 或 platform' })
  scope?: 'mgmt' | 'platform';
}

/** 提交长任务（仅规划，不执行） */
export class AgentPlanDto {
  @IsString({ message: 'goal 必须是字符串' })
  @IsNotEmpty({ message: 'goal 不能为空' })
  @MaxLength(4000, { message: 'goal 不能超过 4000 字符' })
  goal!: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @IsOptional()
  @IsIn(['mgmt', 'platform'])
  scope?: 'mgmt' | 'platform';
}

/** 续跑计划（断点续跑） */
export class AgentResumeDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @IsOptional()
  @IsIn(['mgmt', 'platform'])
  scope?: 'mgmt' | 'platform';
}

/** 计划 ID 路径参数 */
export class PlanIdParamDto {
  @IsInt({ message: 'planId 必须是整数' })
  @Min(1)
  id!: number;
}

/** 人工审批步骤 */
export class ApproveStepDto {
  /** 步骤 ID（计划内唯一） */
  @IsString()
  @IsNotEmpty({ message: 'stepId 不能为空' })
  stepId!: string;
}

/** 人工驳回步骤 */
export class RejectStepDto {
  @IsString()
  @IsNotEmpty({ message: 'stepId 不能为空' })
  stepId!: string;

  /** 驳回原因（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
