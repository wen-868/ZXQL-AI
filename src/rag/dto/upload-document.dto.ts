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

  /**
   * 目标租户 ID（可选）
   *
   * 真实来源与用途（2026-10-13 核实，勿再按"调用方自报"理解）：
   * - 端点 `POST /api/rag/documents`（`rag.controller.ts:80`）把它传给
   *   `resolveAdminTenantId(req, this)` —— **只有平台身份**才允许用它指定目标租户；
   *   商户身份恒取 JWT 自身租户，自报他人一律 403（`admin-tenant-scope.ts:40-58`）；
   *   平台身份不传 ⇒ 400（该函数显式拒绝静默缺省 'default'）。
   * - RAG 路由**已**在 `AdminContextMiddleware` 覆盖内（`tenant.module.ts:106`
   *   `forRoutes('review','rag','voice')`），租户上下文由 JWT 身份注入，
   *   **不存在"后续接入 TenantMiddleware"这回事**（原注释为过时表述）。
   * - 因此本字段仍需保留（平台跨租户运维入口），但**不是**租户真相来源。
   */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
