/**
 * OfficeEvolutionService 单元测试（AI-P2-5-CAPTURE-CONSUMER-CONVERGENCE-01）
 *
 * 覆盖：评分回流三路由（sample/correction/experience）的 capture 输入
 * 经 buildDomainCaptureTaskInput 单源组装——域语义保留、tenant fail-closed、
 * sampleQuality 透传、原始轨迹保留。
 */
import { EmployeeService } from './employee.service';
import { OfficeEvolutionService } from './office-evolution.service';

function makeEmployeeService() {
  return {
    getTaskById: jest.fn(async (id: number) =>
      id === 999
        ? null
        : { id, task: '生成周报', resultSummary: '周报已生成', tenantId: 't1' },
    ),
    markTaskRated: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmployeeService;
}

describe('OfficeEvolutionService（AI-P2-5 capture 单源收敛）', () => {
  let capture: { captureTask: jest.Mock; captureCorrection: jest.Mock };
  let service: OfficeEvolutionService;

  beforeEach(() => {
    capture = {
      captureTask: jest.fn().mockResolvedValue(undefined),
      captureCorrection: jest.fn().mockResolvedValue(undefined),
    };
    service = new OfficeEvolutionService(
      capture as never,
      makeEmployeeService(),
    );
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
    const emp = service['employeeService'] as {
      markTaskRated: jest.Mock;
    };
    expect(emp.markTaskRated).toHaveBeenCalledWith(
      1,
      'sample',
      't1',
    );
  });
});
