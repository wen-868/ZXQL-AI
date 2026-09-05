import { Injectable } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';

/**
 * Echo 回显工具（测试夹具）
 *
 * ⚠️ 2026-09-05 起**不再注册进生产 ToolRegistry**（tool-bootstrap 已移除，
 * 工具数口径 51 精调 + 55 目录 = 106）。本文件保留仅作为 spec 的测试夹具：
 * tool-registry.spec / tool-executor.spec 用它验证注册与执行链路。
 *
 * 用途：验证 Tool 系统框架（ToolRegistry 注册 + ToolExecutor 执行）是否正常工作。
 * 不调用任何外部服务，纯本地回显，便于在 R70-04 阶段做端到端验收。
 *
 * 后续 R70-09~13 实现的真实业务工具（order/inventory/product 等）以此为模板：
 * 1. 实现 ITool 接口
 * 2. 定义 name/description/parameters/category/isWriteOperation
 * 3. execute 内部 try-catch 包裹业务逻辑，错误通过 ToolResult.success=false 返回
 * 4. 在 ToolsModule 中实例化并 registry.register()
 */
@Injectable()
export class EchoTool implements ITool {
  readonly name = 'echo';
  readonly description =
    '回显工具（用于测试）。将用户传入的 message 原样返回，附带回显时间戳。' +
    '调用此工具可验证 AI 底座的 Tool 注册与执行链路是否正常，不涉及任何业务数据。';
  readonly category = 'utility' as const;
  readonly isWriteOperation = false;

  /**
   * 参数 JSON Schema（OpenAI Function Calling 规范）
   *
   * 每个字段必须有 description，required 字段标注。
   */
  readonly parameters = {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: '要回显的消息内容（必填）',
      },
    },
    required: ['message'],
  };

  /**
   * 执行回显
   *
   * @param args    { message: string }
   * @param context 执行上下文（echo 工具不使用 context，仅做记录）
   * @returns 回显结果
   */
  execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    // 参数校验
    const message = args.message;
    if (typeof message !== 'string') {
      return Promise.resolve({
        success: false,
        error: '参数 message 必须为字符串',
        suggestion: '请传入字符串类型的 message 参数，如 {"message":"你好"}',
      });
    }

    if (message.length === 0) {
      return Promise.resolve({
        success: false,
        error: '参数 message 不能为空字符串',
        suggestion: '请传入非空的 message 内容',
      });
    }

    // 回显（不调用任何外部服务）
    return Promise.resolve({
      success: true,
      data: {
        echo: message,
        receivedAt: new Date().toISOString(),
      },
    });
  }
}
