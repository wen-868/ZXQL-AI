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
          resolve(Buffer.from(data as ArrayBuffer).toString('utf8'));
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

  // ── R101-AI-45：定向推送（sendToUser） ──
  describe('定向推送 sendToUser', () => {
    /** 生成本用例用 token（id 即用户 ID，定向投递的目标） */
    function tokenFor(tenantId: string, id: number): string {
      return jwt.sign(
        { id, username: `u${id}`, roles: ['STORE_MANAGER'], tenantId },
        JWT_SECRET,
        {
          issuer: 'zhixiang-system',
          audience: 'zhixiang-client',
          expiresIn: '1h',
        },
      );
    }

    const PAYLOAD = {
      title: '📅 日程提醒',
      content: '与供应商洽谈价格',
      type: 'system',
      priority: 'reminder' as const,
      pushedAt: '2026-10-18T00:00:00.000Z',
    };

    it('① 同租户同用户在线 ⇒ 定向送达（delivered=1 且收到消息）', async () => {
      const socket = await connect(port, tokenFor('tenant-1', 42));

      const delivered = service.sendToUser('tenant-1', 42, PAYLOAD);
      const raw = await new Promise<string>((resolve) => {
        socket.once('message', (data) =>
          resolve(
            typeof data === 'string'
              ? data
              : Buffer.from(data as ArrayBuffer).toString('utf8'),
          ),
        );
      });

      expect(delivered).toBe(1);
      const message = JSON.parse(raw) as { data: { title: string } };
      expect(message.data.title).toBe('📅 日程提醒');
      socket.close();
    });

    it('② 同租户【不同】用户在线 ⇒ 不投递（delivered=0，私人提醒不串人）', async () => {
      const socket = await connect(port, tokenFor('tenant-1', 7));
      let received = false;
      socket.on('message', () => {
        received = true;
      });

      // 目标是 user 42，但线上只有 user 7
      const delivered = service.sendToUser('tenant-1', 42, PAYLOAD);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(delivered).toBe(0);
      expect(received).toBe(false);
      socket.close();
    });

    it('③ 跨租户同 userId ⇒ 不投递（userId 与 tenantId 联合定位）', async () => {
      const socket = await connect(port, tokenFor('tenant-b', 42));
      let received = false;
      socket.on('message', () => {
        received = true;
      });

      const delivered = service.sendToUser('tenant-a', 42, PAYLOAD);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(delivered).toBe(0);
      expect(received).toBe(false);
      socket.close();
    });

    it('④ 未初始化 ⇒ sendToUser 返回 0（不抛）', () => {
      const bare = makeService();
      expect(bare.sendToUser('tenant-1', 42, PAYLOAD)).toBe(0);
    });
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

  /**
   * R101-AI-26 ① 反测：心跳定时器必须随模块销毁被清理
   *
   * 缺陷背景：`close()` 能清 `heartbeatTimer`，但此前**全仓零调用方** ⇒ 应用关闭时
   * 定时器不会被清理（`setInterval` 一直挂到进程退出）。修复 = 实现 `OnModuleDestroy`。
   *
   * 反测方式（假定时器 + clearInterval spy 双重断言）：
   * 1. 注入假 client，推进 30s ⇒ 心跳触发（ping 1 次）——证明定时器确实在跑；
   * 2. 调用 `onModuleDestroy()` ⇒ `clearInterval` 被调用；
   * 3. 再推进 120s ⇒ ping 次数不再增加 —— 证明"销毁后定时器不再触发"。
   * 若把 `implements OnModuleDestroy` / `onModuleDestroy()` 去掉，本用例第 3 步会红。
   */
  it('R101-AI-26①：onModuleDestroy 停止心跳定时器（销毁后不再触发）', async () => {
    const started = await startHttpServer();
    jest.useFakeTimers();
    const clearSpy = jest.spyOn(global, 'clearInterval');
    try {
      const svc = makeService();
      svc.init(started.server);

      const server = (svc as unknown as { server: { clients: Set<unknown> } })
        .server;
      const fakeClient = {
        isAlive: true,
        ping: jest.fn(),
        terminate: jest.fn(),
      };
      server.clients.add(fakeClient);

      jest.advanceTimersByTime(30_000);
      expect(fakeClient.ping).toHaveBeenCalledTimes(1);

      svc.onModuleDestroy();

      expect(clearSpy).toHaveBeenCalled();
      jest.advanceTimersByTime(120_000);
      expect(fakeClient.ping).toHaveBeenCalledTimes(1);
      expect(svc.onlineTenantCount()).toBe(0);
      // 幂等：重复销毁不抛
      expect(() => svc.onModuleDestroy()).not.toThrow();
    } finally {
      clearSpy.mockRestore();
      jest.useRealTimers();
      started.server.close();
    }
  });
});
