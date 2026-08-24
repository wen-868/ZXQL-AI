import {
  IsObject,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 工具执行上下文 DTO（嵌套在 ExecuteToolDto 中）
 *
 * tenantId 必填（多租户隔离兜底），其他字段可选。
 */
export class ToolContextDto {
  /** 租户 ID（必填） */
  @IsString({ message: 'tenantId 必须是字符串' })
  @IsNotEmpty({ message: 'tenantId 不能为空' })
  tenantId!: string;

  /** 当前用户 ID（可选） */
  @IsOptional()
  @IsString()
  userId?: string;

  /** 会话 ID（可选） */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** 请求追踪 ID（可选） */
  @IsOptional()
  @IsString()
  requestId?: string;

  /** 用户角色（可选） */
  @IsOptional()
  @IsString()
  role?: string;
}

/**
 * 工具执行请求 DTO（R70-04 验收用，R70-06 将被正式接口替代）
 *
 * 用于 POST /api/admin/tools/execute 端点，手动触发工具执行以验证 Tool 系统。
 *
 * 示例请求体：
 * {
 *   "name": "echo",
 *   "args": { "message": "你好" },
 *   "context": { "tenantId": "test-tenant", "userId": "u1" }
 * }
 */
export class ExecuteToolDto {
  /** 工具名称（须与 ToolRegistry 中已注册的工具名一致） */
  @IsString({ message: 'name 必须是字符串' })
  @IsNotEmpty({ message: 'name 不能为空' })
  name!: string;

  /** 工具参数对象（键值对，具体字段由工具的 parameters JSON Schema 约束） */
  @IsObject({ message: 'args 必须是对象' })
  args!: Record<string, unknown>;

  /** 执行上下文（含 tenantId 等） */
  @ValidateNested()
  @Type(() => ToolContextDto)
  context!: ToolContextDto;
}
