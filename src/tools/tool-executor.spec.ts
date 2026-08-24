import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';
import { EchoTool } from './definitions/echo.tool';
import type {
  ITool,
  ToolContext,
  ToolResult,
  ToolExecutionRecord,
} from './tool.interface';
import type { ToolCall } from '../providers/provider.interface';
import type { AuditLogger } from '../bridge/audit-logger';

/**
 * ToolExecutor 单元测试
 *
 * 验证参数解析/工具查找/执行成功/执行异常/批量执行/多租户兜底等核心能力。
 */

const baseContext: ToolContext = { tenantId: 'tenant-001', userId: 'u1' };

/**
 * 构造一个 ToolCall（模拟 LLM 返回的 function call）
 */
function makeToolCall(name: string, args: unknown): ToolCall {
  return {
    id: `call_${name}_${Date.now()}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

/**
 * Mock AuditLogger — 不实际写库，仅记录调用
 */
function createMockAuditLogger(): AuditLogger {
  const mock: Partial<AuditLogger> = {
    logToolExecution: jest.fn((_record: ToolExecutionRecord) => {
      // Mock: 不实际写库
    }),
    logAiCall: jest.fn(),
  };
  return mock as AuditLogger;
}

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let mockAuditLogger: AuditLogger;

  beforeEach(() => {
    registry = new ToolRegistry();
    mockAuditLogger = createMockAuditLogger();
    executor = new ToolExecutor(registry, mockAuditLogger);
  });

  describe('executeToolCall - 执行成功', () => {
    it('应能执行已注册的 EchoTool 并返回回显结果', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', { message: 'hello' }),
        baseContext,
      );
      expect(result.success).toBe(true);
      expect((result.data as { echo: string }).echo).toBe('hello');
    });

    it('执行成功时不应携带 error 字段', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', { message: 'test' }),
        baseContext,
      );
      expect(result.error).toBeUndefined();
    });
  });

  describe('executeToolCall - 参数解析失败', () => {
    it('arguments 为非法 JSON 应返回 success=false + 友好错误', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', '{invalid json}'),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('参数 JSON 解析失败');
      expect(result.suggestion).toBeDefined();
    });

    it('arguments 为空字符串应返回 success=false', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', ''),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('解析失败');
    });
  });

  describe('executeToolCall - 工具不存在', () => {
    it('调用未注册的工具应返回 success=false + 可用工具列表', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('notExist', {}),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('未注册');
      expect(result.suggestion).toContain('echo');
    });
  });

  describe('executeToolCall - 多租户兜底', () => {
    it('context 缺少 tenantId 应返回 success=false', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', { message: 'hi' }),
        { tenantId: '' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('tenantId');
    });

    it('context.tenantId 为 undefined 应返回 success=false', async () => {
      registry.register(new EchoTool());
      const result = await executor.executeToolCall(
        makeToolCall('echo', { message: 'hi' }),
        {} as ToolContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('tenantId');
    });
  });

  describe('executeToolCall - 工具内部异常兜底', () => {
    it('tool.execute reject Error 时应返回 success=false + 错误信息（不向外抛）', async () => {
      const throwingTool: ITool = {
        name: 'throwing',
        description: '会抛异常的工具',
        parameters: { type: 'object', properties: {} },
        category: 'utility',
        isWriteOperation: false,
        execute: (): Promise<ToolResult> =>
          Promise.reject(new Error('模拟内部异常')),
      };
      registry.register(throwingTool);

      // 不应抛异常
      const result = await executor.executeToolCall(
        makeToolCall('throwing', {}),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('工具执行异常');
      expect(result.error).toContain('模拟内部异常');
      expect(result.suggestion).toBeDefined();
    });

    it('tool.execute reject 非 Error 值时应安全处理（String 转换）', async () => {
      const throwingTool: ITool = {
        name: 'throwNonError',
        description: 'reject 非 Error',
        parameters: { type: 'object', properties: {} },
        category: 'utility',
        isWriteOperation: false,
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 测试目的就是验证非 Error reject 的兜底处理
        execute: (): Promise<ToolResult> => Promise.reject('string error'),
      };
      registry.register(throwingTool);
      const result = await executor.executeToolCall(
        makeToolCall('throwNonError', {}),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('string error');
    });
  });

  describe('executeToolCall - 工具返回失败结果', () => {
    it('tool.execute 返回 success=false 应原样透传', async () => {
      const failTool: ITool = {
        name: 'failTool',
        description: '返回失败的工具',
        parameters: { type: 'object', properties: {} },
        category: 'order',
        isWriteOperation: true,
        execute: (): Promise<ToolResult> =>
          Promise.resolve({
            success: false,
            error: '库存不足',
            suggestion: '请先补货或减少数量',
          }),
      };
      registry.register(failTool);
      const result = await executor.executeToolCall(
        makeToolCall('failTool', {}),
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('库存不足');
      expect(result.suggestion).toBe('请先补货或减少数量');
    });
  });

  describe('executeToolCalls - 批量执行', () => {
    beforeEach(() => {
      registry.register(new EchoTool());
    });

    it('空数组应返回空数组', async () => {
      const messages = await executor.executeToolCalls([], baseContext);
      expect(messages).toEqual([]);
    });

    it('单个 tool_call 应返回 1 条 tool 角色 ChatMessage', async () => {
      const messages = await executor.executeToolCalls(
        [makeToolCall('echo', { message: 'hi' })],
        baseContext,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('tool');
      expect(messages[0].tool_call_id).toBeDefined();
      expect(messages[0].name).toBe('echo');
      // content 应为 ToolResult 的 JSON 字符串
      const parsed = JSON.parse(messages[0].content) as ToolResult;
      expect(parsed.success).toBe(true);
      expect((parsed.data as { echo: string }).echo).toBe('hi');
    });

    it('多个 tool_calls 应并发执行并保持顺序一致', async () => {
      const calls = [
        makeToolCall('echo', { message: 'first' }),
        makeToolCall('echo', { message: 'second' }),
        makeToolCall('echo', { message: 'third' }),
      ];
      const messages = await executor.executeToolCalls(calls, baseContext);
      expect(messages).toHaveLength(3);
      expect(messages[0].tool_call_id).toBe(calls[0].id);
      expect(messages[1].tool_call_id).toBe(calls[1].id);
      expect(messages[2].tool_call_id).toBe(calls[2].id);

      const result0 = JSON.parse(messages[0].content) as ToolResult;
      const result1 = JSON.parse(messages[1].content) as ToolResult;
      const result2 = JSON.parse(messages[2].content) as ToolResult;
      expect((result0.data as { echo: string }).echo).toBe('first');
      expect((result1.data as { echo: string }).echo).toBe('second');
      expect((result2.data as { echo: string }).echo).toBe('third');
    });

    it('部分工具失败不影响其他工具执行', async () => {
      const calls = [
        makeToolCall('echo', { message: 'ok' }),
        makeToolCall('notExist', {}),
        makeToolCall('echo', { message: 'ok2' }),
      ];
      const messages = await executor.executeToolCalls(calls, baseContext);
      expect(messages).toHaveLength(3);
      const r0 = JSON.parse(messages[0].content) as ToolResult;
      const r1 = JSON.parse(messages[1].content) as ToolResult;
      const r2 = JSON.parse(messages[2].content) as ToolResult;
      expect(r0.success).toBe(true);
      expect(r1.success).toBe(false);
      expect(r2.success).toBe(true);
    });
  });
});
