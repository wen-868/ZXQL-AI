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
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';

/**
 * 单价小数位校验（≤ 6，与 DECIMAL(12,6) 对齐）
 *
 * ⚠️ 不能用 `@IsNumber({ maxDecimalPlaces: 6 })`：class-validator 0.15 在该选项下
 * 遇到科学计数法（如 `1e-7`）会抛 `TypeError`（`toString().split('.')[1]` 为
 * undefined）⇒ 非法输入变成 500 而不是 400。此处用 `toFixed(6)` 定点比较规避。
 */
function IsPriceScale(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isPriceScale',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return false;
          }
          return Math.abs(value - Number(value.toFixed(6))) < 1e-9;
        },
      },
    });
  };
}

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

  /** E5 自治开关（迁移 007：1=回归达标自动激活/未达标自动拦截 0=人工放行，默认） */
  @IsOptional()
  @IsIn([0, 1])
  evolutionAutoActivate?: number;
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

/** 新增 / 调价 AI 模型单价（R101-AI-09；平台身份专属） */
export class UpsertModelPriceDto {
  /** AI 服务商（与 t_ai_usage_daily.provider 同口径；外部模型用其注册标识） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  provider!: string;

  /** 模型名（精确匹配，不使用通配） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  model!: string;

  /**
   * 输入单价（元/千Token）
   *
   * 允许**显式 0**（免费档），禁止负数；非 0 时最小 `0.000001` 元/千Token
   * （更小的值在 `DECIMAL(12,6)` 下会被静默舍入成 0，且科学计数法会绕过
   * `maxDecimalPlaces` 判定）；小数位不超过 6（与 DECIMAL(12,6) 对齐）。
   */
  @Type(() => Number)
  @IsNumber()
  @IsPriceScale()
  @ValidateIf((o: UpsertModelPriceDto) => o.promptPrice !== 0)
  @Min(0.000001)
  @Max(999999.999999)
  promptPrice!: number;

  /**
   * 输出单价（元/千Token）
   *
   * 规则同 `promptPrice`：显式 0（免费档）/ 禁止负数 / 非 0 时 ≥ 0.000001。
   */
  @Type(() => Number)
  @IsNumber()
  @IsPriceScale()
  @ValidateIf((o: UpsertModelPriceDto) => o.completionPrice !== 0)
  @Min(0.000001)
  @Max(999999.999999)
  completionPrice!: number;

  /** 币种（ISO 4217 三字母，缺省 CNY） */
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /**
   * 生效时间（ISO 8601）
   *
   * 缺省 = 服务端当前时间。**调价请给更晚的时间**：新单价会**插入新行**，
   * 不覆盖历史；同 (provider, model, effective_from) 重复提交会被 409 拒绝。
   */
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  /** 是否启用：1=启用 0=停用（缺省 1） */
  @IsOptional()
  @IsIn([0, 1])
  enabled?: number;
}

/** 启用 / 停用 AI 模型单价（R101-AI-09；平台身份专属） */
export class SetModelPriceEnabledDto {
  /** 是否启用：1=启用 0=停用 */
  @IsIn([0, 1])
  enabled!: number;
}
