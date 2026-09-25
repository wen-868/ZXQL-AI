/**
 * DispatchEmployeeTaskTool 单元测试 — 数字员工 MVP（2026-09-26 补）
 *
 * 覆盖：参数校验、员工身份透传（callerUid/dispatchDepth）、成功派发返回、被拒绝时回传错误
 *
 * 负责人: 苏然（测试） | 创建日期: 2026-09-26
 */
import { DispatchEmployeeTaskTool } from './dispatch-employee-task.tool';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { EmployeeService } from '../../brain/employee/employee.service';

/** 派发入参记录（用于断言身份透传） */
interface DispatchCall {
  callerUid?: string;
  tenantId: string;
  targetKeyword: string;
  task: string;
  dispatchDepth: number;
}

/** 构造工具上下文 */
function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: over.tenantId ?? 't1',
    userId: over.userId ?? 'u1',
    sessionId: over.sessionId ?? 's1',
    role: over.role,
    customerId: over.customerId,
    employeeUid: over.employeeUid,
    dispatchDepth: over.dispatchDepth,
  };
}

describe('DispatchEmployeeTaskTool', () => {
  let calls: DispatchCall[];
  let accept: boolean;
  let denyMessage: string;
  let tool: ITool;

  beforeEach(() => {
    calls = [];
    accept = true;
    denyMessage = '';
    const employeeService = {
      dispatchTask: (input: DispatchCall) => {
        calls.push(input);
        return Promise.resolve(
          accept
            ? {
                accepted: true,
                taskId: 12,
                employeeName: '采专员',
                employeeUid: 'emp_target',
                message: '任务已派发给「采专员」（任务#12）',
              }
            : { accepted: false, message: denyMessage },
        );
      },
    } as unknown as EmployeeService;
    tool = new DispatchEmployeeTaskTool(employeeService);
  });

  it('工具元信息：非写操作 + system 分类 + 必填 target/task', () => {
    expect(tool.name).toBe('dispatchEmployeeTask');
    expect(tool.isWriteOperation).toBe(false);
    expect(tool.category).toBe('system');
    const params = tool.parameters as { required?: string[] };
    expect(params.required).toEqual(['target', 'task']);
  });

  it('参数缺失（target 为空）→ 返回错误且不调用服务', async () => {
    const res: ToolResult = await tool.execute(
      { target: '  ', task: '补货' },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('参数缺失');
    expect(calls.length).toBe(0);
  });

  it('参数缺失（task 为空）→ 返回错误', async () => {
    const res = await tool.execute({ target: '采专员', task: '' }, makeCtx());
    expect(res.success).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('员工调用：透传 callerUid 与 dispatchDepth 到服务层', async () => {
    const res = await tool.execute(
      { target: '采专员', task: '创建采购单' },
      makeCtx({ employeeUid: 'emp_caller', dispatchDepth: 1 }),
    );
    expect(res.success).toBe(true);
    const data = res.data as { taskId: number };
    expect(data.taskId).toBe(12);
    expect(calls.length).toBe(1);
    expect(calls[0].callerUid).toBe('emp_caller');
    expect(calls[0].dispatchDepth).toBe(1);
    expect(calls[0].tenantId).toBe('t1');
    expect(calls[0].targetKeyword).toBe('采专员');
  });

  it('用户直接调用（无 employeeUid）→ callerUid 为 undefined，depth 归零', async () => {
    await tool.execute({ target: '采专员', task: '创建采购单' }, makeCtx());
    expect(calls.length).toBe(1);
    expect(calls[0].callerUid).toBeUndefined();
    expect(calls[0].dispatchDepth).toBe(0);
  });

  it('服务层拒绝（边表/深度）→ 工具返回失败并回传原因', async () => {
    accept = false;
    denyMessage = '「采专员」不在「库管家」的可调用员工列表中';
    const res = await tool.execute(
      { target: '采专员', task: 'x' },
      makeCtx({ employeeUid: 'emp_caller' }),
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('不在「库管家」的可调用员工列表中');
  });
});
