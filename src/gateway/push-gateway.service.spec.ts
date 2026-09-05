/**
 * PushGatewayService 单元测试
 *
 * 覆盖：JWT 认证（缺 token / 无效 token / 有效 token）、按租户注册、
 *      实时广播送达、断开清理、close 全量清理
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { PushGatewayService } from './push-gateway.service';

const JWT_SECRET = 'test-jwt-secret';
const WS_PATH = '/api/ai/ws';

/** 构造服务（ConfigService 仅提供 JWT_SECRET） */
function makeService(): PushGatewayService {
  const config = {
    get: jest.fn((key: string) =>
      key === 'JWT_SECRET' ? JWT_SECRET : undefined,
    ),
  };
  return new PushGatewayService(config as unknown as ConfigService);
}

/** 启动一个 HTTP server 返回端口号 */
async function startHttpServer(): Promise<{
  server: HttpServer;
  port: number;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

/** 生成合法 JWT（不显式传 algorithm：字符串密钥默认即 HS256，生产验签侧已固定） */
function makeToken(tenantId = 'tenant-1', username = 'store_manager'): string {
  return jwt.sign(
    { id: 1, username, roles: ['STORE_MANAGER'], tenantId },
    JWT_SECRET,
    {
      issuer: 'zhixiang-system',
      audience: 'zhixiang-client',
      expiresIn: '1h',
    },
  );
}

/** 连接 WebSocket 并等待 open（拒绝时等待 close） */
function connect(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${port}${WS_PATH}?token=${token}`
      : `ws://127.0.0.1:${port}${WS_PATH}`;
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', (err) => reject(err));
  });
}

/** 等待连接被关闭，返回关闭码 */
function waitClose(socket: WebSocket): Promise<number | undefined> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

describe('PushGatewayService', () => {
  let service: PushGatewayService;
  let httpServer: HttpServer;
  let port: number;

  beforeEach(async () => {
    service = makeService();
    const started = await startHttpServer();
    httpServer = started.server;
    port = started.port;
    service.init(httpServer);
  });

  afterEach(() => {
    service.close();
    httpServer.close();
  });

  it('未初始化时广播返回 0', () => {
    const bare = makeService();
    expect(
      bare.broadcast('tenant-1', {
        title: 't',
        content: 'c',
        type: 'system',
        priority: 'reminder',
        pushedAt: '',
      }),
    ).toBe(0);
  });

  it('缺少 token 的连接被拒绝（4401）', async () => {
    const socket = await connect(port);
    const code = await waitClose(socket);
    expect(code).toBe(4401);
  });

  it('无效 token 的连接被拒绝（4401）', async () => {
    const socket = await connect(port, 'not-a-jwt');
    const code = await waitClose(socket);
    expect(code).toBe(4401);
  });

  it('有效 token 注册租户并实时收到推送', async () => {
    const socket = await connect(port, makeToken('tenant-1'));

    const delivered = service.broadcast('tenant-1', {
      title: '⚠️ 库存预警',
      content: '五粮液库存不足',
      type: 'inventory',
      priority: 'urgent',
      extras: { task: 'inventory_warning' },
      pushedAt: '2026-08-15T00:00:00.000Z',
    });

    const raw = await new Promise<string>((resolve) => {
      socket.once('message', (data) => {
        // ws 消息载荷可能是 string / Buffer / ArrayBuffer / Buffer[]，统一转 UTF-8 文本
        if (typeof data === 'string') {
          resolve(data);
        } else if (Array.isArray(data)) {
          resolve(Buffer.concat(data).toString('utf8'));
        } else {
          resolve(Buffer.from(data).toString('utf8'));
        }
      });
    });
    const message = JSON.parse(raw) as {
      event: string;
      data: { title: string; priority: string; extras: { task: string } };
    };

    expect(delivered).toBe(1);
    expect(message.event).toBe('ai_proactive_push');
    expect(message.data.title).toBe('⚠️ 库存预警');
    expect(message.data.priority).toBe('urgent');
    expect(message.data.extras.task).toBe('inventory_warning');
    socket.close();
  });

  it('按租户隔离：其他租户连接收不到推送', async () => {
    const socketA = await connect(port, makeToken('tenant-a'));
    const socketB = await connect(port, makeToken('tenant-b'));

    let receivedB = false;
    socketB.on('message', () => {
      receivedB = true;
    });

    service.broadcast('tenant-a', {
      title: '仅租户A',
      content: 'c',
      type: 'system',
      priority: 'reminder',
      pushedAt: '',
    });
    // 给消息一个事件循环机会，确认 B 未收到
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedB).toBe(false);
    socketA.close();
    socketB.close();
  });

  it('连接断开后租户分组清理', async () => {
    const socket = await connect(port, makeToken('tenant-1'));
    expect(service.onlineTenantCount()).toBe(1);

    socket.close();
    await waitClose(socket);
    // 等待服务端 close 事件处理
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(service.onlineTenantCount()).toBe(0);
  });

  it('close 清理全部连接', async () => {
    const socket = await connect(port, makeToken('tenant-1'));
    expect(service.onlineTenantCount()).toBe(1);

    service.close();

    expect(service.onlineTenantCount()).toBe(0);
    // terminate 后客户端状态异步变为 CLOSED，等待 close 事件确认
    await waitClose(socket);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
