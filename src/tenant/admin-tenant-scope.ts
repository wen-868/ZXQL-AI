/**
 * AdminTenantScope — 管理端租户口径统一收口（2026-10-04）
 *
 * 背景：管理路由（`admin/*`）**不在 TenantMiddleware 覆盖范围内**
 * （`tenant.module.ts` 只注册了 `chat`、`ai/agent`、`ai/v2`、`ai/employees`），
 * 因此管理控制器里读 `TenantContext.getData()` 恒为空 —— 此前 `ai-db.controller.ts`
 * 的 E4 三端点用 `getData()?.tenantId ?? 'default'`，**生产上真实租户永远取不到**，
 * 一律落到 `'default'`：E4 训练/看板/数据集导出对真实租户全部失效
 * （注释却写着"不接受请求体传入——否则可伪造"，实际是"真租户传不进来"）。
 *
 * 同一病根在另外两处已各自手写过一遍（`admin.controller.ts` 的 tools/execute、
 * `ai-config.controller.ts` 的 requireTenantAccess）。本文件把它收敛为唯一实现，
 * 三处共用同一口径，避免"三份实现三种行为"。
 *
 * 口径（与全项目铁律一致：tenantId 一律只认 JWT payload）：
 * - **商户身份**：强制锁本租户。显式请求他人租户 → 403（不静默改写，
 *   否则会误配出极难排查的数据错位）；不传 → 用本租户。
 * - **平台身份**：允许跨租户运维，但**必须显式指定目标租户**（缺失 → 400），
 *   不允许静默退化到 `'default'`——缺省值正是本次事故的根因。
 * - **无身份**：`getAdminIdentity` 直接抛 403（防绕过守卫直调控制器方法）。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-04
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { aiError } from '../common/ai-errors';
import { getAdminIdentity } from './admin-auth.guard';

/**
 * 解析管理端请求的租户 ID
 *
 * @param req        express 请求（须已过 AdminGuard/JwtGuard，否则 403）
 * @param requested  调用方请求的目标租户（查询参数/请求体），平台身份时生效
 * @returns 生效租户 ID（保证非空）
 */
export function resolveAdminTenantId(req: Request, requested?: string): string {
  const identity = getAdminIdentity(req);
  const requestedTenantId = requested?.trim();

  if (identity.identityType === 'merchant') {
    const own = identity.tenantId;
    if (!own) {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: '商户 JWT 缺少 tenantId，无法确定租户',
        }),
      });
    }
    if (requestedTenantId && requestedTenantId !== own) {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: `无权访问租户 ${requestedTenantId} 的数据（商户身份仅限本租户）`,
        }),
      });
    }
    return own;
  }

  // 平台身份：跨租户运维必须显式指定目标租户
  // 注意这里**不**回退 'default' —— 静默缺省会让操作落到错误租户而不自知
  if (!requestedTenantId) {
    throw new BadRequestException({
      statusCode: 400,
      ...aiError('AI_010', {
        detail: '平台身份跨租户操作必须显式指定 tenantId（不接受缺省值）',
      }),
    });
  }
  return requestedTenantId;
}

/**
 * 解析管理端请求的租户 ID，允许缺省（用于"看板/统计"类可选租户的端点）
 *
 * 与 `resolveAdminTenantId` 的差别：平台身份未指定租户时返回 `undefined`
 * 由调用方决定语义（如"查全部"），**绝不**静默映射为 'default'。
 */
export function resolveOptionalAdminTenantId(
  req: Request,
  requested?: string,
): string | undefined {
  const identity = getAdminIdentity(req);
  const requestedTenantId = requested?.trim();

  if (identity.identityType === 'merchant') {
    const own = identity.tenantId;
    if (!own) {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: '商户 JWT 缺少 tenantId，无法确定租户',
        }),
      });
    }
    if (requestedTenantId && requestedTenantId !== own) {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: `无权访问租户 ${requestedTenantId} 的数据（商户身份仅限本租户）`,
        }),
      });
    }
    return own;
  }

  return requestedTenantId;
}
