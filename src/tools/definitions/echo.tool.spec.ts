import { EchoTool } from './echo.tool';

/**
 * EchoTool 单元测试
 *
 * 验证示例工具的参数校验和回显逻辑，作为 Tool 系统框架的最小验收用例。
 */
describe('EchoTool', () => {
  let tool: EchoTool;

  beforeEach(() => {
    tool = new EchoTool();
  });

  describe('工具元信息', () => {
    it('应正确定义 name/description/category/isWriteOperation', () => {
      expect(tool.name).toBe('echo');
      expect(tool.description).toContain('回显工具');
      expect(tool.category).toBe('utility');
      expect(tool.isWriteOperation).toBe(false);
    });

    it('parameters 应为合法 JSON Schema 对象，含 message 必填字段', () => {
      expect(tool.parameters).toHaveProperty('type', 'object');
      expect(tool.parameters).toHaveProperty('properties.message');
      expect(tool.parameters).toHaveProperty('required', ['message']);
    });
  });

  describe('execute - 正常回显', () => {
    it('传入字符串 message 应返回 success=true + echo 内容 + 时间戳', async () => {
      const result = await tool.execute(
        { message: '你好' },
        { tenantId: 't1' },
      );
      expect(result.success).toBe(true);
      const data = result.data as { echo: string; receivedAt: string };
      expect(data.echo).toBe('你好');
      expect(typeof data.receivedAt).toBe('string');
      // receivedAt 应为合法 ISO 时间字符串
      expect(data.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('传入长字符串应正常回显', async () => {
      const longMsg = 'A'.repeat(1000);
      const result = await tool.execute(
        { message: longMsg },
        { tenantId: 't1' },
      );
      expect(result.success).toBe(true);
      expect((result.data as { echo: string }).echo).toBe(longMsg);
    });
  });

  describe('execute - 参数校验失败', () => {
    it('message 非字符串应返回 success=false + 错误提示', async () => {
      const result = await tool.execute({ message: 123 }, { tenantId: 't1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('必须为字符串');
      expect(result.suggestion).toBeDefined();
    });

    it('message 为空字符串应返回 success=false', async () => {
      const result = await tool.execute({ message: '' }, { tenantId: 't1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('不能为空字符串');
    });

    it('message 缺失应返回 success=false', async () => {
      const result = await tool.execute({}, { tenantId: 't1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('必须为字符串');
    });
  });

  describe('execute - 不抛异常', () => {
    it('任意入参都不应抛异常（错误通过 success=false 返回）', async () => {
      await expect(
        tool.execute({ message: null }, { tenantId: 't1' }),
      ).resolves.toBeDefined();
      await expect(
        tool.execute({ message: undefined }, { tenantId: 't1' }),
      ).resolves.toBeDefined();
    });
  });
});
