/**
 * McpServerService — MCP Server（P0-3）
 *
 * 依据：权威文档 14.2/14.3——MCP over HTTP（SSE）暴露 ToolRegistry 全部工具，
 * Token 认证 → 注入 tenantId 到 TenantContext，与自有前端完全相同的工具处理逻辑。
 *
 * 协议实现（手写 JSON-RPC 2.0，轻量无外部 SDK 依赖）：
 * - POST /ai/mcp：接收 JSON-RPC 请求，直接返回 JSON 响应
 *   （initialize / ping / tools/list / tools/call，兼容 Streamable HTTP 风格）
 * - GET /ai/mcp：SSE 流，先发 endpoint 事件（兼容经典 HTTP+SSE 客户端）
 *
 * 写操作闭环（写全审核原则，与 /chat 一致）：
 * - 写工具调用默认生成预览（confirm=false）→ 底座挂起 WriteGuard 令牌
 *   → 返回预览 + pendingWriteToken
 * - 第三方调用 write_guard_confirm 工具确认/取消后真正执行（高危写二次确认）
 *
 * 认证：
 * - Authorization: Bearer <token> 或 x-mcp-token: <token>
 * - 验证通过后签发服务账号 JWT（JWT_SECRET，HS256，issuer/audience 与后端对齐）
 *   透传 ServiceClient，后端按 tenantId 处理数据
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { ToolRegistry } from '../../tools/tool-registry';
import { ToolExecutor } from '../../tools/tool-executor';
import type { ToolContext, ToolResult } from '../../tools/tool.interface';
import { WriteGuardService } from '../write-guard.service';
import { ConfirmationService } from '../confirmation.service';
import { McpTokenService } from './mcp-token.service';

/** MCP 协议版本（server 侧支持的最新版本） */
const MCP_PROTOCOL_VERSION = '2025-06-18';
/** MCP Server 名称/版本 */
const SERVER_INFO = { name: 'zhixiang-ai-base', version: '0.1.0' };

/** JSON-RPC 2.0 请求 */
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

/** MCP 处理结果 */
export interface McpHandleResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** 合法 MCP Token 字符集：可打印 ASCII 且无空白（mcp_+64hex=66 字符，历史明文同形态） */
const MCP_TOKEN_PATTERN = /^[\x21-\x7E]{1,128}$/;

/**
 * 从请求头提取 MCP Token（Authorization Bearer 优先，其次 x-mcp-token）
 *
 * 提取后必须通过字符集白名单校验（可打印 ASCII、1~128 字符）才对外返回：
 * 既拒绝异常超长/含控制字符的恶意输入，也在此处显式终止不可信输入的传播链。
 */
export function extractMcpToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  let raw: string | undefined;
  if (auth && auth.startsWith('Bearer ')) {
    raw = auth.slice(7).trim();
  } else {
    const xToken = req.headers['x-mcp-token'];
    raw = typeof xToken === 'string' ? xToken.trim() : undefined;
  }
  if (!raw || !MCP_TOKEN_PATTERN.test(raw)) {
    return undefined;
  }
  return raw;
}

@Injectable()
export class McpServerService {
  private readonly logger = new Logger(McpServerService.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly tokenService: McpTokenService,
    private readonly writeGuard: WriteGuardService,
    private readonly confirmationService: ConfirmationService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 处理 MCP JSON-RPC 请求（POST /ai/mcp）
   *
   * @param body       请求体（JSON-RPC）
   * @param rawToken   客户端携带的 MCP Token（Authorization Bearer / x-mcp-token）
   * @returns HTTP 状态 + JSON-RPC 响应体
   */
  async handleMessage(
    body: unknown,
    rawToken?: string,
  ): Promise<McpHandleResult> {
    // 1. 解析 JSON-RPC
    const parsed = this.parseBody(body);
    if (!parsed) {
      return this.error(null, -32700, 'Parse error：请求体必须是合法 JSON');
    }
    const id = parsed.id ?? null;
    const method = parsed.method ?? '';

    // 2. 认证（所有方法均需有效 MCP Token）
    const token = await this.tokenService.validate(rawToken ?? '');
    if (!token) {
      return this.error(
        id,
        -32001,
        'MCP Token 无效或已过期，请检查 Authorization Bearer / x-mcp-token',
      );
    }
    const tenantId = token.tenantId;

    // 3. 分发
    try {
      switch (method) {
        case 'initialize':
          return this.ok(id, {
            protocolVersion:
              (parsed.params as { protocolVersion?: string })
                ?.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        case 'notifications/initialized':
          // 通知类无响应
          return { httpStatus: 202, body: {} };
        case 'ping':
          return this.ok(id, {});
        case 'tools/list':
          return this.ok(id, { tools: this.listTools(tenantId) });
        case 'tools/call':
          return this.ok(id, await this.callTool(tenantId, parsed.params));
        default:
          return this.error(id, -32601, `Method not found：${method}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`MCP 方法执行异常：method=${method} err=${msg}`);
      return this.error(id, -32603, `Internal error：${msg}`);
    }
  }

  /**
   * 建立 SSE 流（GET /ai/mcp，经典 MCP HTTP+SSE 客户端用）
   *
   * 2026-09-05 审查 M3 修复：握手前必须先验证 MCP Token（此前 GET 无鉴权，
   * 匿名可挂长连接消耗资源）。验证失败返回 401，不开流。
   *
   * 发送 endpoint 事件后保持连接（30s heartbeat），客户端断开时清理。
   */
  handleSse(req: Request, res: Response): void {
    const rawToken = extractMcpToken(req);
    // 同步校验存在性 + 异步校验有效性：无效直接 401，不建立 SSE 连接
    void this.tokenService.validate(rawToken ?? '').then((token) => {
      if (!token) {
        res.status(401).json({
          statusCode: 401,
          code: 'AI_001',
          message: 'MCP Token 无效或缺失（Authorization Bearer / x-mcp-token）',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // endpoint 指向 POST /ai/mcp（Streamable HTTP 风格同 URL）
      res.write(`event: endpoint\ndata: /ai/mcp\n\n`);

      const heartbeat = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 30000);
      req.on('close', () => {
        clearInterval(heartbeat);
        res.end();
      });
    });
  }

  // ── 工具调用 ──

  private listTools(tenantId: string): unknown[] {
    const tools = this.registry.listForTenant(tenantId).map((meta) => ({
      name: meta.name,
      description: meta.description,
      inputSchema: meta.parameters,
    }));

    // WriteGuard 确认工具（写全审核闭环）
    tools.push({
      name: 'write_guard_confirm',
      description:
        '确认或取消待确认的写操作。写工具调用后会返回 pendingWriteToken，' +
        '调用本工具携带该令牌与 action=confirm 真正执行（高危写需二次确认），action=cancel 放弃。',
      inputSchema: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            description: '写工具返回的 pendingWriteToken',
          },
          action: {
            type: 'string',
            enum: ['confirm', 'cancel'],
            description: 'confirm=确认执行 / cancel=取消',
          },
          remark: {
            type: 'string',
            description: '执行备注（可选）',
          },
        },
        required: ['token', 'action'],
      },
    });

    return tools;
  }

  private async callTool(
    tenantId: string,
    params: unknown,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const call = (params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const name = call.name ?? '';
    const args = call.arguments ?? {};
    const toolContext = this.buildToolContext(tenantId);

    // WriteGuard 确认工具
    if (name === 'write_guard_confirm') {
      return this.handleWriteGuardConfirm(args, toolContext);
    }

    const tool = this.registry.get(name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text',
            text: `工具 "${name}" 未注册。可用工具：${this.registry
              .listForTenant(tenantId)
              .map((t) => t.name)
              .join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    const result = await this.executor.executeToolCall(
      {
        id: `mcp-${randomUUID()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
      toolContext,
    );

    if (!result.success) {
      return {
        content: [
          {
            type: 'text',
            text:
              `执行失败：${result.error ?? '未知错误'}` +
              (result.suggestion ? `\n建议：${result.suggestion}` : ''),
          },
        ],
        isError: true,
      };
    }

    // 写操作预览 → 挂起 WriteGuard 令牌（写全审核）
    if (result.preview) {
      const write = await this.writeGuard.suspend({
        tenantId,
        toolName: name,
        docType: name,
        risk: tool.risk ?? 'medium',
        needsReview: tool.needsReview ?? tool.risk === 'high',
        args,
        preview: result.preview,
        operationLabel: result.preview.operation ?? name,
      });
      return {
        content: [
          {
            type: 'text',
            text: this.formatPreview(result.preview, write.token),
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.data ?? null) }],
    };
  }

  private async handleWriteGuardConfirm(
    args: Record<string, unknown>,
    toolContext: ToolContext,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const token = typeof args.token === 'string' ? args.token : '';
    const action = args.action === 'cancel' ? 'cancel' : 'confirm';

    if (!token) {
      return {
        content: [{ type: 'text', text: '参数缺失：请提供 pendingWriteToken' }],
        isError: true,
      };
    }

    if (action === 'cancel') {
      const cancelled = await this.writeGuard.cancel(
        token,
        toolContext.tenantId,
      );
      if (!cancelled) {
        return {
          content: [
            { type: 'text', text: '取消失败：令牌不存在、已过期或已确认执行' },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: '操作已取消' }] };
    }

    const remark = typeof args.remark === 'string' ? args.remark : undefined;
    const result = await this.confirmationService.confirmAndExecute(
      token,
      toolContext.tenantId,
      toolContext,
      remark,
    );

    if (result.needsSecondConfirm) {
      return {
        content: [
          {
            type: 'text',
            text: '高危操作需二次确认，请再次调用 write_guard_confirm（action=confirm）',
          },
        ],
      };
    }
    if (!result.success) {
      return {
        content: [
          {
            type: 'text',
            text:
              `执行失败：${result.error ?? '未知错误'}` +
              (result.suggestion ? `\n建议：${result.suggestion}` : ''),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            data: result.data ?? null,
            operationId: result.operationId,
            message: result.message,
          }),
        },
      ],
    };
  }

  private formatPreview(
    preview: NonNullable<ToolResult['preview']>,
    token: string,
  ): string {
    const lines: string[] = [
      `【待确认】${preview.operation ?? '写操作'}`,
      preview.summary ?? '',
    ];
    if (preview.details) {
      lines.push(JSON.stringify(preview.details, null, 2));
    }
    lines.push(
      `pendingWriteToken: ${token}`,
      '请调用 write_guard_confirm（action=confirm）确认执行，或 action=cancel 取消。',
    );
    return lines.join('\n');
  }

  // ── 工具上下文（MCP 服务账号）──

  private buildToolContext(tenantId: string): ToolContext {
    return {
      tenantId,
      userId: 'mcp',
      sessionId: `mcp_${Date.now()}`,
      role: 'admin',
      authToken: this.buildServiceJwt(tenantId),
      requestId: randomUUID(),
    };
  }

  /**
   * 签发服务账号 JWT（MCP 调用后端 API 的认证凭证）
   *
   * 与 TenantMiddleware 验签规则一致：HS256、issuer=zhixiang-system、audience=zhixiang-client。
   * 15 分钟有效；未配置 JWT_SECRET 时返回空（后端若放行无认证请求则可工作）。
   */
  private buildServiceJwt(tenantId: string): string {
    const secret = this.configService.get<string>('JWT_SECRET', '');
    if (!secret) {
      return '';
    }
    return jwt.sign(
      {
        id: 0,
        username: 'mcp',
        realName: 'MCP对接服务账号',
        roles: ['admin'],
        tenantId,
      },
      secret,
      {
        // 字符串密钥下 jwt.sign 默认即 HS256（与管理系统验签侧 algorithms:['HS256'] 对齐）
        issuer: 'zhixiang-system',
        audience: 'zhixiang-client',
        expiresIn: '15m',
      },
    );
  }

  // ── JSON-RPC 工具 ──

  private parseBody(body: unknown): JsonRpcRequest | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const record = body as Record<string, unknown>;
    if (typeof record.method !== 'string') {
      return null;
    }
    return {
      jsonrpc: typeof record.jsonrpc === 'string' ? record.jsonrpc : '2.0',
      id: (record.id as string | number | null | undefined) ?? null,
      method: record.method,
      params: record.params,
    };
  }

  private ok(id: string | number | null, result: unknown): McpHandleResult {
    return { httpStatus: 200, body: { jsonrpc: '2.0', id, result } };
  }

  private error(
    id: string | number | null,
    code: number,
    message: string,
  ): McpHandleResult {
    const httpStatus = code === -32001 ? 401 : 200;
    return {
      httpStatus,
      body: { jsonrpc: '2.0', id, error: { code, message } },
    };
  }
}
