/**
 * P0-3 McpServerService 单元测试
 *
 * 覆盖：
 * 1. 认证失败 → 401 + JSON-RPC error
 * 2. initialize / ping / tools/list
 * 3. tools/call 读工具成功
 * 4. tools/call 写工具 preview → 挂起 WriteGuard + pendingWriteToken
 * 5. write_guard_confirm（confirm 执行 / cancel 取消 / 高危二次确认）
 * 6. 未知方法 / 非法 JSON
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { McpServerService } from './mcp-server.service';
import type { ToolResult } from '../../tools/tool.interface';

function createServer(overrides?: {
  validateResult?: unknown;
  toolResult?: ToolResult;
  registryGet?: unknown;
  confirmResult?: Record<string, unknown>;
}) {
  const tokenService = {
    validate: jest
      .fn()
      .mockResolvedValue(overrides?.validateResult ?? { tenantId: 't_001' }),
  };
  const registry = {
    listForTenant: jest.fn().mockReturnValue([
      {
        name: 'queryInventory',
        description: '查询库存',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'createSalesOrder',
        description: '创建销售单（写操作）',
        parameters: { type: 'object', properties: {} },
      },
    ]),
    get: jest.fn().mockReturnValue(
      overrides?.registryGet ?? {
        risk: 'medium',
        needsReview: false,
      },
    ),
  };
  const executor = {
    executeToolCall: jest
      .fn()
      .mockResolvedValue(
        overrides?.toolResult ?? { success: true, data: { stock: 52 } },
      ),
  };
  const writeGuard = {
    suspend: jest
      .fn()
      .mockResolvedValue({ token: 'wg_mcp_123', status: 'pending' }),
    cancel: jest.fn().mockResolvedValue(true),
  };
  const confirmationService = {
    confirmAndExecute: jest.fn().mockResolvedValue(
      overrides?.confirmResult ?? {
        success: true,
        data: { billNo: 'SB20260825001' },
        operationId: 'op-1',
        message: '创建销售单执行成功，3 分钟内可撤销',
      },
    ),
  };
  const configService = {
    get: jest.fn().mockReturnValue('test-secret'),
  };

  const server = new McpServerService(
    registry as never,
    executor as never,
    tokenService as never,
    writeGuard as never,
    confirmationService as never,
    configService as never,
  );
  return {
    server,
    tokenService,
    executor,
    writeGuard,
    confirmationService,
  };
}

describe('P0-3 McpServerService', () => {
  it('未认证：返回 401 + JSON-RPC error -32001', async () => {
    const { server, tokenService } = createServer({
      validateResult: null,
    });
    tokenService.validate.mockResolvedValueOnce(null);

    const result = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      'bad-token',
    );

    expect(result.httpStatus).toBe(401);
    const body = result.body as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  it('initialize：返回协议版本、能力与 Server 信息', async () => {
    const { server } = createServer();
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      },
      'mcp_valid',
    );

    expect(result.httpStatus).toBe(200);
    const body = result.body as {
      result: {
        protocolVersion: string;
        capabilities: { tools: object };
        serverInfo: { name: string };
      };
    };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toEqual({});
    expect(body.result.serverInfo.name).toBe('zhixiang-ai-base');
  });

  it('ping：返回空 result', async () => {
    const { server } = createServer();
    const result = await server.handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      'mcp_valid',
    );
    expect((result.body as { result: unknown }).result).toEqual({});
  });

  it('tools/list：返回全部工具 + write_guard_confirm', async () => {
    const { server } = createServer();
    const result = await server.handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      'mcp_valid',
    );

    const body = result.body as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('queryInventory');
    expect(names).toContain('createSalesOrder');
    expect(names).toContain('write_guard_confirm');
  });

  it('tools/call：读工具成功返回数据 JSON', async () => {
    const { server, executor } = createServer();
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'queryInventory', arguments: { skuName: '五粮液' } },
      },
      'mcp_valid',
    );

    expect(executor.executeToolCall).toHaveBeenCalled();
    const body = result.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0].text)).toEqual({ stock: 52 });
  });

  it('tools/call：写工具返回 preview → 挂起 WriteGuard 并返回令牌', async () => {
    const { server, writeGuard } = createServer({
      toolResult: {
        success: true,
        preview: {
          operation: '创建销售单',
          summary: '红星商行 5 箱五粮液',
          details: { customerName: '红星商行' },
        },
      },
    });
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'createSalesOrder',
          arguments: { customerName: '红星商行' },
        },
      },
      'mcp_valid',
    );

    expect(writeGuard.suspend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_001',
        toolName: 'createSalesOrder',
      }),
    );
    const body = result.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0].text).toContain('【待确认】创建销售单');
    expect(body.result.content[0].text).toContain('wg_mcp_123');
  });

  it('write_guard_confirm：confirm 执行写操作', async () => {
    const { server, confirmationService } = createServer();
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'write_guard_confirm',
          arguments: { token: 'wg_mcp_123', action: 'confirm' },
        },
      },
      'mcp_valid',
    );

    expect(confirmationService.confirmAndExecute).toHaveBeenCalledWith(
      'wg_mcp_123',
      't_001',
      expect.objectContaining({ tenantId: 't_001' }),
      undefined,
    );
    const body = result.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      success: true,
      operationId: 'op-1',
    });
  });

  it('write_guard_confirm：高危写首次确认提示二次确认', async () => {
    const { server } = createServer({
      confirmResult: {
        success: true,
        needsSecondConfirm: true,
        message: '高危操作需二次确认',
      },
    });
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'write_guard_confirm',
          arguments: { token: 'wg_mcp_123', action: 'confirm' },
        },
      },
      'mcp_valid',
    );
    const body = result.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0].text).toContain('二次确认');
  });

  it('write_guard_confirm：cancel 取消操作', async () => {
    const { server, writeGuard } = createServer();
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'write_guard_confirm',
          arguments: { token: 'wg_mcp_123', action: 'cancel' },
        },
      },
      'mcp_valid',
    );
    expect(writeGuard.cancel).toHaveBeenCalledWith('wg_mcp_123', 't_001');
    const body = result.body as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0].text).toBe('操作已取消');
  });

  it('未知方法：返回 -32601', async () => {
    const { server } = createServer();
    const result = await server.handleMessage(
      { jsonrpc: '2.0', id: 9, method: 'resources/list' },
      'mcp_valid',
    );
    const body = result.body as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('非法 JSON：返回 -32700', async () => {
    const { server } = createServer();
    const result = await server.handleMessage('not-json', 'mcp_valid');
    const body = result.body as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('工具执行失败：返回 isError 文本', async () => {
    const { server } = createServer({
      toolResult: {
        success: false,
        error: '库存不足',
        suggestion: '请减少数量',
      },
    });
    const result = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'createSalesOrder', arguments: {} },
      },
      'mcp_valid',
    );
    const body = result.body as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('库存不足');
  });
});
