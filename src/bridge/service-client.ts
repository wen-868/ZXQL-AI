import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from 'axios';
import { ToolContext } from '../tools/tool.interface';

/**
 * 后端统一返回格式（与 backend/src/shared/response.ts 对齐）
 *
 * 现有后端 Express.js 返回结构：
 *   成功: { code: "0", msg: "成功", data: T, traceId: "uuid" }
 *   失败: { code: "400"|"401"|"403"|"404"|"500", msg: "错误描述", traceId: "uuid" }
 *
 * 注意：项目统一标准定义了 apiCost 字段，但现有 response.ts 尚未实现，
 * ServiceClient 对 apiCost 做可选兼容（存在则读取，不存在则忽略）。
 */
export interface BackendResponse<T = unknown> {
  code: string;
  msg: string;
  data?: T;
  traceId?: string;
  apiCost?: number;
}

/**
 * Service Bridge 错误（HTTP 调用失败或后端返回 code !== "0"）
 */
export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly backendCode: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * 后端 API 端点常量
 *
 * 现有后端是单体 Express.js（端口 8080），所有 API 共用一个 BACKEND_API_BASE。
 * 按业务域整理端点前缀，供 Tool handler 引用，避免硬编码路径字符串。
 *
 * 数据来源：backend/src/routes/*.routes.ts 的 routeConfig.prefix
 */
export const API_ENDPOINTS = {
  // 销售管理（admin-order.routes.ts prefix: /api/admin）
  SALE_BILLS: '/api/admin/sale-bills',
  ORDERS: '/api/admin/orders',
  SALE_RETURNS: '/api/admin/sale-returns',
  // 门店销售单（store-sale-bill.routes.ts prefix: /api/store）— 创建/详情/付款
  STORE_SALE_BILLS: '/api/store/sale-bills',
  // 商品管理（category.routes.ts / product 相关）
  PRODUCTS: '/api/admin/products',
  CATEGORIES: '/api/admin/products/categories',
  PRODUCT_TAGS: '/api/admin/product-tags',
  // 客户管理（admin-customer.routes.ts prefix: /api/admin，实际路由为 /members）
  // R70-11 修复：原为 '/api/admin/customers'（404），真实端点列表/创建/详情均为 /api/admin/members
  CUSTOMERS: '/api/admin/members',
  CUSTOMER_TYPES: '/api/admin/customer-types',
  // 采购管理（purchase.routes.ts prefix: /api/admin/purchase-orders）
  PURCHASE_ORDERS: '/api/admin/purchase-orders',
  PURCHASE_RETURNS: '/api/admin/purchase-returns',
  PURCHASE_PLANS: '/api/admin/purchase-plans',
  // 供应商管理（supplier.routes.ts prefix: /api/admin/suppliers）
  SUPPLIERS: '/api/admin/suppliers',
  // 库存管理
  // 库存余额列表（admin-inventory.routes.ts /inventory-balance；旧值 /api/admin/inventory 404）
  INVENTORY: '/api/admin/inventory-balance',
  TRANSFER_ORDERS: '/api/admin/transfer-orders',
  STOCK_CHECKS: '/api/admin/stock-checks',
  // 配送管理（store-order.routes.ts prefix: /api/store，订单列表/详情/开始配送/完成配送）
  STORE_ORDERS: '/api/store/orders',
  // 财务管理
  RECEIVABLES: '/api/admin/receivables',
  RECONCILIATION: '/api/admin/reconciliation',
  EXPENSES: '/api/admin/expenses',
  // 营销管理（admin-marketing-*.routes.ts prefix: /api/admin/marketing）
  MARKETING_COUPONS: '/api/admin/marketing/coupons/templates',
  MARKETING_FLASH_SALES: '/api/admin/marketing/flash-sales',
  MARKETING_FULL_REDUCTIONS: '/api/admin/marketing/full-reductions',
  MARKETING_GROUP_BUYS: '/api/admin/marketing/group-buys',
  MARKETING_GIFT_RULES: '/api/admin/marketing/gift-rules',
  MARKETING_LIMITED_DISCOUNTS: '/api/admin/marketing/limited-discounts',
  // 采购付款/退货/合同
  PURCHASE_PAYMENTS: '/api/admin/purchase-payments',
  PURCHASE_CONTRACTS: '/api/admin/purchase-contracts',
  // 客户信用（credit.routes.ts prefix: /api/admin/credits）
  CREDITS: '/api/admin/credits',
  CREDIT_COLLECTIONS: '/api/admin/credits/collections',
  // 客户分群/关怀/拜访
  MEMBER_SEGMENTS: '/api/admin/members/segments',
  CARE_RULES: '/api/admin/members/care/rules',
  CUSTOMER_VISITS: '/api/admin/customer-visits',
  // 佣金（commission.routes.ts prefix: /api/admin/commission）
  COMMISSION: '/api/admin/commission',
  // 审批流（approval.routes.ts prefix: /api/admin/approval）
  APPROVAL: '/api/admin/approval',
  // 总台/平台域（requirePlatformAuth，仅 scope=platform 对话可用）
  PLATFORM_TENANTS: '/api/platform/tenants',
  PLATFORM_ANNOUNCEMENTS: '/api/platform/announcements',
  PLATFORM_SUBSCRIPTION_APPLIES: '/api/platform/subscription-applies',
  PLATFORM_SETTLEMENTS: '/api/platform/settlements',
  PLATFORM_AUDIT_LOGS: '/api/platform/audit-logs',
  PLATFORM_ERROR_LOGS: '/api/platform/error-logs',
  PLATFORM_MONITOR: '/api/platform/monitor',
  PLATFORM_CONFIG: '/api/platform/config',
  // 报表分析（report.routes.ts prefix: /api/admin/reports）
  REPORTS: '/api/admin/reports',
  DASHBOARD: '/api/admin/dashboard',
} as const;

/**
 * Service Client — HTTP 客户端封装
 *
 * 职责：
 * 1. 封装 axios，统一调用现有 Express.js 单体后端 API
 * 2. 自动注入认证信息（Authorization: Bearer <token>，从 ToolContext.authToken 获取）
 * 3. 自动注入租户标识（X-Tenant-Id header，从 ToolContext.tenantId 获取）
 * 4. 超时控制 + 1 次自动重试（仅对 5xx 和网络错误重试，4xx 不重试）
 * 5. 统一解析后端返回格式 { code, msg, data, traceId }，code !== "0" 时抛 BridgeError
 * 6. 请求/响应日志（debug 级别，生产环境关闭）
 *
 * 设计原则：
 * - 不依赖 @nestjs/axios 的 HttpService，直接用 axios 更灵活（拦截器 + 实例隔离）
 * - 每次请求从 ToolContext 获取认证信息，支持多租户并发隔离
 * - 错误信息友好：不泄露内部栈，面向 Tool 返回可读的错误描述
 *
 * 用法（Tool handler 内）：
 *   const result = await this.serviceClient.get<OrderList>(
 *     `${API_ENDPOINTS.SALE_BILLS}?page=1&pageSize=20`,
 *     context,
 *   );
 *   // result 已解包，直接是 data 字段内容
 */
@Injectable()
export class ServiceClient {
  private readonly logger = new Logger(ServiceClient.name);
  private readonly httpClient: AxiosInstance;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries = 1;
  /** CSRF 密钥（后端 CSRF_SECRET，缺失时回退 JWT_SECRET，与 backend csrf.ts 一致） */
  private readonly csrfSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>(
      'BACKEND_API_BASE',
      'http://127.0.0.1:8080',
    );
    this.timeout = this.configService.get<number>('BACKEND_API_TIMEOUT', 15000);
    this.csrfSecret =
      this.configService.get<string>('CSRF_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      undefined;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    // 响应拦截器：统一解析后端返回格式
    this.httpClient.interceptors.response.use(
      (response: AxiosResponse<BackendResponse>) => response,
      (error: AxiosError<BackendResponse>) => {
        // 网络错误或超时，交给调用方重试逻辑处理
        return Promise.reject(error);
      },
    );
  }

  /**
   * GET 请求
   *
   * @param path   API 路径（如 /api/admin/sale-bills?page=1）
   * @param context 工具执行上下文（提供 authToken 和 tenantId）
   * @returns 后端返回的 data 字段内容（已解包）
   * @throws BridgeError 后端返回 code !== "0" 或 HTTP 状态码非 2xx
   */
  async get<T = unknown>(
    path: string,
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('GET', path, context, undefined, config);
  }

  /**
   * POST 请求
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('POST', path, context, body, config);
  }

  /**
   * PUT 请求
   */
  async put<T = unknown>(
    path: string,
    body: unknown,
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('PUT', path, context, body, config);
  }

  /**
   * PATCH 请求
   */
  async patch<T = unknown>(
    path: string,
    body: unknown,
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('PATCH', path, context, body, config);
  }

  /**
   * DELETE 请求
   */
  async delete<T = unknown>(
    path: string,
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>('DELETE', path, context, undefined, config);
  }

  /**
   * 健康检查（不传 context，不携带认证信息）
   *
   * 供 AdminController GET /health 调用，验证后端可达性。
   */
  async healthCheck(): Promise<{
    reachable: boolean;
    latencyMs: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      await this.httpClient.get('/api/admin/dashboard/summary', {
        timeout: 5000,
        validateStatus: () => true, // 任何状态码都认为后端可达
      });
      return { reachable: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 核心请求方法（含重试逻辑）
   *
   * 重试策略：
   * - 仅对 5xx 响应和网络错误（ECONNREFUSED/ETIMEDOUT）重试 1 次
   * - 4xx 响应不重试（客户端错误，重试无意义）
   * - 重试间隔 500ms（避免瞬间双击加剧后端压力）
   */
  private async request<T>(
    method: string,
    path: string,
    context: ToolContext,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const requestConfig = this.buildRequestConfig(context, config);

    this.logger.debug(`${method} ${path}（tenant=${context.tenantId}）`);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response: AxiosResponse<BackendResponse<T>> =
          await this.httpClient.request<BackendResponse<T>>({
            method,
            url: path,
            data: body,
            ...requestConfig,
          });

        return this.parseResponse<T>(response.data, response.status, path);
      } catch (err) {
        lastError = err;

        // 判断是否可重试
        if (attempt < this.maxRetries && this.isRetryable(err)) {
          this.logger.warn(
            `${method} ${path} 第 ${attempt + 1} 次请求失败，500ms 后重试：${this.getErrorMessage(err)}`,
          );
          await this.sleep(500);
          continue;
        }

        // 不可重试或已用完重试次数
        throw this.toBridgeError(err, path);
      }
    }

    // 理论上不会走到这里（for 循环内已有 return/throw），TypeScript 需要兜底
    throw this.toBridgeError(lastError, path);
  }

  /**
   * 构造请求配置（注入认证信息和租户标识）
   */
  private buildRequestConfig(
    context: ToolContext,
    config?: AxiosRequestConfig,
  ): AxiosRequestConfig {
    const headers: Record<string, string> = {
      'X-Tenant-Id': context.tenantId,
    };

    // 后端写操作（POST/PUT/DELETE）要求 x-csrf-token：
    // token = HMAC-SHA256(CSRF_SECRET || JWT_SECRET, userId)，与 backend/src/middleware/csrf.ts 对齐
    if (context.userId && this.csrfSecret) {
      headers['x-csrf-token'] = createHmac('sha256', this.csrfSecret)
        .update(String(context.userId))
        .digest('hex');
    }

    // 透传用户 JWT token（后端 requireAuthWithTenant 会解析）
    if (context.authToken) {
      headers['Authorization'] = `Bearer ${context.authToken}`;
    }

    // 如果有 requestId，透传用于全链路追踪
    if (context.requestId) {
      headers['X-Request-Id'] = context.requestId;
    }

    return {
      headers,
      ...config,
    };
  }

  /**
   * 解析后端返回格式
   *
   * 后端返回 { code: "0", msg, data, traceId }：
   * - HTTP 2xx + code === "0" → 返回 data
   * - HTTP 2xx + code !== "0" → 抛 BridgeError（后端业务错误）
   * - HTTP 4xx/5xx → 抛 BridgeError（HTTP 错误）
   */
  private parseResponse<T>(
    data: BackendResponse<T>,
    status: number,
    path: string,
  ): T {
    // HTTP 状态码非 2xx
    if (status < 200 || status >= 300) {
      throw new BridgeError(
        `后端 HTTP ${status}：${data.msg ?? '未知错误'}（path=${path}）`,
        status,
        data.code ?? String(status),
        data.traceId,
      );
    }

    // 后端业务错误（code !== "0"）
    if (data.code !== '0') {
      throw new BridgeError(
        `后端业务错误：${data.msg}（code=${data.code}, path=${path}）`,
        status,
        data.code,
        data.traceId,
      );
    }

    // 成功：返回 data 字段
    // data 可能为 undefined（如 DELETE 操作无返回值），用 null 兜底
    return data.data as T;
  }

  /**
   * 判断错误是否可重试
   *
   * 可重试：5xx 响应、网络错误（ECONNREFUSED/ETIMEDOUT/ENOTFOUND）
   * 不可重试：4xx 响应（客户端错误）、BridgeError（业务错误）
   */
  private isRetryable(err: unknown): boolean {
    if (err instanceof AxiosError) {
      // 网络错误（无响应）
      if (!err.response) {
        return true;
      }
      // 5xx 服务端错误
      if (err.response.status >= 500) {
        return true;
      }
    }
    return false;
  }

  /**
   * 将各类错误转换为 BridgeError
   */
  private toBridgeError(err: unknown, path: string): BridgeError {
    if (err instanceof BridgeError) {
      return err;
    }

    if (err instanceof AxiosError) {
      // 有后端响应（4xx/5xx）
      if (err.response) {
        const backendData = err.response.data as BackendResponse | undefined;
        return new BridgeError(
          `后端 HTTP ${err.response.status}：${backendData?.msg ?? err.message}（path=${path}）`,
          err.response.status,
          backendData?.code ?? String(err.response.status),
          backendData?.traceId,
        );
      }

      // 请求超时
      if (err.code === 'ECONNABORTED') {
        return new BridgeError(
          `后端请求超时（${this.timeout}ms，path=${path}）`,
          408,
          'TIMEOUT',
        );
      }

      // 网络错误（后端不可达）
      return new BridgeError(
        `后端不可达：${err.message}（path=${path}）`,
        503,
        'NETWORK_ERROR',
      );
    }

    // 未知错误
    return new BridgeError(
      `未知请求错误：${err instanceof Error ? err.message : String(err)}（path=${path}）`,
      500,
      'UNKNOWN',
    );
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
