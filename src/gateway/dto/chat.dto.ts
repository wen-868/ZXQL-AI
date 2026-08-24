/**
 * 对话请求 DTO
 *
 * 用于 POST /api/chat 端点，接收用户消息并返回 SSE 流式响应。
 *
 * 当前阶段（R70-06）：tenantId 由请求体传入（测试用）。
 * R70-07 多租户接入后：tenantId 从 JWT 解析（TenantGuard 注入），请求体不再需要 tenantId。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import {
  IsIn,
  IsOptional,
  IsString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';

export class ChatDto {
  /** 用户消息内容（必填，最长 4000 字符） */
  @IsString({ message: 'message 必须是字符串' })
  @IsNotEmpty({ message: 'message 不能为空' })
  @MaxLength(4000, { message: 'message 不能超过 4000 字符' })
  message!: string;

  /** 会话 ID（可选，用于关联多轮对话上下文）
   *
   * 传入时：R70-08 Brain Engine 从 Redis 恢复对话历史
   * 不传时：创建新会话
   */
  @IsOptional()
  @IsString()
  conversationId?: string;

  /** 租户 ID（可选，R70-07 后由 JWT 自动解析）
   *
   * R70-07 多租户接入后：tenantId 从 JWT 解析（TenantMiddleware 注入 TenantContext），
   * 请求体不再需要传入。保留为可选字段仅用于过渡兼容（无 JWT 时从 body 读取）。
   */
  @IsOptional()
  @IsString()
  tenantId?: string;

  /** 用户 ID（可选，用于审计日志） */
  @IsOptional()
  @IsString()
  userId?: string;

  /** 用户角色（可选，用于权限校验） */
  @IsOptional()
  @IsString()
  role?: string;

  /** 模型标识（可选，对话级模型切换）
   *
   * 传入已注册的模型标识（内置 glm/deepseek/ollama 或外部模型名）时，
   * 本轮对话使用指定模型；不传则使用租户/平台默认配置。
   */
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'model 不能超过 64 字符' })
  model?: string;

  /** 执行模式（可选）：react=单 Agent 循环（默认）/ graph=有状态图 */
  @IsOptional()
  @IsIn(['react', 'graph'], { message: 'mode 仅支持 react 或 graph' })
  mode?: 'react' | 'graph';

  /** graph 模式下：图 ID（如 sale_create_graph） */
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'graphId 不能超过 64 字符' })
  graphId?: string;

  /** 工具作用域（可选）：mgmt=管理系统租户域（默认）/ platform=总台域
   *
   * 总台对话传 platform 时暴露总台工具（api_platform_*，requirePlatformAuth）；
   * 租户侧默认 mgmt，绝不暴露 platform 工具。
   */
  @IsOptional()
  @IsIn(['mgmt', 'platform'], { message: 'scope 仅支持 mgmt 或 platform' })
  scope?: 'mgmt' | 'platform';

  /** 图片（可选，感知·看）：base64 或 data URL，最大约 15MB
   *
   * 传入时后端调用视觉模型（glm-4v-flash）生成内容描述并入对话上下文；
   * 视觉服务不可用时降级为纯文本对话（图片描述缺失）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(15728640, { message: 'image 数据过大（上限 15MB）' })
  image?: string;
}
