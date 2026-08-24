/**
 * Provider 错误类
 *
 * 用于封装 LLM 服务商调用过程中的错误，携带 HTTP 状态码 + Provider 名称，
 * 便于上层 Gateway 按状态码决定如何响应客户端（429 限流提示重试、401 提示检查 Key 等）。
 *
 * 设计参考：backend/src/shared/app-error.ts（现有后端的 AppError 模式）
 */
export class ProviderError extends Error {
  /** HTTP 状态码（来自上游 API 或自定义业务码） */
  readonly statusCode: number;
  /** 出错的 Provider 名称（'deepseek' | 'ollama' | ...） */
  readonly provider: string;
  /** 上游返回的原始错误信息（用于日志排查） */
  readonly upstreamMessage?: string;

  constructor(
    message: string,
    statusCode: number,
    provider: string,
    upstreamMessage?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
    this.provider = provider;
    this.upstreamMessage = upstreamMessage;
    // 保留原始堆栈（避免 Error.prototype.stack 丢失）
    Object.setPrototypeOf(this, ProviderError.prototype);
  }

  /**
   * 从 axios 错误构造 ProviderError
   *
   * - 网络错误（无 response）→ statusCode 503，message "网络错误"
   * - 401 鉴权失败 → "API Key 无效或已过期"
   * - 429 限流 → "请求过于频繁，请稍后重试"
   * - 5xx 服务异常 → "AI 服务暂时不可用"
   * - 其他 → 透传上游 message
   */
  static fromAxiosError(err: unknown, provider: string): ProviderError {
    // axios 错误对象结构：{ response?: { status, data }, request?, message, code? }
    const anyErr = err as {
      response?: {
        status?: number;
        data?: { error?: { message?: string } | string };
      };
      request?: unknown;
      message?: string;
      code?: string;
    };

    // 网络层错误（无 response）
    if (!anyErr.response) {
      // 取消请求（AbortSignal 触发）
      if (
        anyErr.code === 'ERR_CANCELED' ||
        anyErr.message?.includes('cancel')
      ) {
        return new ProviderError(
          '请求已取消',
          499, // Nginx 非标准码：客户端关闭连接
          provider,
          anyErr.message,
        );
      }
      return new ProviderError(
        `网络错误：${anyErr.message ?? '未知错误'}`,
        503,
        provider,
        anyErr.message,
      );
    }

    const status = anyErr.response.status ?? 500;
    const upstream =
      typeof anyErr.response.data?.error === 'object'
        ? anyErr.response.data?.error?.message
        : typeof anyErr.response.data?.error === 'string'
          ? anyErr.response.data.error
          : JSON.stringify(anyErr.response.data);

    let message: string;
    switch (status) {
      case 401:
        message = `${provider} API Key 无效或已过期，请检查配置`;
        break;
      case 403:
        message = `${provider} 拒绝访问（403），可能权限不足或 IP 被限制`;
        break;
      case 404:
        message = `${provider} API 路径不存在（404），请检查 baseUrl 配置`;
        break;
      case 422:
        message = `${provider} 请求参数错误（422）：${upstream}`;
        break;
      case 429:
        message = `${provider} 请求过于频繁（429），请稍后重试`;
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        message = `${provider} 服务暂时不可用（${status}），请稍后重试`;
        break;
      default:
        message = `${provider} 调用失败（${status}）：${upstream}`;
    }

    return new ProviderError(message, status, provider, upstream);
  }
}
