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
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';

/** 带存活标记的 WebSocket 连接（心跳保活） */
type AliveWebSocket = WebSocket & { isAlive?: boolean; userId?: number };

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
export class PushGatewayService implements OnModuleDestroy {
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
    // 1. 从 URL 查询参数提取 token 并验证（同时取回租户与用户身份）
    const identity = this.authenticate(request.url ?? '');
    if (!identity) {
      this.logger.debug(
        `WebSocket 认证失败，拒绝连接：${request.url ?? '(无URL)'}`,
      );
      socket.close(CLOSE_CODE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const { tenantId, userId } = identity;

    // 2. 注册租户连接
    socket.isAlive = true;
    // R101-AI-45 定向推送：把用户身份挂到连接上（sendToUser 用它过滤目标）
    socket.userId = userId;
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
   * @returns `{ tenantId, userId }`，认证失败返回 undefined
   *          （R101-AI-45：userId 从 payload.id 取，供定向推送使用；
   *           旧调用方只用 tenantId 的场景不受影响）
   */
  private authenticate(
    url: string,
  ): { tenantId: string; userId?: number } | undefined {
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
      return { tenantId: payload.tenantId, userId: payload.id };
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
   * R101-AI-45 定向推送：只投递给指定租户下指定用户的在线连接
   *
   * 用途：日程提醒的 owner/participants（`tenant:{id}` 广播之外的精确通道）、
   *      审批待办等"只该某人看到"的推送。
   * 语义：
   * - 只投 `socket.userId === userId` 的连接；该用户不在线 ⇒ 0（不回落广播，
   *   避免把私人提醒推给同租户其他人 —— 那是信息泄漏）
   * - 用户侧仍可靠"站内通知"兜底（错过 WebSocket 不丢）
   *
   * @param tenantId 目标租户（与 userId 联合定位，防跨租户误投）
   * @param userId   目标用户 ID（来自 JWT payload.id）
   * @param payload  推送载荷（与 broadcast 对齐）
   * @returns 送达连接数（仅统计发送成功的连接）
   */
  sendToUser(tenantId: string, userId: number, payload: PushPayload): number {
    const group = this.tenants.get(tenantId);
    if (!group || group.size === 0) return 0;

    const data = JSON.stringify({
      event: 'ai_proactive_push',
      data: payload,
    });
    let delivered = 0;
    group.forEach((socket) => {
      if (socket.userId === userId && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    });

    this.logger.debug(
      `AI 主动推送定向投递：tenant=${tenantId} user=${userId} delivered=${delivered}/${group.size} title=${payload.title}`,
    );
    return delivered;
  }

  /**
   * 关闭全部连接并停止心跳（优雅关闭 / 测试清理用）
   *
   * R101-AI-26 ①：本方法此前**全仓零调用方** ⇒ 心跳 `setInterval` 在应用关闭时
   * 不会被清理（进程被 kill 时靠 `unref` 兜底，但正常 shutdown/测试场景会泄漏定时器）。
   * 现由 `onModuleDestroy` 调用；**业务行为零变化**（连接/心跳/广播逻辑未改）。
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

  /**
   * 应用关闭钩子（R101-AI-26 ①）：清理心跳定时器与全部连接
   *
   * 照 `employee.service.ts:385` 的 `OnModuleDestroy` 现成范式；不改变任何
   * WebSocket 业务行为（仅在模块销毁时调用上面已有的 `close()`）。
   */
  onModuleDestroy(): void {
    this.close();
  }
}
