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
  /** 租户 ID（必填，用于数据隔离） */
  tenantId: string;
  /** 用户 ID（可选） */
  userId?: string;
  /** 用户角色（可选，用于权限校验） */
  role?: string;
  /** 用户 JWT token（可选，ServiceClient 透传给后端 API） */
  authToken?: string;
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
   * 获取当前用户 authToken
   */
  getAuthToken(): string | undefined {
    return this.storage.getStore()?.authToken;
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
}
