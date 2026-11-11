/**
 * LearningService 单元测试（P2 自主学习 LN）
 *
 * 覆盖：成功经验吸收、失败经验+工具提示回流、驳回路由提示、提示读取、应用记录
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试中 jest mock 方法断言 */
import { Repository } from 'typeorm';
import { AiLearningLogEntity } from '../../database/entities/ai-learning-log.entity';
import { LongTermMemoryService } from '../memory/long-term-memory.service';
import { LearningService } from './learning.service';

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

function makeLtm() {
  return {
    saveEpisodic: jest.fn().mockResolvedValue(undefined),
    upsertProfile: jest.fn().mockResolvedValue(undefined),
    getProfiles: jest.fn().mockResolvedValue([]),
  } as unknown as LongTermMemoryService;
}

function makeLogRepo() {
  return {
    create: jest.fn((e: AiLearningLogEntity) => e),
    save: jest.fn((e: AiLearningLogEntity) => Promise.resolve(e)),
    find: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<Repository<AiLearningLogEntity>>;
}

describe('LearningService', () => {
  let ltm: ReturnType<typeof makeLtm>;
  let logRepo: ReturnType<typeof makeLogRepo>;
  let capture: { captureTask: jest.Mock<Promise<void>, [CaptureTaskArg]> };
  let service: LearningService;

  beforeEach(() => {
    ltm = makeLtm();
    logRepo = makeLogRepo();
    capture = {
      captureTask: jest
        .fn<Promise<void>, [CaptureTaskArg]>()
        .mockResolvedValue(undefined),
    };
    service = new LearningService(ltm, logRepo, capture as never);
  });

  it('成功信号吸收为 good 经验，不写失败提示', async () => {
    await service.absorb('t1', {
      taskName: '创建销售单',
      success: true,
      tool: 'createSalesOrder',
    });
    expect(jest.mocked(ltm.saveEpisodic)).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ outcome: 'good' }),
    );
    expect(jest.mocked(ltm.upsertProfile)).not.toHaveBeenCalled();
  });

  it('失败信号吸收为 bad 经验并回流工具提示', async () => {
    await service.absorb(
      't1',
      {
        taskName: '创建销售单',
        success: false,
        error: '客户不存在',
        tool: 'createSalesOrder',
      },
      'u1',
    );
    expect(jest.mocked(ltm.saveEpisodic)).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ outcome: 'bad', why: '客户不存在' }),
    );
    expect(jest.mocked(ltm.upsertProfile)).toHaveBeenCalledWith(
      't1',
      'tool_select_hint',
      expect.objectContaining({ tool: 'createSalesOrder' }),
      'hint',
    );
  });

  it('审核驳回信号写路由提示', async () => {
    await service.absorb('t1', {
      taskName: '发布视频',
      success: false,
      reviewStatus: 'rejected',
    });
    expect(jest.mocked(ltm.upsertProfile)).toHaveBeenCalledWith(
      't1',
      'routing_hint',
      expect.objectContaining({
        note: expect.stringContaining('驳回') as string,
      }),
      'hint',
    );
  });

  it('getHints 从档案读取工具与路由提示', async () => {
    jest.mocked(ltm.getProfiles).mockResolvedValue([
      {
        k: 'tool_select_hint',
        v: { tool: 'createSalesOrder', note: '先查客户' },
      },
      { k: 'routing_hint', v: { note: '涉及审核需谨慎' } },
    ]);
    const hints = await service.getHints('t1');
    expect(hints.toolSelect).toEqual([
      { tool: 'createSalesOrder', note: '先查客户' },
    ]);
    expect(hints.routing.length).toBeGreaterThan(0);
  });

  it('recordApplication 写入学习日志', async () => {
    await service.recordApplication('t1', {
      expId: 7,
      hintKey: 'tool_select',
      effect: 'positive',
    });
    const saved = logRepo.save.mock.calls[0][0] as AiLearningLogEntity;
    expect(saved.tenantId).toBe('t1');
    expect(saved.effect).toBe('positive');
  });

  it('listLogs 按租户倒序返回', async () => {
    logRepo.find.mockResolvedValue([{ id: 1 } as AiLearningLogEntity]);
    const logs = await service.listLogs('t1');
    expect(jest.mocked(logRepo.find)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 't1' } }),
    );
    expect(logs).toHaveLength(1);
  });

  // ════ AI-P2-5-CAPTURE-CONSUMER-CONVERGENCE-01：capture 输入经单源组装 ════
  describe('absorb → captureTask 单源组装（AI-P2-5）', () => {
    it('成功+工具信号：组装经 buildDomainCaptureTaskInput——domain=write、outcome=success、tenantId 透传、adopted=true', async () => {
      await service.absorb('t1', {
        taskName: '创建销售单',
        success: true,
        tool: 'createSalesOrder',
      });
      expect(capture.captureTask).toHaveBeenCalledTimes(1);
      const arg = capture.captureTask.mock.calls[0][0];
      expect(arg.tenantId).toBe('t1');
      expect(arg.domain).toBe('write');
      expect(arg.intent).toBe('创建销售单');
      expect(arg.outcome).toBe('success');
      expect(arg.adopted).toBe(true);
      // 轨迹保留原始工具名
      expect(JSON.stringify(arg.toolCalls)).toContain('createSalesOrder');
    });

    it('失败+驳回信号：outcome=corrected 不被翻转为 failed；error 透传', async () => {
      await service.absorb('t1', {
        taskName: '发布视频',
        success: false,
        reviewStatus: 'rejected',
        error: '文案违规',
      });
      const arg = capture.captureTask.mock.calls[0][0];
      expect(arg.outcome).toBe('corrected');
      expect(arg.error).toBe('文案违规');
      expect(arg.domain).toBe('analysis');
    });

    it('失败无驳回：outcome=failed；无工具 ⇒ domain=analysis；不写 adopted', async () => {
      await service.absorb('t1', {
        taskName: '创建销售单',
        success: false,
        error: '客户不存在',
      });
      const arg = capture.captureTask.mock.calls[0][0];
      expect(arg.outcome).toBe('failed');
      expect(arg.domain).toBe('analysis');
      expect(arg.adopted).toBeUndefined();
    });

    it('空 tenantId fail-closed：抛 CaptureTenantMissingError 且不调 captureTask（不跨租户不补默认）', async () => {
      await expect(
        service.absorb('', {
          taskName: '创建销售单',
          success: true,
        }),
      ).rejects.toThrow('fail-closed');
      expect(capture.captureTask).not.toHaveBeenCalled();
      // 经验也不落（租户边界优先于经验沉淀）
      expect(jest.mocked(ltm.saveEpisodic)).not.toHaveBeenCalled();
    });
  });
});
