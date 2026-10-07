/**
 * 阶段 4-1 · taskType 口径归一 —— 契约测试（P0 进化飞轮断链修复）
 *
 * 缺陷：采集侧把**工具名**（如 `createSalesOrder`）写进 `ai_sample.task_type`，
 * 而消费侧（`structured-extractor.ts` 的 few-shot 回流）按**裸 docType**
 * （如 `sales_order`）精确相等查询 ⇒ 永不相等 ⇒ 自动捕获的样本
 * 100% 进不了 few-shot 池。
 *
 * 本 spec 锁定归一契约：
 * 1. 注册表命中的工具名 ⇒ 落库裸 docType
 * 2. 未命中的值（`office_document`）⇒ 原样保留（**不得**规则推导）
 * 3. 兜底值（`intent` 缺省时取 `domain`）⇒ 原样保留
 * 4. 归一**不得**污染 `ai_experience.intent`（那里存工具名是正确口径）
 * 5. 注册表 14 类 docType全覆盖 + 映射表完整性（防注册表漂移）
 *
 * 反测口径：把 `capture.service.ts` 的归一改回`taskType: input.intent ?? input.domain`，
 * 本文件第 1 组与第 5 组必须变红。
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository, type ObjectLiteral } from 'typeorm';
import { AiExperienceEntity } from '../database/entities/ai-experience.entity';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { CaptureService, type CaptureTaskInput } from './capture.service';
import { listWriteSchemas } from '../brain/extraction/write-schema-registry';

function createRepo<T extends ObjectLiteral>() {
  return {
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    find: jest.fn(() => Promise.resolve([])),
  } as unknown as Repository<T>;
}

function createService() {
  const expRepo = createRepo<AiExperienceEntity>();
  const sampleRepo = createRepo<AiSampleEntity>();
  const service = new CaptureService(expRepo, createRepo(), sampleRepo, {
    recordDbSample: jest.fn(),
  } as never);
  return { service, expRepo, sampleRepo };
}

/** 走captureTask 并取回落库的 sample 实体 */
async function captureSample(input: Partial<CaptureTaskInput>) {
  const { service, expRepo, sampleRepo } = createService();
  await service.captureTask({
    tenantId: 't_001',
    domain: 'write',
    userMessage: '给红星商行开5箱五粮液',
    reply: '已创建',
    outcome: 'success',
    ...input,
  });
  const sample = (sampleRepo.save as jest.Mock).mock.calls[0][0];
  const experience = (expRepo.save as jest.Mock).mock.calls[0][0];
  return { sample, experience };
}

/**
 * 注册表 14 类 docType的「工具名 → 裸 docType」期望映射。
 * 硬编码而非从注册表动态推导 —— 动态推导会让本spec 变成
 * 「注册表和自己比」的恒真断言，注册表漂移时测不出来。
 */
const EXPECTED_MAPPING: ReadonlyArray<
  readonly [toolName: string, docType: string]
> = [
  ['createCustomer', 'customer_create'],
  ['createProduct', 'product_create'],
  ['updateProductPrice', 'price_update'],
  ['createSalesOrder', 'sales_order'],
  ['createSalesReturn', 'sales_return'],
  ['createPurchaseOrder', 'purchase_order'],
  ['api_create_purchase_return', 'purchase_return'],
  ['createDelivery', 'delivery'],
  ['createPaymentReconciliation', 'receipt'],
  ['api_create_purchase_payment', 'payment'],
  ['createRefund', 'refund'],
  ['inventoryTransfer', 'inventory_transfer'],
  ['stockCheck', 'inventory_check'],
  // promotion 是 1:N（6 个工具名），取首个作为代表
  ['api_create_flash_sale', 'promotion'],
];

describe('阶段 4-1 · ai_sample.taskType 口径归一', () => {
  describe('1. 注册表命中的工具名 ⇒ 落库裸 docType', () => {
    it('createSalesOrder ⇒ sales_order（任务卡 R3-1）', async () => {
      const { sample } = await captureSample({ intent: 'createSalesOrder' });
      expect(sample.taskType).toBe('sales_order');
    });

    it('createSalesOrder 不落库工具名本身（断链根因的直接断言）', async () => {
      const { sample } = await captureSample({ intent: 'createSalesOrder' });
      expect(sample.taskType).not.toBe('createSalesOrder');
    });
  });

  describe('2. 非注册表值原样保留（严禁规则推导）', () => {
    it('office_document ⇒ office_document（任务卡 R3-2）', async () => {
      const { sample } = await captureSample({
        domain: 'analysis',
        intent: 'office_document',
      });
      expect(sample.taskType).toBe('office_document');
    });

    it.each([
      // 驼峰转下划线规则会把这些值错改成注册表中不存在的 docType
      ['write_sales_order', 'write_sales_order'],
      ['CreateSalesOrder', 'CreateSalesOrder'],
      ['sales_order', 'sales_order'],
      ['chat', 'chat'],
      // 办公任务类型（office-evolution.service.ts 传入，非注册表域）
      ['report', 'report'],
      ['data_analysis', 'data_analysis'],
    ])('未命中值 %s ⇒ 原样保留 %s', async (intent, expected) => {
      const { sample } = await captureSample({
        domain: 'analysis',
        intent,
      });
      expect(sample.taskType).toBe(expected);
    });
  });

  describe('3. intent 缺省时回退 domain，兜底值原样保留', () => {
    it("intent: undefined, domain: 'write' ⇒ write（任务卡 R3-3）", async () => {
      const { sample } = await captureSample({
        domain: 'write',
        intent: undefined,
      });
      expect(sample.taskType).toBe('write');
    });

    it.each(['analysis', 'push', 'write'] as const)(
      "domain兜底 '%s' ⇒ 原样保留",
      async (domain) => {
        const { sample } = await captureSample({
          domain,
          intent: undefined,
        });
        expect(sample.taskType).toBe(domain);
      },
    );
  });

  describe('4. 归一不得污染 ai_experience.intent', () => {
    it("experience.intent 仍为原工具名 'createSalesOrder'（任务卡 R3-4）", async () => {
      const { sample, experience } = await captureSample({
        intent: 'createSalesOrder',
      });
      // 样本侧已归一
      expect(sample.taskType).toBe('sales_order');
      // 经验侧必须保持工具名 —— 那是「调了哪个工具」的审计语义
      expect(experience.intent).toBe('createSalesOrder');
    });

    it('未命中值时两侧口径一致（原样透传，不做任何改写）', async () => {
      const { sample, experience } = await captureSample({
        domain: 'analysis',
        intent: 'office_document',
      });
      expect(sample.taskType).toBe('office_document');
      expect(experience.intent).toBe('office_document');
    });

    it('intent 缺省时 experience.intent 为 null（不被 domain 污染）', async () => {
      const { experience } = await captureSample({
        domain: 'write',
        intent: undefined,
      });
      expect(experience.intent).toBeNull();
    });
  });

  describe('5. 注册表 14 类 docType 全覆盖 + 映射表完整性', () => {
    // it.each 覆盖 14 个 docType，每个 docType 至少一条
    it.each(EXPECTED_MAPPING)(
      '工具名 %s ⇒ 落库 taskType %s',
      async (toolName, docType) => {
        const { sample } = await captureSample({ intent: toolName });
        expect(sample.taskType).toBe(docType);
      },
    );

    it('promotion 的 6 个工具名全部归一到 promotion（1:N 映射）', async () => {
      const promotionTools = [
        'api_create_flash_sale',
        'createCouponTemplate',
        'createFullReduction',
        'createGroupBuy',
        'createGiftRule',
        'createLimitedDiscount',
      ];
      for (const toolName of promotionTools) {
        const { sample } = await captureSample({ intent: toolName });
        expect(sample.taskType).toBe('promotion');
      }
    });

    // 防注册表漂移：本spec 的硬编码期望必须与注册表实际内容完全一致，
    // 否则上面的 it.each 可能在测一个已经不存在的映射。
    it('EXPECTED_MAPPING 与注册表实际 docType 集合完全一致（14 类）', () => {
      const actual = listWriteSchemas()
        .map((s) => s.docType)
        .sort();
      const expected = [...new Set(EXPECTED_MAPPING.map(([, d]) => d))].sort();
      expect(actual).toHaveLength(14);
      expect(expected).toHaveLength(14);
      expect(actual).toEqual(expected);
    });

    it('注册表无 write_schema. 前缀（消费侧只剥前缀、比对裸 docType）', () => {
      for (const schema of listWriteSchemas()) {
        expect(schema.docType.startsWith('write_schema.')).toBe(false);
      }
    });

    it('工具名 → docType 无二义（不存在一个工具名映射到两个 docType）', () => {
      const seen = new Map<string, string>();
      for (const schema of listWriteSchemas()) {
        for (const toolName of schema.toolNames) {
          const prev = seen.get(toolName);
          expect(prev).toBeUndefined();
          seen.set(toolName, schema.docType);
        }
      }
      // 反向：docType 必须无 write_schema. 前缀且非空
      for (const docType of seen.values()) {
        expect(docType).not.toMatch(/^write_schema\./);
      }
    });
  });
});
