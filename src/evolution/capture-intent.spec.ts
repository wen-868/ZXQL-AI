/**
 * normalizeCaptureIntent 归一矩阵测试（AI-P2-4-CAPTURE-INTENT-NORMALIZE-01）
 *
 * 口径：normalizeCaptureIntent(toolOrIntent, fallback='chat')
 *       = docTypeForTool(trimmed) ?? trimmed ?? fallback
 * - 映射命中 → 裸 docType（唯一映射真源 = write-schema-registry）；
 * - 未映射工具名保持原值（不得折叠成 chat）；
 * - 非工具意图（office_document/write/analysis/agent_plan/graph）保持原值；
 * - 空值/纯空白回退 fallback。
 */
import {
  buildCaptureTaskInput,
  buildDomainCaptureTaskInput,
  CaptureTenantMissingError,
  normalizeCaptureIntent,
} from './capture-intent';

describe('normalizeCaptureIntent（三通道 Capture intent 归一矩阵）', () => {
  describe('映射命中 → 裸 docType（卡面三.1 七例全覆盖）', () => {
    it.each([
      ['createSalesOrder', 'sales_order'],
      ['createCustomer', 'customer_create'],
      ['updateProductPrice', 'price_update'],
      ['inventoryTransfer', 'inventory_transfer'],
      ['stockCheck', 'inventory_check'],
      ['createRefund', 'refund'],
      ['api_create_flash_sale', 'promotion'],
    ] as const)('%s ⇒ %s', (tool, expected) => {
      expect(normalizeCaptureIntent(tool)).toBe(expected);
    });
  });

  describe('未映射与非工具意图保持原值（不得折叠成 chat）', () => {
    it('未映射工具名保持原值', () => {
      expect(normalizeCaptureIntent('querySaleBills')).toBe('querySaleBills');
    });

    it.each([
      'office_document',
      'write',
      'analysis',
      'agent_plan',
      'graph',
    ] as const)("非工具意图 '%s' 保持原值", (intent) => {
      expect(normalizeCaptureIntent(intent)).toBe(intent);
    });

    it('前后空白先 trim 再查表（空白包裹的映射名仍命中）', () => {
      expect(normalizeCaptureIntent('  createSalesOrder  ')).toBe(
        'sales_order',
      );
    });

    it('trim 后原值返回（不带尾随空白）', () => {
      expect(normalizeCaptureIntent('  querySaleBills  ')).toBe(
        'querySaleBills',
      );
    });
  });

  describe('空值回退', () => {
    it.each([undefined, null, '', '   '] as const)(
      '空值 %p ⇒ 缺省 fallback chat',
      (v) => {
        expect(normalizeCaptureIntent(v)).toBe('chat');
      },
    );

    it('显式 fallback：graph 通道空工具回退 graph', () => {
      expect(normalizeCaptureIntent(undefined, 'graph')).toBe('graph');
    });

    it('显式 fallback：agent 通道空值回退 agent', () => {
      expect(normalizeCaptureIntent('', 'agent')).toBe('agent');
    });
  });

  describe('反测边界（防回归）', () => {
    it('未知工具不得被折叠成 chat（M2 反测锚）', () => {
      const result = normalizeCaptureIntent('totallyUnknownTool');
      expect(result).not.toBe('chat');
      expect(result).toBe('totallyUnknownTool');
    });

    it('非工具意图不得被规则推导成假 docType', () => {
      // write/analysis 若被驼峰转下划线之类推导会凭空造出注册表不存在的值
      expect(normalizeCaptureIntent('write')).toBe('write');
      expect(normalizeCaptureIntent('analysis')).toBe('analysis');
    });
  });

  // ════ S2：buildCaptureTaskInput 组装单源（收敛实施卡 S2）════
  describe('buildCaptureTaskInput（三通道 capture 输入组装单源）', () => {
    it('chat 形态：未映射工具保持原值、无失败轨迹 ⇒ domain=analysis、outcome=success', () => {
      const input = buildCaptureTaskInput({
        tenantId: 't1',
        intent: 'searchProduct',
        userMessage: '查商品',
        toolCalls: [{ tool_name: 'searchProduct', success: true }],
        outcome: 'success',
      });
      expect(input).toEqual({
        tenantId: 't1',
        domain: 'analysis',
        intent: 'searchProduct',
        userMessage: '查商品',
        toolCalls: [{ tool_name: 'searchProduct', success: true }],
        outcome: 'success',
        reply: undefined,
        error: undefined,
      });
    });

    it('agent 形态：稳定键 agent_plan 原样、domain 走 overrides（失败→write）', () => {
      const input = buildCaptureTaskInput(
        {
          tenantId: 't1',
          intent: 'agent_plan',
          userMessage: '计划目标',
          toolCalls: [],
          outcome: 'failed',
          error: 'step boom',
        },
        { domain: 'write', reply: '计划 1 完成：0 步成功，1 步失败' },
      );
      expect(input.intent).toBe('agent_plan');
      expect(input.domain).toBe('write');
      expect(input.outcome).toBe('failed');
      expect(input.reply).toContain('计划 1 完成');
      expect(input.error).toContain('step boom');
    });

    it('graph 形态：无工具回退 graph、轨迹含原始工具名与 graphId', () => {
      const input = buildCaptureTaskInput({
        tenantId: 't1',
        intent: 'graph',
        userMessage: 'graph:cap_evidence 哨兵图',
        toolCalls: [
          { tool_name: 'createSalesOrder', success: true },
          { event: 'graph_done', graphId: 'cap_evidence' },
        ],
        outcome: 'success',
      });
      expect(input.intent).toBe('graph');
      const traj = JSON.stringify(input.toolCalls);
      expect(traj).toContain('createSalesOrder');
      expect(traj).toContain('cap_evidence');
      expect(input.domain).toBe('analysis');
    });

    it('映射命中：intent 归一为裸 docType（createSalesOrder ⇒ sales_order）', () => {
      const input = buildCaptureTaskInput({
        tenantId: 't1',
        intent: 'createSalesOrder',
        outcome: 'success',
      });
      expect(input.intent).toBe('sales_order');
    });

    it('tenantId 恒透传（M6 反测锚：组装层不丢租户）', () => {
      const input = buildCaptureTaskInput({
        tenantId: 'tenant-keep',
        intent: 'chat',
        outcome: 'success',
      });
      expect(input.tenantId).toBe('tenant-keep');
    });

    it('失败轨迹存在 ⇒ 缺省 domain=write（无 overrides 时）', () => {
      const input = buildCaptureTaskInput({
        tenantId: 't1',
        intent: 'chat',
        toolCalls: [{ tool_name: 'createSalesOrder', success: false }],
        outcome: 'failed',
      });
      expect(input.domain).toBe('write');
    });
  });

  // ════ AI-P2-5-CAPTURE-CONSUMER-CONVERGENCE-01：域消费者单源 ════
  describe('buildDomainCaptureTaskInput（三通道外域消费者单源）', () => {
    it('域任务类型保持原值：office_report 不被折叠也不被规则推导（域语义保留）', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_report',
        outcome: 'success',
      });
      expect(input.intent).toBe('office_report');
      expect(input.intent).not.toBe('chat');
    });

    it('域任务类型与落库层归一幂等：office_document 两层同值', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_document',
        outcome: 'success',
      });
      // 落库层 normalizeCaptureIntent 二次归一应得同值（幂等，防双层口径漂移）
      expect(input.intent).toBe('office_document');
      expect(normalizeCaptureIntent(input.intent)).toBe('office_document');
    });

    it('学习域任务名（中文）保持原值', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: '创建销售单',
        outcome: 'success',
      });
      expect(input.intent).toBe('创建销售单');
    });

    it('tenantId 缺失（undefined/null/空白）⇒ fail-closed 抛 CaptureTenantMissingError，不补默认租户', () => {
      expect(() => buildDomainCaptureTaskInput({ intent: 'office_report', outcome: 'success' })).toThrow(CaptureTenantMissingError);
      expect(() => buildDomainCaptureTaskInput({ tenantId: null, intent: 'office_report', outcome: 'success' })).toThrow(CaptureTenantMissingError);
      expect(() => buildDomainCaptureTaskInput({ tenantId: '   ', intent: 'office_report', outcome: 'success' })).toThrow(CaptureTenantMissingError);
      // 反测：错误信息只声明拒绝，不给出任何回退/默认租户语义
      try {
        buildDomainCaptureTaskInput({ tenantId: '', intent: 'office_report', outcome: 'success' });
        fail('should throw');
      } catch (e) {
        expect((e as Error).message).toContain('fail-closed');
        expect((e as Error).message).not.toMatch(/fallback tenant|default tenant|tenant-\d/i);
      }
    });

    it('tenantId 空白包裹值先 trim 再透传（合法租户不误杀）', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: '  tenant-x  ',
        intent: 'office_report',
        outcome: 'success',
      });
      expect(input.tenantId).toBe('tenant-x');
    });

    it('outcome 三态映射透传（学习域 corrected/failed 不被翻转）', () => {
      for (const outcome of ['success', 'corrected', 'failed'] as const) {
        const input = buildDomainCaptureTaskInput({
          tenantId: 't1',
          intent: '创建销售单',
          outcome,
        });
        expect(input.outcome).toBe(outcome);
      }
    });

    it('domain overrides 透传：学习域有工具轨迹 ⇒ write，无轨迹 ⇒ analysis', () => {
      const withTool = buildDomainCaptureTaskInput(
        { tenantId: 't1', intent: '创建销售单', outcome: 'success' },
        { domain: 'write' },
      );
      expect(withTool.domain).toBe('write');
      const noTool = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: '发布视频',
        outcome: 'corrected',
      });
      expect(noTool.domain).toBe('analysis');
    });

    it('sampleQuality 透传（办公评分 1-5 不参与归一推断、不被丢弃）', () => {
      const viaOverride = buildDomainCaptureTaskInput(
        { tenantId: 't1', intent: 'office_report', outcome: 'success' },
        { sampleQuality: 5 },
      );
      expect(viaOverride.sampleQuality).toBe(5);
      const viaCtx = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_report',
        outcome: 'success',
        sampleQuality: 2,
      });
      expect(viaCtx.sampleQuality).toBe(2);
      const none = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_report',
        outcome: 'success',
      });
      expect(none.sampleQuality).toBeUndefined();
    });

    it('trajectory 原始工具名保留（不被归一 docType 覆盖）', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_report',
        outcome: 'success',
        toolCalls: [{ tool_name: 'createSalesOrder', success: true }],
      });
      expect(JSON.stringify(input.toolCalls)).toContain('createSalesOrder');
      // intent 保持域语义不变（不因轨迹里有工具而改写）
      expect(input.intent).toBe('office_report');
    });

    it('userMessage/reply/error 逐字段透传（样本 prompt/completion 来源不丢）', () => {
      const input = buildDomainCaptureTaskInput({
        tenantId: 't1',
        intent: 'office_analysis',
        userMessage: '任务目标',
        reply: '产出摘要',
        error: '无',
        outcome: 'failed',
      });
      expect(input.userMessage).toBe('任务目标');
      expect(input.reply).toBe('产出摘要');
      expect(input.error).toBe('无');
    });

    it('与三通道 buildCaptureTaskInput 同源：同输入下 intent/domain/outcome 一致', () => {
      const ctx = {
        tenantId: 't-shared',
        intent: 'office_document',
        userMessage: '同源对账',
        outcome: 'success' as const,
      };
      const domain = buildDomainCaptureTaskInput(ctx);
      const channel = buildCaptureTaskInput(ctx);
      expect(domain.intent).toBe(channel.intent);
      expect(domain.domain).toBe(channel.domain);
      expect(domain.outcome).toBe(channel.outcome);
      expect(domain.tenantId).toBe(channel.tenantId);
    });
  });
});
