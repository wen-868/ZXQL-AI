/**
 * McpController — MCP 协议入口（P0-3）
 *
 * 端点：
 * - GET  /api/ai/mcp           → SSE 流（经典 MCP HTTP+SSE：先发 endpoint 事件）
 * - POST /api/ai/mcp           → JSON-RPC 请求处理（initialize/ping/tools/list/tools/call）
 *
 * 认证：Authorization: Bearer <token> 或 x-mcp-token: <token>
 * 详情见 McpServerService。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpServerService } from '../brain/mcp/mcp-server.service';

/** 从请求头提取 MCP Token（Authorization Bearer 优先，其次 x-mcp-token） */
export function extractMcpToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const xToken = req.headers['x-mcp-token'];
  return typeof xToken === 'string' ? xToken.trim() : undefined;
}

@Controller('ai/mcp')
export class McpController {
  constructor(private readonly mcpServer: McpServerService) {}

  /**
   * GET /api/ai/mcp — SSE 流（经典 MCP HTTP+SSE 客户端）
   */
  @Get()
  sse(@Req() req: Request, @Res() res: Response): void {
    this.mcpServer.handleSse(req, res);
  }

  /**
   * POST /api/ai/mcp — JSON-RPC 消息处理
   */
  @Post()
  async message(@Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.mcpServer.handleMessage(
      req.body,
      extractMcpToken(req),
    );
    res.status(result.httpStatus).json(result.body);
  }
}
