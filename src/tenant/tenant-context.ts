/**
 * TenantContext — 租户上下文（基于 AsyncLocalStorage）
 *
 * 职责：
 * 1. 在请求生命周期内存储租户信息（tenantId / userId / authToken / role）
 * 2. 所有 Tool / Provider / Service 无需逐层传递 tenantId，直接从 TenantContext 获取
 * 3. 基于 Node.js AsyncLocalStorage，天然支持异步链路传递（Promise/setTimeout/回调）
 *
 * 工作原理：
 * - TenantGuard 在请求进入时调用 enter() 注入租户信息
 * - 整个请求链路中任何代码通过 getTenantId() / getUserId() 获取当前租户
 * - 请求结束后 AsyncLocalStorage 自动清理，不影响下一个请求
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.3 多租户隔离
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * 租户上下文数据
 *
 * 由 TenantGuard 从 JWT 解析后注入。
 * 所有字段在请求生命周期内不可变（enter 后不可修改）。
 */
export interface TenantContextData {
  /**
   * 租户 ID。商家身份必有；平台身份可缺省（总台管理员跨租户操作，
   * 2026-10-04 P1 修复：AdminContextMiddleware 允许平台无目标租户进入
   * 管理端点，归属由端点按 isPlatform()/getAdminIdentity 口径自行收口）
   */
  tenantId?: string;
  /** 用户 ID（可选） */
  userId?: string;
  /** 用户角色（可选，用于权限校验） */
  role?: string;
  /** 客户 ID（可选，运营客户端 customerScope 隔离：role=customer 时必填） */
  customerId?: string;
  /** 用户 JWT token（可选，ServiceClient 透传给后端 API） */
  authToken?: string;
  /** 身份来源（2026-09-05 鉴权链收紧）：merchant=商家 JWT / platform=平台（总台）JWT */
  authType?: 'merchant' | 'platform';
  /** 会话 ID（可选） */
  sessionId?: string;
}

@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantContextData>();

  /**
   * 进入租户上下文
   *
   * 由 TenantGuard 在请求拦截阶段调用。
   * 通过 run() 确保回调函数内所有异步链路都能访问到上下文数据。
   *
   * @param data    租户上下文数据
   * @param callback 请求处理回调
   * @returns 回调的返回值
   */
  run<T>(data: TenantContextData, callback: () => T): T {
    return this.storage.run(data, callback);
  }

  /**
   * 获取当前租户上下文数据
   *
   * @returns 上下文数据，未在请求上下文中返回 undefined
   */
  getData(): TenantContextData | undefined {
    return this.storage.getStore();
  }

  /**
   * 获取当前租户 ID
   *
   * @returns 租户 ID，未在请求上下文中返回 undefined
   */
  getTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId;
  }

  /**
   * 获取当前用户 ID
   */
  getUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }

  /**
   * 获取当前用户角色
   */
  getRole(): string | undefined {
    return this.storage.getStore()?.role;
  }

  /**
   * 获取当前客户 ID（运营客户端）
   *
   * role=customer 时必须存在；缺失表示运营客户端身份不完整。
   */
  getCustomerId(): string | undefined {
    return this.storage.getStore()?.customerId;
  }

  /**
   * 是否运营客户端（role=customer）
   */
  isCustomer(): boolean {
    return this.storage.getStore()?.role === 'customer';
  }

  /**
   * 获取当前用户 authToken
   */
  getAuthToken(): string | undefined {
    return this.storage.getStore()?.authToken;
  }

  /**
   * 获取身份来源（merchant=商家 JWT / platform=平台 JWT）
   */
  getAuthType(): 'merchant' | 'platform' | undefined {
    return this.storage.getStore()?.authType;
  }

  /**
   * 是否平台（总台）身份（zhixiang-platform JWT）
   */
  isPlatform(): boolean {
    return this.storage.getStore()?.authType === 'platform';
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string | undefined {
    return this.storage.getStore()?.sessionId;
  }

  /**
   * 判断是否在租户上下文中
   */
  isActive(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /**
   * 要求必须在租户上下文中调用，否则抛异常
   *
   * 用于 AiConfigService 等必须获取租户信息的服务。
   *
   * @returns 租户上下文数据
   * @throws Error 不在租户上下文中
   */
  require(): TenantContextData {
    const data = this.storage.getStore();
    if (!data) {
      throw new Error(
        '当前不在租户上下文中，请确保请求经过 TenantGuard 拦截（或手动调用 TenantContext.enter()）',
      );
    }
    return data;
  }

  /**
   * 要求必须存在租户 ID（2026-10-04：tenantId 可选化后的强取口）
   *
   * 商户链路（TenantMiddleware 覆盖的业务路由）租户必在；平台跨租户场景
   * （AdminContextMiddleware 无目标租户）调用此方法会抛错——此类端点应走
   * getAdminIdentity()/isPlatform() 口径而非强取租户。
   */
  requireTenantId(): string {
    const data = this.require();
    if (!data.tenantId) {
      throw new Error(
        '当前上下文无租户 ID（平台跨租户身份）：请改用身份口径判定归属',
      );
    }
    return data.tenantId;
  }
}
