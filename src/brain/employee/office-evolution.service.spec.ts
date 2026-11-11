/**
 * OfficeEvolutionService 单元测试（AI-P2-5-CAPTURE-CONSUMER-CONVERGENCE-01）
 *
 * 覆盖：评分回流三路由（sample/correction/experience）的 capture 输入
 * 经 buildDomainCaptureTaskInput 单源组装——域语义保留、tenant fail-closed、
 * sampleQuality 透传、原始轨迹保留。
 */
import { EmployeeService } from './employee.service';
import { OfficeEvolutionService } from './office-evolution.service';

/** captureTask 入参形状（与 buildDomainCaptureTaskInput 返回结构对齐，供类型安全断言） */
interface CaptureTaskArg {
  tenantId: string;
  domain: string;
  intent: string;
  userMessage?: string;
  toolCalls?: Array<Record<string, unknown>>;
  outcome: string;
  reply?: string;
  error?: string;
  sampleQuality?: number;
  adopted?: boolean;
}

/** 员工服务桩：同时返回原始 jest 桩（类型安全断言用）与注入用的服务实例 */
function makeEmployeeStubs() {
  const stubs = {
    getTaskById: jest.fn().mockImplementation((id: number) =>
      Promise.resolve(
        id === 999
          ? null
          : {
              id,
              task: '生成周报',
              resultSummary: '周报已生成',
              tenantId: 't1',
            },
      ),
    ),
    markTaskRated: jest.fn().mockResolvedValue(undefined),
  };
  return { stubs, service: stubs as unknown as EmployeeService };
}

describe('OfficeEvolutionService（AI-P2-5 capture 单源收敛）', () => {
  let capture: {
    captureTask: jest.Mock<Promise<void>, [CaptureTaskArg]>;
    captureCorrection: jest.Mock<Promise<void>, [Record<string, unknown>]>;
  };
  let employeeStubs: ReturnType<typeof makeEmployeeStubs>['stubs'];
  let service: OfficeEvolutionService;

  beforeEach(() => {
    capture = {
      captureTask: jest
        .fn<Promise<void>, [CaptureTaskArg]>()
        .mockResolvedValue(undefined),
      captureCorrection: jest
        .fn<Promise<void>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
    };
    const emp = makeEmployeeStubs();
    employeeStubs = emp.stubs;
    service = new OfficeEvolutionService(capture as never, emp.service);
  });

  it('采纳（score≥4）：captureTask 经单源组装——domain=analysis、intent=域任务类型、sampleQuality=score 透传', async () => {
    const r = await service.rate({
      taskId: 1,
      tenantId: 't1',
      score: 5,
      adopted: true,
      taskType: 'office_report',
    });
    expect(r.routedTo).toBe('sample');
    expect(capture.captureTask).toHaveBeenCalledTimes(1);
    const arg = capture.captureTask.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        tenantId: 't1',
        domain: 'analysis',
        intent: 'office_report',
        userMessage: '生成周报',
        reply: '周报已生成',
        outcome: 'success',
        sampleQuality: 5,
      }),
    );
    expect(capture.captureCorrection).not.toHaveBeenCalled();
  });

  it('中评（score=3）：experience 路由 captureTask 无 sampleQuality（quality 缺省走落库层）', async () => {
    const r = await service.rate({
      taskId: 1,
      tenantId: 't1',
      score: 3,
      adopted: true,
      taskType: 'office_minutes',
    });
    expect(r.routedTo).toBe('experience');
    const arg = capture.captureTask.mock.calls[0][0];
    expect(arg.intent).toBe('office_minutes');
    expect(arg.sampleQuality).toBeUndefined();
    expect(arg.outcome).toBe('success');
  });

  it('驳回（score≤2）：走 captureCorrection（taskType=域任务类型），不走 captureTask', async () => {
    const r = await service.rate({
      taskId: 1,
      tenantId: 't1',
      score: 2,
      adopted: false,
      feedback: '数据口径不对',
      taskType: 'office_analysis',
    });
    expect(r.routedTo).toBe('correction');
    expect(capture.captureTask).not.toHaveBeenCalled();
    expect(capture.captureCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        taskType: 'office_analysis',
      }),
    );
  });

  it('域语义保留：office_document 等非工具意图经归一后保持原值（不被折叠成 chat/假 docType）', async () => {
    await service.rate({
      taskId: 1,
      tenantId: 't1',
      score: 5,
      adopted: true,
      taskType: 'office_document',
    });
    const arg = capture.captureTask.mock.calls[0][0];
    expect(arg.intent).toBe('office_document');
    expect(arg.intent).not.toBe('chat');
  });

  it('空 tenantId fail-closed：抛 CaptureTenantMissingError 且不落任何采集', async () => {
    await expect(
      service.rate({ taskId: 1, tenantId: '', score: 5, adopted: true }),
    ).rejects.toThrow('fail-closed');
    expect(capture.captureTask).not.toHaveBeenCalled();
    expect(capture.captureCorrection).not.toHaveBeenCalled();
  });

  it('task 不存在：抛错且不落采集（租户内对账）', async () => {
    await expect(
      service.rate({ taskId: 999, tenantId: 't1', score: 5, adopted: true }),
    ).rejects.toThrow('任务不存在');
    expect(capture.captureTask).not.toHaveBeenCalled();
  });

  it('重复评分保护：markTaskRated 按路由结果标记（同任务不重复入池的衔接点）', async () => {
    await service.rate({
      taskId: 1,
      tenantId: 't1',
      score: 5,
      adopted: true,
      taskType: 'office_report',
    });
    // 断言取原始 jest 桩（不经不兼容断言，也避开 method 引用取 this 的问题）
    expect(employeeStubs.markTaskRated.mock.calls).toEqual([
      [1, 'sample', 't1'],
    ]);
  });
});
