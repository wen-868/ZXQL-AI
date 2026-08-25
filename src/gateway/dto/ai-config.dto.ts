/**
 * AI 配置管理 API 的 DTO 定义
 *
 * 说明：ValidationPipe 开启 whitelist + forbidNonWhitelisted，
 * 请求体中的未知字段会被拒绝，因此 DTO 必须声明全部可接受字段。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** 更新平台默认配置 */
export class UpdatePlatformAiConfigDto {
  @IsOptional()
  @IsString()
  defaultProvider?: string;

  @IsOptional()
  @IsString()
  defaultModel?: string;

  /** 新 API Key（非空则加密存储；空字符串表示不改动） */
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  defaultEndpoint?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  defaultTemperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultMaxTokens?: number;

  @IsOptional()
  @IsString()
  defaultSystemPrompt?: string;

  /** 本地 Ollama 兜底开关（P1-3：0=关闭 1=开启，默认开启） */
  @IsOptional()
  @IsIn([0, 1])
  ollamaFallbackEnabled?: number;
}

/** 更新租户 AI 配置 */
export class UpdateTenantAiConfigDto {
  @IsOptional()
  @IsIn([0, 1])
  enabled?: number;

  @IsOptional()
  @IsString()
  provider?: string;

  /** 新 API Key（非空则加密存储；空字符串表示不改动） */
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  apiEndpoint?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTokens?: number;

  @IsOptional()
  @IsString()
  systemPrompt?: string;
}

/** 更新租户计费套餐 */
export class UpdateTenantBillingDto {
  @IsOptional()
  @IsIn(['pay_as_you_go', 'monthly', 'prepaid'])
  planType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  freeChatCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  freeTokenLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  overagePrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyChatLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyTokenLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monthlyPrice?: number;

  @IsOptional()
  @IsIn([0, 1])
  enabled?: number;
}
