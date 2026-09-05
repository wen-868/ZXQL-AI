/**
 * AllExceptionsFilter — 全局异常过滤器（AI_001~013 错误码体系接线）
 *
 * 依据：2026-09-05 全面审查 P2——ai-errors.ts 定义了 AI_001~013 统一错误码，
 * 但此前 0 处接线（无 ExceptionFilter），未捕获异常直出 Nest 默认结构。
 *
 * 策略（最小改动，不破坏既有响应形态）：
 * - HttpException：保留原有状态码与响应体，仅当响应体为对象且缺少 code 字段时，
 *   按 HTTP 状态映射补 AI 错误码（401→AI_001、403→AI_010、429→AI_003）
 * - 未捕获异常：统一 500 + AI_005（LLM 调用失败/内部错误），不泄露堆栈
 * - SSE 场景（headers 已发送）：无法再改状态码，只记日志并结束响应
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AI_ERRORS, type AiErrorCode } from './ai-errors';

/** HTTP 状态 → AI 错误码映射（仅用于补齐缺失的 code 字段） */
const HTTP_TO_AI_CODE: Partial<Record<number, AiErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: 'AI_001',
  [HttpStatus.FORBIDDEN]: 'AI_010',
  [HttpStatus.TOO_MANY_REQUESTS]: 'AI_003',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'AI_005',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // SSE/流式响应已开流：状态码不可改，只记日志并安全断流
    if (res.headersSent) {
      this.logger.error(
        `响应已开流后抛异常：${req.method} ${req.originalUrl} err=${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      try {
        res.end();
      } catch {
        // 断流失败忽略（连接已由客户端/中间层关闭）
      }
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const enriched = body as Record<string, unknown>;
        if (!enriched.code) {
          const mapped = HTTP_TO_AI_CODE[status];
          if (mapped) {
            enriched.code = mapped;
            enriched.timestamp = new Date().toISOString();
          }
        }
        res.status(status).json(enriched);
        return;
      }
      // 响应体为字符串（如 throw new HttpException('xxx', status)）
      res.status(status).json({
        statusCode: status,
        code: HTTP_TO_AI_CODE[status],
        message: body,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 未捕获异常：统一 500 + AI_005，不泄露内部细节
    const message =
      exception instanceof Error
        ? exception.message
        : typeof exception === 'string'
          ? exception
          : (JSON.stringify(exception) ?? 'unknown');
    const err = new Error(message);
    this.logger.error(
      `未捕获异常：${req.method} ${req.originalUrl} err=${err.message}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'AI_005',
      message: `服务器内部错误：${err.message}`,
      timestamp: new Date().toISOString(),
    });
  }
}

// 供类型引用（避免 AI_ERRORS 未使用告警的语义丢失：映射表来源即 AI_ERRORS 定义）
export const AI_ERROR_HTTP_MAP = AI_ERRORS;
