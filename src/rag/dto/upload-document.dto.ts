/**
 * RAG 上传文档 DTO
 *
 * 传输方式：JSON body，content 为文件字节的 base64 编码（避免 multipart 依赖，
 * 前端读取文件后用 FileReader.readAsDataURL 或 ArrayBuffer → base64 即可上传）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import {
  IsBase64,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UploadDocumentDto {
  /** 文档文件名（含扩展名，用于判断类型：pdf/docx/md/txt/xlsx/xls/csv） */
  @IsString()
  @IsNotEmpty({ message: 'filename 不能为空' })
  @MaxLength(255, { message: 'filename 长度不能超过 255' })
  filename!: string;

  /** 文件字节的 base64 编码内容 */
  @IsBase64(undefined, { message: 'content 必须是 base64 编码' })
  @IsNotEmpty({ message: 'content 不能为空' })
  content!: string;

  /** 租户 ID（默认 default；多租户场景由调用方显式传入或后续接入 TenantMiddleware） */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
