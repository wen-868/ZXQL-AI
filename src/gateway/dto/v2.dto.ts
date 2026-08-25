/**
 * v2 接口 DTO（批次3，文档 11.1/11.3）
 *
 * 对应端点：
 * - POST /api/ai/v2/handle      自然语言入口（读自动 / 写挂起）
 * - POST /api/ai/v2/confirm     受控写确认
 * - POST /api/ai/v2/report      生成并导出报表（A/B/C/D 类）
 * - POST /api/ai/v2/report/pdf  报表导出 PDF
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** 自然语言入口 */
export class V2HandleDto {
  /** 用户自然语言输入 */
  @IsString({ message: 'input 必须是字符串' })
  @IsNotEmpty({ message: 'input 不能为空' })
  @MaxLength(4000, { message: 'input 不能超过 4000 字符' })
  input!: string;

  /** 会话 ID（可选） */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** 租户 ID（可选，JWT 兼容） */
  @IsOptional()
  @IsString()
  tenantId?: string;

  /** 模型标识（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  /** 工具作用域 */
  @IsOptional()
  @IsIn(['mgmt', 'platform'])
  scope?: 'mgmt' | 'platform';
}

/** 受控写确认 */
export class V2ConfirmDto {
  /** WriteGuard 令牌 */
  @IsString()
  @IsNotEmpty({ message: 'token 不能为空' })
  token!: string;

  /** 执行备注（可选） */
  @IsOptional()
  @IsString()
  remark?: string;
}

/** 报表参数（A/B/C/D 通用字段，服务按类映射） */
export class V2ReportParamsDto {
  @IsOptional()
  @IsString()
  dateStart?: string;

  @IsOptional()
  @IsString()
  dateEnd?: string;

  @IsOptional()
  @IsNumber()
  storeId?: number;

  @IsOptional()
  @IsString()
  groupBy?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  period?: string;
}

/** 生成报表 */
export class V2ReportDto {
  /** 报表类别：A=销售 / B=库存 / C=利润 / D=经营总览 */
  @IsIn(['A', 'B', 'C', 'D'], { message: 'type 仅支持 A/B/C/D' })
  type!: 'A' | 'B' | 'C' | 'D';

  @IsOptional()
  @IsObject()
  params?: V2ReportParamsDto;
}

/** 报表导出 PDF（与生成同构） */
export class V2ReportPdfDto extends V2ReportDto {}
