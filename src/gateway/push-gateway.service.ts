/**
 * PushGatewayService — AI 主动推送实时通道（WebSocket）
 *
 * 职责（AI 底座完善度 P1-主动推送前端联调）：
 * 1. 提供 WebSocket 端点 /api/ai/ws，前端登录后携带 JWT 连接
 * 2. 认证与 TenantMiddleware 对齐：HS256 + issuer=zhixiang-system + audience=zhixiang-client，
 *    从 payload 解析 tenantId，按租户建立连接分组
 * 3. 巡检推送落库后通过 broadcast() 实时推送给该租户的在线前端
 *
 * 设计说明：
 * - 采用原生 ws 库挂载到 NestJS HTTP server（不引入 socket.io 重型依赖）
 * - 连接按租户分组：Map<tenantId, Set<WebSocket>>，多端在线同时可达
 * - 心跳 30s ping / 60s 无 pong 强制断开，避免僵尸连接
 * - 认证失败关闭连接（code 4401），与 HTTP 401 语义对齐
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P1 主动推送前端联调
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';

/** 带存活标记的 WebSocket 连接（心跳保活） */
type AliveWebSocket = WebSocket & { isAlive?: boolean };

/** 后端 JWT payload 结构（与 TenantMiddleware / backend auth.ts 对齐） */
interface AuthUserPayload extends JwtPayload {
  id: number;
  username: string;
  tenantId: string;
}

/** 推送消息载荷（对齐 ProactivePush：title/content/type/priority/extras） */
export interface PushPayload {
  title: string;
  content: string;
  type: string;
  priority: string;
  extras?: Record<string, unknown>;
  /** 服务端落库时间（ISO 字符串） */
  pushedAt: string;
}

/** WebSocket 连接心跳配置 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 认证失败关闭码（与 HTTP 401 语义对齐） */
const CLOSE_CODE_UNAUTHORIZED = 4401;

@Injectable()
export class PushGatewayService {
  private readonly logger = new Logger(PushGatewayService.name);
  private readonly jwtSecret: string;
  private server?: WebSocketServer;
  /** 租户 ID → 在线连接集合 */
  private readonly tenants = new Map<string, Set<AliveWebSocket>>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', '');
    if (!this.jwtSecret) {
      this.logger.warn(
        'JWT_SECRET 未配置，WebSocket 推送通道将拒绝所有连接（无法校验租户身份）',
      );
    }
  }

  /**
   * 初始化 WebSocket 服务器（应用启动时调用，挂载到 NestJS HTTP server）
   *
   * @param server NestJS 底层 HTTP server
   */
  init(httpServer: HttpServer): void {
    if (this.server) {
      this.logger.warn('PushGatewayService 已初始化，跳过重复初始化');
      return;
    }

    this.server = new WebSocketServer({
      server: httpServer,
      path: '/api/ai/ws',
    });

    this.server.on('connection', (socket, request) => {
      this.handleConnection(socket, request);
    });

    // 心跳：定期 ping，未响应 pong 的连接标记后清理
    this.heartbeatTimer = setInterval(() => {
      this.server?.clients.forEach((client) => {
        const alive = client as AliveWebSocket;
        if (!alive.isAlive) {
          alive.terminate();
          return;
        }
        alive.isAlive = false;
        alive.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();

    this.logger.log('AI 主动推送 WebSocket 通道已启动：/api/ai/ws');
  }

  /**
   * 处理新连接：JWT 认证 → 按租户注册 → pong 保活
   */
  private handleConnection(
    socket: AliveWebSocket,
    request: import('http').IncomingMessage,
  ): void {
    // 1. 从 URL 查询参数提取 token 并验证
    const tenantId = this.authenticate(request.url ?? '');
    if (!tenantId) {
      this.logger.debug(
        `WebSocket 认证失败，拒绝连接：${request.url ?? '(无URL)'}`,
      );
      socket.close(CLOSE_CODE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    // 2. 注册租户连接
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('close', () => this.removeConnection(tenantId, socket));
    socket.on('error', (err) => {
      this.logger.debug(
        `WebSocket 连接错误（tenant=${tenantId}）：${err.message}`,
      );
    });

    let group = this.tenants.get(tenantId);
    if (!group) {
      group = new Set<AliveWebSocket>();
      this.tenants.set(tenantId, group);
    }
    group.add(socket);

    this.logger.debug(
      `WebSocket 连接已建立：tenant=${tenantId}，在线连接数=${group.size}`,
    );
  }

  /**
   * 从连接 URL 提取 JWT 并验证租户身份
   *
   * @param url 连接 URL（含 ?token=xxx 查询参数）
   * @returns 租户 ID，认证失败返回 undefined
   */
  private authenticate(url: string): string | undefined {
    if (!this.jwtSecret) return undefined;

    let token: string | null = null;
    try {
      token = new URL(url, 'http://localhost').searchParams.get('token');
    } catch {
      return undefined;
    }
    if (!token) return undefined;

    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'zhixiang-system',
        audience: 'zhixiang-client',
      }) as AuthUserPayload;

      if (!payload.tenantId) {
        this.logger.debug(
          `WebSocket JWT 验证成功但 payload 无 tenantId（user=${payload.username}）`,
        );
        return undefined;
      }
      return payload.tenantId;
    } catch (err) {
      this.logger.debug(
        `WebSocket JWT 验证失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * 从租户连接分组移除指定连接（连接关闭时调用）
   */
  private removeConnection(tenantId: string, socket: AliveWebSocket): void {
    const group = this.tenants.get(tenantId);
    if (!group) return;
    group.delete(socket);
    if (group.size === 0) {
      this.tenants.delete(tenantId);
    }
  }

  /**
   * 向指定租户的全部在线连接实时推送消息
   *
   * @param tenantId 目标租户
   * @param payload  推送载荷（与 ProactivePush 对齐）
   * @returns 送达连接数（仅统计发送成功的连接）
   */
  broadcast(tenantId: string, payload: PushPayload): number {
    const group = this.tenants.get(tenantId);
    if (!group || group.size === 0) return 0;

    const data = JSON.stringify({
      event: 'ai_proactive_push',
      data: payload,
    });
    let delivered = 0;
    group.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    });

    this.logger.debug(
      `AI 主动推送实时广播：tenant=${tenantId} delivered=${delivered}/${group.size} title=${payload.title}`,
    );
    return delivered;
  }

  /**
   * 当前在线租户数（测试/健康检查用）
   */
  onlineTenantCount(): number {
    return this.tenants.size;
  }

  /**
   * 关闭全部连接并停止心跳（优雅关闭 / 测试清理用）
   */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.server?.clients.forEach((client) => client.terminate());
    this.server?.close();
    this.server = undefined;
    this.tenants.clear();
  }
}
