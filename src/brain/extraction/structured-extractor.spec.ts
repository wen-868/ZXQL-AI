/**
 * P0-2 StructuredExtractor 单元测试
 *
 * 覆盖：
 * 1. function calling 抽取成功 + 类型强制
 * 2. JSON mode 兜底（含 markdown 围栏剥离）
 * 3. 必填缺失 → 反问澄清（不挂残缺草稿）
 * 4. 非法枚举 → 澄清
 * 5. 数量语义辅助（"来10箱五粮液" → boxQty=10）
 * 6. 与写入意图无关 → matched=false
 * 7. LLM 异常 → 降级（success=false，不阻断业务）
 * 8. tryEnhance 写分支增强（合并补缺 / 需澄清 / 未命中）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { StructuredExtractor } from './structured-extractor';
import type {
  ChatResult,
  IModelProvider,
} from '../../providers/provider.interface';

interface ProviderHarness {
  provider: IModelProvider;
  chatSync: jest.Mock;
}

function createProvider(result?: Partial<ChatResult>): ProviderHarness {
  const chatSync = jest.fn().mockResolvedValue({
    content: '',
    prompt_tokens: 10,
    completion_tokens: 20,
    ...result,
  });
  const provider = {
    name: 'glm',
    chatSync,
    chat: jest.fn(),
    embedding: jest.fn(),
    testConnection: jest.fn(),
    configure: jest.fn(),
  } as IModelProvider;
  return { provider, chatSync };
}

function createExtractor(harness: ProviderHarness): {
  extractor: StructuredExtractor;
  chatSync: jest.Mock;
} {
  const extractor = new StructuredExtractor(
    {
      route: jest.fn().mockReturnValue({
        providerName: 'glm',
        provider: harness.provider,
        reason: 'mock',
      }),
      getSystemScope: jest.fn().mockReturnValue('mgmt'),
    } as never,
    {
      getResolvedConfig: jest
        .fn()
        .mockResolvedValue({ provider: 'glm', providerConfig: undefined }),
    } as never,
    {
      get: jest.fn().mockReturnValue('mgmt'),
    } as never,
  );
  return { extractor, chatSync: harness.chatSync };
}

describe('P0-2 StructuredExtractor', () => {
  it('function calling 抽取成功：销售单参数完整且 valid', async () => {
    const harness = createProvider({
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'extract_sales_order',
            arguments: JSON.stringify({
              customerName: '红星商行',
              items: [
                {
                  skuName: '五粮液',
                  boxQty: 5,
                  bottleQty: 2,
                  unitPrice: 980,
                },
              ],
              saleType: 'CASH',
            }),
          },
        },
      ],
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'sales_order',
      utterance: '给红星商行开5箱2瓶五粮液，单价980',
    });

    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.data.customerName).toBe('红星商行');
    const items = result.data.items as Array<Record<string, unknown>>;
    expect(items[0].skuName).toBe('五粮液');
    expect(items[0].boxQty).toBe(5);
    expect(items[0].bottleQty).toBe(2);
    expect(items[0].unitPrice).toBe(980);
  });

  it('类型强制：字符串数字转 number，中文枚举归一', async () => {
    const harness = createProvider({
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'extract_payment',
            arguments: JSON.stringify({
              supplierName: '泸州老窖',
              amount: '9800',
              paymentMethod: 'BANK',
            }),
          },
        },
      ],
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'payment',
      utterance: '给泸州老窖付款9800元',
    });

    expect(result.valid).toBe(true);
    expect(result.data.amount).toBe(9800);
    expect(typeof result.data.amount).toBe('number');
  });

  it('JSON mode 兜底：无 tool_calls 时解析 content JSON（含 markdown 围栏）', async () => {
    const harness = createProvider({
      content: '```json\n{"name":"测试客户","phone":"13900000001"}\n```',
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'customer_create',
      utterance: '新建客户测试客户，电话13900000001',
    });

    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.data.name).toBe('测试客户');
    expect(result.data.phone).toBe('13900000001');
  });

  it('必填缺失：返回澄清问题，valid=false（不挂残缺草稿）', async () => {
    const harness = createProvider({
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'extract_refund',
            arguments: JSON.stringify({
              returnNo: 'TH202608010001',
            }),
          },
        },
      ],
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'refund',
      utterance: '把TH202608010001退了',
    });

    // refund 缺 refundMethod（必填枚举）
    expect(result.valid).toBe(false);
    expect(result.clarifyingQuestions.length).toBeGreaterThan(0);
    expect(result.clarifyingQuestions.some((q) => q.includes('退款方式'))).toBe(
      true,
    );
  });

  it('非法枚举：触发澄清', async () => {
    const harness = createProvider({
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'extract_refund',
            arguments: JSON.stringify({
              returnNo: 'TH202608010001',
              refundMethod: '支付宝',
            }),
          },
        },
      ],
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'refund',
      utterance: 'TH202608010001 用支付宝退',
    });

    expect(result.valid).toBe(false);
    expect(result.issues[0].reason).toBe('type');
    expect(result.clarifyingQuestions[0]).toContain('退款方式');
  });

  it('数量语义辅助：口语"来10箱五粮液"补全 boxQty', async () => {
    const harness = createProvider({
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'extract_sales_order',
            arguments: JSON.stringify({
              customerName: '红星商行',
              items: [{ skuName: '五粮液', unitPrice: 980 }],
            }),
          },
        },
      ],
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'sales_order',
      utterance: '给红星商行来10箱五粮液，单价980',
    });

    expect(result.valid).toBe(true);
    const items = result.data.items as Array<Record<string, unknown>>;
    expect(items[0].boxQty).toBe(10);
  });

  it('与写入意图无关：matched=false（不误拦截）', async () => {
    const harness = createProvider({
      content: '无关',
    });
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'sales_order',
      utterance: '今天天气怎么样',
    });

    expect(result.success).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('LLM 异常：降级返回 success=false（不阻断业务）', async () => {
    const harness = createProvider();
    harness.chatSync.mockRejectedValueOnce(new Error('provider timeout'));
    const { extractor } = createExtractor(harness);

    const result = await extractor.extract({
      docType: 'sales_order',
      utterance: '给红星商行开5箱五粮液',
    });

    expect(result.success).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('provider timeout');
  });

  describe('tryEnhance（写分支增强）', () => {
    it('未命中 Schema：used=false，走原流程', async () => {
      const harness = createProvider();
      const { extractor } = createExtractor(harness);

      const result = await extractor.tryEnhance({
        toolName: 'queryInventory',
        utterance: '五粮液还有多少',
        args: { skuName: '五粮液' },
      });

      expect(result.used).toBe(false);
      expect(result.needsClarification).toBe(false);
    });

    it('抽取成功：合并补缺（保留已有 items）', async () => {
      const harness = createProvider({
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'extract_sales_order',
              arguments: JSON.stringify({
                customerName: '红星商行',
                items: [{ skuName: '五粮液', boxQty: 5 }],
              }),
            },
          },
        ],
      });
      const { extractor } = createExtractor(harness);

      const result = await extractor.tryEnhance({
        toolName: 'createSalesOrder',
        utterance: '给红星商行开5箱五粮液',
        args: {
          customerId: 1,
          items: [{ skuId: 10, boxQty: 5, productInfo: {} }],
        },
      });

      expect(result.used).toBe(true);
      expect(result.needsClarification).toBe(false);
      // 已有 items 保留（LLM function calling 已带 skuId）
      const items = result.args?.items as Array<Record<string, unknown>>;
      expect(items[0].skuId).toBe(10);
      // 缺失字段（remark/saleType）不强制，customerName 已存在则不覆盖
      expect(result.args?.customerId).toBe(1);
    });

    it('必填缺失：needsClarification=true，不挂残缺草稿', async () => {
      const harness = createProvider({
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'extract_refund',
              arguments: JSON.stringify({ returnNo: 'TH1' }),
            },
          },
        ],
      });
      const { extractor } = createExtractor(harness);

      const result = await extractor.tryEnhance({
        toolName: 'createRefund',
        utterance: '把TH1退了',
        args: { returnNo: 'TH1' },
      });

      expect(result.used).toBe(true);
      expect(result.needsClarification).toBe(true);
      expect(result.questions?.[0]).toContain('退款方式');
    });

    it('LLM 异常：used=true 但降级原流程（不阻断）', async () => {
      const harness = createProvider();
      harness.chatSync.mockRejectedValueOnce(new Error('timeout'));
      const { extractor } = createExtractor(harness);

      const result = await extractor.tryEnhance({
        toolName: 'createSalesOrder',
        utterance: '给红星商行开5箱五粮液',
        args: { customerName: '红星商行', items: [{ skuId: 10 }] },
      });

      expect(result.used).toBe(true);
      expect(result.needsClarification).toBe(false);
      expect(result.args?.customerName).toBe('红星商行');
    });
  });
});
