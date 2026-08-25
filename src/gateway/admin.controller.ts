/**
 * Admin Controller — 管理接口
 *
 * 职责：
 * 1. 工具管理：列出所有已注册工具、手动执行工具
 * 2. Provider 管理：测试连通性、列出可用 Provider
 * 3. 系统监控：健康检查（后端可达性）、审计日志查询
 *
 * 端点列表：
 * - GET  /api/admin/tools             — 列出所有工具
 * - POST /api/admin/tools/execute     — 手动执行工具
 * - GET  /api/admin/test-connection   — 测试默认 Provider 连通性
 * - GET  /api/admin/providers         — 列出所有已注册 Provider
 * - GET  /api/admin/health            — 健康检查（后端 + 数据库 + Redis + AI 服务）
 * - GET  /api/admin/audit-logs        — 查询审计日志
 *
 * 注意：
 * - R70-07 多租户接入后，所有端点需加 TenantGuard（从 JWT 解析 tenantId）
 * - 当前阶段 tenantId 通过查询参数传入（测试用）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Logger,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { AI_DB_CONNECTION } from '../database/ai-db.module';
import { AiSessionArchiveEntity } from '../database/entities/ai-session-archive.entity';
import { MemoryManager } from '../brain/memory-manager.service';
import { MetricsService } from '../common/metrics.service';
import { CircuitBreakerService } from '../tools/circuit-breaker.service';
import { ProviderFactory } from '../providers/provider-factory';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutor } from '../tools/tool-executor';
import { ServiceClient } from '../bridge/service-client';
import { AuditLogger } from '../bridge/audit-logger';
import type { ToolCall } from '../providers/provider.interface';
import type {
  ToolContext,
  ToolMeta,
  ToolResult,
} from '../tools/tool.interface';
import { ChatTestDto } from './dto/chat-test.dto';
import { ExecuteToolDto } from './dto/execute-tool.dto';

/** 数据库（MySQL）连通性检查结果 */
export interface DatabaseHealth {
  /** 是否连通 */
  connected: boolean;
  /** 检查耗时（毫秒） */
  latencyMs?: number;
  /** 失败原因（connected=false 时提供） */
  error?: string;
}

/** Redis 连通性检查结果 */
export interface RedisHealth {
  /** 是否连通 */
  connected: boolean;
  /** 检查耗时（毫秒） */
  latencyMs?: number;
  /** 失败原因（connected=false 时提供） */
  error?: string;
}

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly factory: ProviderFactory,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly serviceClient: ServiceClient,
    private readonly auditLogger: AuditLogger,
    private readonly configService: ConfigService,
    private readonly memoryManager: MemoryManager,
    private readonly metricsService: MetricsService,
    private readonly breaker: CircuitBreakerService,
    @InjectRepository(AiSessionArchiveEntity)
    private readonly sessionArchiveRepo: Repository<AiSessionArchiveEntity>,
    @Optional() private readonly dataSource?: DataSource,
    @Optional()
    @InjectDataSource(AI_DB_CONNECTION)
    private readonly aiDbDataSource?: DataSource,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // 工具管理
  // ──────────────────────────────────────────────────────────────

  /**
   * 列出所有已注册工具
   *
   * GET /api/admin/tools
   */
  @Get('tools')
  listTools(): { total: number; tools: ToolMeta[] } {
    const tools = this.registry.list();
    this.logger.log(`收到 tools 请求，返回 ${tools.length} 个工具`);
    return { total: tools.length, tools };
  }

  /**
   * 手动执行工具（测试/调试用）
   *
   * POST /api/admin/tools/execute
   */
  @Post('tools/execute')
  async executeTool(@Body() dto: ExecuteToolDto): Promise<ToolResult> {
    this.logger.log(
      `收到 tools/execute 请求：name="${dto.name}", tenantId="${dto.context.tenantId}"`,
    );

    const toolCall: ToolCall = {
      id: `manual_${Date.now()}`,
      type: 'function',
      function: {
        name: dto.name,
        arguments: JSON.stringify(dto.args ?? {}),
      },
    };

    const context: ToolContext = {
      tenantId: dto.context.tenantId,
      userId: dto.context.userId,
      sessionId: dto.context.sessionId,
      requestId: dto.context.requestId,
      role: dto.context.role,
    };

    return this.executor.executeToolCall(toolCall, context);
  }

  // ──────────────────────────────────────────────────────────────
  // Provider 管理
  // ──────────────────────────────────────────────────────────────

  /**
   * 测试默认 Provider 连通性
   *
   * GET /api/admin/test-connection
   */
  @Get('test-connection')
  async testConnection(): Promise<{
    type: string;
    success: boolean;
    message: string;
    latencyMs: number;
  }> {
    this.logger.log('收到 test-connection 请求');
    return this.factory.testConnection();
  }

  /**
   * 列出所有已注册 Provider
   *
   * GET /api/admin/providers
   */
  @Get('providers')
  listProviders(): {
    total: number;
    providers: Array<{ type: string; name: string }>;
  } {
    const providers = this.factory.listWithDetails();
    return { total: providers.length, providers };
  }

  // ──────────────────────────────────────────────────────────────
  // 非流式对话测试（R70-03 验收遗留，保留兼容）
  // ──────────────────────────────────────────────────────────────

  /**
   * 非流式对话测试
   *
   * POST /api/admin/chat-test
   */
  @Post('chat-test')
  async chatTest(@Body() dto: ChatTestDto): Promise<{
    provider: string;
    content: string;
    toolCalls?: unknown;
    usage: { promptTokens: number; completionTokens: number };
    finishReason?: string;
  }> {
    this.logger.log(
      `收到 chat-test 请求：message="${dto.message.slice(0, 50)}..."`,
    );
    const provider = this.factory.getDefault();
    const result = await provider.chatSync([
      { role: 'user', content: dto.message },
    ]);
    return {
      provider: provider.name,
      content: result.content,
      toolCalls: result.tool_calls,
      usage: {
        promptTokens: result.prompt_tokens,
        completionTokens: result.completion_tokens,
      },
      finishReason: result.finish_reason,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // 系统监控
  // ──────────────────────────────────────────────────────────────

  /**
   * 健康检查
   *
   * GET /api/admin/health
   *
   * 检查项：
   * 1. AI 底座服务状态（自身，总是 ok）
   * 2. 后端 API 可达性（通过 ServiceClient.healthCheck）
   * 3. 数据库连通性（TypeORM DataSource 执行 SELECT 1，失败不抛异常）
   * 4. Redis 连通性（ioredis ping，失败不抛异常）
   * 5. Provider 状态（通过 factory.list()）
   *
   * status 语义：
   * - ok       全部依赖连通
   * - degraded 任一依赖（后端 / 数据库 / Redis）不可达
   * - down     仅 AI 底座自身不可用（由调用方探测失败判定，本接口不返回）
   */
  @Get('health')
  async healthCheck(): Promise<{
    status: 'ok' | 'degraded' | 'down';
    aiBase: { status: string; uptime: number };
    backend: { reachable: boolean; latencyMs: number; error?: string };
    database: DatabaseHealth;
    aiDb: DatabaseHealth;
    redis: RedisHealth;
    providers: string[];
    timestamp: string;
  }> {
    const [backendHealth, database, aiDb, redis] = await Promise.all([
      this.serviceClient.healthCheck(),
      this.checkDatabase(),
      this.checkAiDb(),
      this.checkRedis(),
    ]);

    let status: 'ok' | 'degraded' | 'down' = 'ok';
    if (!backendHealth.reachable || !database.connected || !redis.connected) {
      status = 'degraded';
    }

    return {
      status,
      aiBase: {
        status: 'running',
        uptime: process.uptime(),
      },
      backend: backendHealth,
      database,
      aiDb,
      redis,
      providers: this.factory.list(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 数据库连通性检查（R70-22）
   *
   * 通过 TypeORM DataSource 执行 SELECT 1 探测。
   * 任何失败（未注入 / 连接异常）仅返回 connected=false，不抛异常。
   */
  private async checkDatabase(): Promise<DatabaseHealth> {
    if (!this.dataSource) {
      return { connected: false, error: 'DataSource 未注入' };
    }
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        connected: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 会话冷备归档查询（A4，文档 12.5：用户查看历史/审计回溯）
   *
   * GET /api/admin/session-archive?tenantId=&sessionId=&limit=
   */
  @Get('session-archive')
  async sessionArchive(
    @Query('tenantId') tenantId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit = '20',
  ): Promise<{
    total: number;
    items: AiSessionArchiveEntity[];
  }> {
    const qb = this.sessionArchiveRepo
      .createQueryBuilder('a')
      .orderBy('a.id', 'DESC')
      .take(Math.min(Number(limit) || 20, 100));
    if (tenantId) {
      qb.andWhere('a.tenant_id = :tenantId', { tenantId });
    }
    if (sessionId) {
      qb.andWhere('a.session_id = :sessionId', { sessionId });
    }
    const [items, total] = await qb.getManyAndCount();
    return { total, items };
  }

  /**
   * Prometheus 指标（A5，文档 16.3）
   *
   * GET /api/admin/metrics → Prometheus text format
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    const circuitOpen: Record<string, number> = {};
    for (const s of this.breaker.status()) {
      circuitOpen[s.toolName] = s.state === 'open' ? 1 : 0;
    }
    return this.metricsService.render(circuitOpen);
  }

  /**
   * 清除指定租户/会话的对话记忆（B6，文档 11.1/12.4）
   *
   * DELETE /api/admin/memory/:tenantId/:sessionId
   */
  @Delete('memory/:tenantId/:sessionId')
  async clearMemory(
    @Param('tenantId') tenantId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.memoryManager.clearHistory(tenantId, sessionId);
    this.logger.log(`会话记忆已清除：tenant=${tenantId} session=${sessionId}`);
    return { success: true, message: '会话记忆已清除' };
  }

  /**
   * ai_db（AI 底座私有库）连通性检查（B4，文档 16.1）
   */
  private async checkAiDb(): Promise<DatabaseHealth> {
    if (!this.aiDbDataSource) {
      return { connected: false, error: 'ai_db DataSource 未注入（未连接）' };
    }
    const start = Date.now();
    try {
      await this.aiDbDataSource.query('SELECT 1');
      return { connected: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        connected: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Redis 连通性检查（R70-22）
   *
   * 使用 ioredis 按 .env 配置建立临时连接并 ping。
   * - 先注册 error 监听，避免连接失败触发 unhandled error 事件导致进程崩溃
   * - connectTimeout 3s / 不重连，健康检查快速失败
   * - 无论成功失败均 disconnect，避免连接句柄泄漏
   * 任何失败仅返回 connected=false，不抛异常。
   */
  private async checkRedis(): Promise<RedisHealth> {
    const host = this.configService.get<string>('REDIS_HOST', '127.0.0.1');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password =
      this.configService.get<string>('REDIS_PASSWORD') || undefined;
    const db = this.configService.get<number>('REDIS_DB', 1);

    const client = new Redis({
      host,
      port,
      password,
      db,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      // 健康检查不重连：返回 null 立即停止重试，快速失败
      retryStrategy: () => null,
    });

    const start = Date.now();
    try {
      // 先注册 error 监听（ioredis 连接失败/重试停止时会 emit error，
      // 若无监听将触发 Node unhandled error 事件导致进程崩溃）
      client.on('error', (err: Error) => {
        this.logger.warn(`Redis 健康检查连接错误：${err.message}`);
      });

      await client.ping();
      const latencyMs = Date.now() - start;
      client.disconnect();
      return { connected: true, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      client.disconnect();
      return {
        connected: false,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 查询审计日志
   *
   * GET /api/admin/audit-logs?tenantId=xxx&page=1&pageSize=20
   *
   * 查询参数：
   * - tenantId（必填）：租户 ID
   * - startDate（可选）：开始日期 YYYY-MM-DD
   * - endDate（可选）：结束日期 YYYY-MM-DD
   * - intent（可选）：意图标签
   * - sessionId（可选）：会话 ID
   * - page（可选）：页码，默认 1
   * - pageSize（可选）：每页条数，默认 20
   */
  @Get('audit-logs')
  async queryAuditLogs(
    @Query('tenantId') tenantId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('intent') intent?: string,
    @Query('sessionId') sessionId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{
    list: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (!tenantId) {
      return { list: [], total: 0, page: 1, pageSize: 20 };
    }

    const result = await this.auditLogger.queryAuditLogs(tenantId, {
      startDate,
      endDate,
      intent,
      sessionId,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    });

    return {
      list: result.list,
      total: result.total,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    };
  }
}
