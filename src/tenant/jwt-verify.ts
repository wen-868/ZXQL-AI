/**
 * 双 JWT 验签配置（与管理系统 backend/src/middleware/auth.ts 严格对齐）
 *
 * 管理系统签发两类严格隔离的 JWT（同一 JWT_SECRET，issuer/audience 隔离防跨域冒充）：
 * - 商家 JWT：issuer=zhixiang-system / audience=zhixiang-client（租户用户 + 运营客户身份）
 * - 平台 JWT：issuer=zhixiang-platform / audience=zhixiang-platform-client（总台管理员 saas-admin，payload 无 tenantId/roles）
 *
 * 依据：2026-09-05 全面审查 P0-2/P0-3——AI 底座此前只验商家 JWT，
 * 平台 JWT 验签必然失败并静默回退"请求体身份模式"，导致身份可伪造。
 */
import type { VerifyOptions } from 'jsonwebtoken';

/** 商家 JWT 验签参数 */
export const MERCHANT_JWT_VERIFY: VerifyOptions = {
  algorithms: ['HS256'],
  issuer: 'zhixiang-system',
  audience: 'zhixiang-client',
};

/** 平台（总台）JWT 验签参数 */
export const PLATFORM_JWT_VERIFY: VerifyOptions = {
  algorithms: ['HS256'],
  issuer: 'zhixiang-platform',
  audience: 'zhixiang-platform-client',
};

/** 商家 JWT payload（管理系统 signToken 签发） */
export interface MerchantJwtPayload {
  id: number;
  username: string;
  realName?: string;
  roles?: string[];
  storeId?: number | null;
  tenantId: string;
  /** 运营客户端身份（role=customer 时由后端签入） */
  customerId?: number | string;
}

/** 平台 JWT payload（管理系统 signPlatformToken 签发） */
export interface PlatformJwtPayload {
  id: number;
  username: string;
  realName?: string;
  type?: string;
  /** 平台 token 通常无 tenantId（跨租户），预留兼容 */
  tenantId?: string;
}
