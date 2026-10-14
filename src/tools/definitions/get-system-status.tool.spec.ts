/**
 * getSystemStatus 工具测试（R101-AI-34 P1-4）
 *
 * 反测原则（"坏了会红吗"）：
 * ① 无依赖（三层全抛）⇒ **不崩**：success:true + 各层 unavailable + 带 reason
 * ② `priceConfigured=false` ⇒ 带"费用告警未生效"提示（mutation：去掉提示 ⇒ 红）
 * ③ provider/model 取生效值（桩注入）
 * ④ detail=false ⇒ 健康层 skipped（**不探测**，避免慢查询）；detail=true ⇒ 调 readiness.check()
 * ⑤ 治理层 = **容量口径**（只读不消耗）：断言 capacityOf 被调用、**consume 从未被调用**
 * ⑥ 读工具契约 isWriteOperation=false
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { RateLimiterService } from '../../common/rate-limiter';
import { DataSource } from 'typeorm';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ToolContext } from '../tool.interface';
import { GetSystemStatusTool } from './get-system-status.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

interface Layer {
  status: string;
  reason?: string;
  detail?: Record<string, unknown>;
}
interface StatusData {
  service: Layer;
  db: Layer;
  ai: Layer;
  governance: Layer;
}

interface Harness {
  tool: GetSystemStatusTool;
  query: jest.Mock;
  getResolvedConfig: jest.Mock;
  getModelPrice: jest.Mock;
  capacityOf: jest.Mock;
}

function createHarness(
  over: {
    query?: () => Promise<unknown>;
    getResolvedConfig?: () => Promise<unknown>;
    getModelPrice?: (p: string, m: string) => Promise<unknown>;
    capacityOf?: (bucket: string) => { capacity: number; refillPerMs: number };
  } = {},
): Harness {
  const query = jest.fn(over.query ?? (() => Promise.resolve([{ '1': 1 }])));
  const getResolvedConfig = jest.fn(
    over.getResolvedConfig ??
      (() => Promise.resolve({ provider: 'deepseek', model: 'deepseek-chat' })),
  );
  const getModelPrice = jest.fn(
    over.getModelPrice ??
      (() => Promise.resolve({ promptPrice: 0.001, completionPrice: 0.002 })),
  );
  const capacityOf = jest.fn(
    over.capacityOf ??
      ((bucket: string) => ({
        capacity: bucket === 'read' ? 600 : 60,
        refillPerMs: bucket === 'read' ? 0.01 : 0.001,
      })),
  );

  const tool = new GetSystemStatusTool(
    { query } as unknown as DataSource,
    { getResolvedConfig, getModelPrice } as unknown as AiConfigService,
    { capacityOf } as unknown as RateLimiterService,
  );
  return { tool, query, getResolvedConfig, getModelPrice, capacityOf };
}

function dataOf(result: { success: boolean; data?: unknown }): StatusData {
  return result.data as StatusData;
}

describe('GetSystemStatusTool（R101-AI-34 P1-4 系统状态）', () => {
  it('① 三层依赖全部抛错 ⇒ 不崩：success=true，各层可用项照常、不可用项标 unavailable+原因', async () => {
    const h = createHarness({
      query: () => Promise.reject(new Error('DB 连接超时')),
      getResolvedConfig: () => Promise.reject(new Error('配置服务不可用')),
      capacityOf: () => {
        throw new Error('限流服务未初始化');
      },
    });

    const result = await h.tool.execute({ detail: true }, CTX);

    expect(result.success).toBe(true);
    const data = dataOf(result);
    // 服务层永远可得（进程内信息）
    expect(data.service.status).toBe('ok');
    expect(data.service.detail?.integrationMode).toBeTruthy();
    // 其余三层降级
    expect(data.db.status).toBe('unavailable');
    expect(data.db.reason).toContain('DB 连接超时');
    expect(data.ai.status).toBe('unavailable');
    expect(data.governance.status).toBe('unavailable');
  });

  it('② 未配置单价 ⇒ 明确提示"费用告警未生效"（mutation：去掉提示 ⇒ 本例红）', async () => {
    const h = createHarness({
      getModelPrice: () => Promise.resolve(null),
    });

    const result = await h.tool.execute({}, CTX);

    expect(result.success).toBe(true);
    const ai = dataOf(result).ai;
    expect(ai.status).toBe('ok');
    expect(ai.detail?.priceConfigured).toBe(false);
    expect(ai.reason).toContain('费用告警未生效');
  });

  it('③ 已配置单价 ⇒ priceConfigured=true 且无告警原因；provider/model 取生效值', async () => {
    const h = createHarness();

    const result = await h.tool.execute({}, CTX);

    const ai = dataOf(result).ai;
    expect(ai.detail?.provider).toBe('deepseek');
    expect(ai.detail?.model).toBe('deepseek-chat');
    expect(ai.detail?.priceConfigured).toBe(true);
    expect(ai.reason).toBeUndefined();
    expect(h.getModelPrice).toHaveBeenCalledWith('deepseek', 'deepseek-chat');
  });

  it('④ detail=false（缺省）⇒ 健康层 skipped 且**不调**探针；detail=true ⇒ 调', async () => {
    const h1 = createHarness();
    const skipped = await h1.tool.execute({}, CTX);
    expect(dataOf(skipped).db.status).toBe('skipped');
    expect(h1.query).not.toHaveBeenCalled();

    const h2 = createHarness();
    const probed = await h2.tool.execute({ detail: true }, CTX);
    expect(dataOf(probed).db.status).toBe('ok');
    expect(h2.query).toHaveBeenCalledTimes(1);
  });

  it('⑤ 治理层为容量口径且**只读不消耗**：断言 capacityOf 被调用、出参为 readCapacity/writeCapacity', async () => {
    const h = createHarness();

    const result = await h.tool.execute({}, CTX);

    const gov = dataOf(result).governance;
    expect(gov.status).toBe('ok');
    expect(gov.detail?.readCapacity).toBe(600);
    expect(gov.detail?.writeCapacity).toBe(60);
    expect(gov.detail?.readRemaining).toBeUndefined(); // 不叫 remaining（避免误导）
    expect(h.capacityOf).toHaveBeenCalledWith('read');
    expect(h.capacityOf).toHaveBeenCalledWith('write');
  });

  it('⑥ 读工具契约：isWriteOperation=false（读全自动）', () => {
    const h = createHarness();
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('getSystemStatus');
  });
});
