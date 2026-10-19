/**
 * EmployeeTaskBridge 单元测试（2026-10-04 新建）
 *
 * 背景：本文件此前**不存在** —— 跨层拼接处无测试，正是踩坑 [44] 记录过的
 * P0 藏身之处。本次审查 P1-8 即发生在此：任务回传漏传 customerId 分区键，
 * 运营客户端下用户永远看不到回传结果，任务事实失联。
 *
 * 只测**回传落在哪个记忆分区**这一关键契约，不牵扯真实 LLM/DB。
 */
import { Logger } from '@nestjs/common';
import { EmployeeTaskBridge } from './employee-task-bridge.service';
import { AiEmployeeEntity } from '../../database/entities/ai-employee.entity';

/** 伪员工实体（只需 bridge 用到的字段） */
const employee = (uid: string, name: string) =>
  ({
    id: 1,
    tenantId: 't1',
    employeeUid: uid,
    name,
  }) as unknown as AiEmployeeEntity;

describe('EmployeeTaskBridge', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  /** 构造 bridge，并记录每次 saveHistory 的 (sessionId, customerId) */
  function setup() {
    const writes: Array<{
      sessionId: string;
      customerId?: string;
      content: string;
    }> = [];

    const memoryManager = {
      saveHistory: jest.fn(
        (
          _tenantId: string,
          sessionId: string,
          messages: Array<{ role: string; content: string }>,
          customerId?: string,
        ) => {
          for (const m of messages) {
            writes.push({ sessionId, customerId, content: m.content });
          }
          return Promise.resolve(undefined);
        },
      ),
    };

    const employeeService = {
      setTaskRunner: jest.fn(),
      completeTask: jest.fn().mockResolvedValue(undefined),
    };

    const orchestrator = {
      run: jest.fn().mockImplementation(function* () {
        yield { type: 'text', content: '任务已完成' };
      }),
    };

    // R101-AI-46：待办回写桩（默认"已改变"；用例可覆盖）
    const todoSync = {
      markDone: jest.fn().mockResolvedValue({ changed: true }),
    };

    const bridge = new EmployeeTaskBridge(
      employeeService as never,
      orchestrator as never,
      memoryManager as never,
      todoSync as never,
    );
    return {
      bridge,
      writes,
      employeeService,
      orchestrator,
      memoryManager,
      todoSync,
    };
  }

  const baseInput = {
    taskId: 7,
    employee: employee('emp_a', '小张'),
    taskText: '盘点库存',
    depth: 1,
    tenantId: 't1',
    dispatchedBy: 'user',
  };

  it('回传写发起会话时，必须带 customerId 分区键（修复点）', async () => {
    const { bridge, writes } = setup();
    await bridge['run']({
      ...baseInput,
      originConversationId: 'conv_123',
      customerId: 'cust_456',
    });

    const report = writes.filter((w) => w.content.includes('【任务回传】'));
    expect(report).toHaveLength(1);
    expect(report[0].sessionId).toBe('conv_123');
    // 反测信号：修复前这里是 undefined，回传会写到无分区的另一个 key
    expect(report[0].customerId).toBe('cust_456');
  });

  it('任务下达写员工会话（emp_ 前缀，管理端命名空间不带分区）', async () => {
    const { bridge, writes } = setup();
    await bridge['run']({ ...baseInput, customerId: 'cust_456' });

    const dispatch = writes.filter((w) => w.content.includes('【任务派发】'));
    expect(dispatch[0].sessionId).toBe('emp_emp_a');
    // 员工自身会话属管理端命名空间，不应带客户分区
    expect(dispatch[0].customerId).toBeUndefined();
  });

  it('无 customerId（管理端场景）→ 回传不带分区，行为不变', async () => {
    const { bridge, writes } = setup();
    await bridge['run']({
      ...baseInput,
      originConversationId: 'conv_123',
    });

    const report = writes.filter((w) => w.content.includes('【任务回传】'));
    expect(report[0].sessionId).toBe('conv_123');
    expect(report[0].customerId).toBeUndefined();
  });

  it('上级员工派发 → 回传写上级员工会话', async () => {
    const { bridge, writes } = setup();
    await bridge['run']({
      ...baseInput,
      dispatchedBy: 'employee:emp_boss',
    });

    const report = writes.filter((w) => w.content.includes('【任务回传】'));
    expect(report[0].sessionId).toBe('emp_emp_boss');
  });

  it('用户直接交办（无发起会话）→ 回执写回员工会话本身', async () => {
    const { bridge, writes } = setup();
    await bridge['run'](baseInput);

    const receipt = writes.filter((w) =>
      w.content.includes('【任务完成回执】'),
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0].sessionId).toBe('emp_emp_a');
  });

  it('onModuleInit 注册任务执行器（桥接装配点）', () => {
    const { bridge, employeeService } = setup();
    bridge.onModuleInit();
    expect(employeeService.setTaskRunner).toHaveBeenCalled();
  });

  // ── R101-AI-46：数字员工任务完成 ⇒ 待办回写 ──
  describe('R101-AI-46 待办回写', () => {
    it('① 任务成功且有 linkedTodoId ⇒ 回写 markDone（tenant+todoId 正确）', async () => {
      const { bridge, todoSync } = setup();
      await bridge['run']({ ...baseInput, linkedTodoId: '99' });

      expect(todoSync.markDone).toHaveBeenCalledTimes(1);
      expect(todoSync.markDone).toHaveBeenCalledWith(
        't1',
        '99',
        expect.stringContaining('小张'),
      );
    });

    it('② 任务失败 ⇒ 不回写（失败自动改 done 会掩盖问题）', async () => {
      const { todoSync } = setup();
      const orchestrator = {
        run: jest.fn().mockImplementation(function* () {
          yield { type: 'error', message: 'LLM 超时' };
        }),
      };
      // 用失败编排器重建 bridge
      const employeeService = {
        setTaskRunner: jest.fn(),
        completeTask: jest.fn().mockResolvedValue(undefined),
      };
      const memoryManager = { saveHistory: jest.fn() };
      const b = new EmployeeTaskBridge(
        employeeService as never,
        orchestrator as never,
        memoryManager as never,
        todoSync as never,
      );
      await b['run']({ ...baseInput, linkedTodoId: '99' });

      expect(todoSync.markDone).not.toHaveBeenCalled();
    });

    it('③ 无 linkedTodoId（用户直接交办）⇒ 不调回写（行为与历史一致）', async () => {
      const { bridge, todoSync } = setup();
      await bridge['run'](baseInput);

      expect(todoSync.markDone).not.toHaveBeenCalled();
    });

    it('④ 回写失败（markDone 抛）不得影响任务结果（主次不倒置）', async () => {
      const { bridge, todoSync } = setup();
      todoSync.markDone.mockRejectedValueOnce(new Error('DB 抖动'));

      // 不抛即通过（bridge 内部已兜底）；回传照常写
      const result = await bridge['run']({ ...baseInput, linkedTodoId: '99' });

      expect(result.status).toBe('completed');
      expect(todoSync.markDone).toHaveBeenCalledTimes(1);
    });

    it('⑤ 回写结果 changed=false（已是 done / 不存在）时不抛、任务照常', async () => {
      const { bridge, todoSync } = setup();
      todoSync.markDone.mockResolvedValueOnce({
        changed: false,
        replayed: true,
      });

      const result = await bridge['run']({ ...baseInput, linkedTodoId: '99' });

      expect(result.status).toBe('completed');
    });
  });
});
