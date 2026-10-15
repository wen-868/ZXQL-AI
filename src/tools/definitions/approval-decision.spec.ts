/**
 * ApprovalDecision（Approve / Reject）测试 —— R101-AI-38
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① preview（confirm 缺省）⇒ 不调 update；mutation：去掉早返回 ⇒ 红
 * ② 🔴 **原子迁移条件**：`update` 的 criteria 必须含 `status:'pending'`
 *    mutation：去掉该条件 ⇒ ② 红
 * ③ 🔴 **重复审批 ⇒ 明确失败**（affected=0，且如实告知**当前状态**，**不回放成功**）
 *    mutation：退化成"先读后写/报成功" ⇒ ③ 红
 *    另证：并发中他人做了**相反**决定（approved vs rejected）时不得误导为成功
 * ④ 非审批人（且无 ACL write）⇒ 拒绝；mutation：跳过审批人校验 ⇒ 红
 * ⑤ draft / 终态 ⇒ 明确拒绝（状态机前置于写入）
 * ⑥ Reject：理由必填（缺 ⇒ 拒绝）；确认后目标状态 rejected 且 reason 落库
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiApprovalApproveTool } from './ai-approval-approve.tool';
import { AiApprovalRejectTool } from './ai-approval-reject.tool';
import { matchesPrincipal } from './approval-decision.base';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-approver' };

function approvalOf(over: Partial<AiApprovalEntity> = {}): AiApprovalEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '差旅报销 3200 元',
    type: 'expense',
    applicant: 'user:u-applicant',
    approver: 'user:u-approver',
    status: 'pending',
    payload: '{"amount":3200}',
    decisionReason: null,
    relatedBiz: 'BILL-2026-001',
    createdBy: 'u-applicant',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function createHarness(
  opts: {
    approval?: AiApprovalEntity | null;
    affected?: number;
    after?: AiApprovalEntity | null;
    aclWrite?: boolean;
  } = {},
) {
  let finds = 0;
  const findOne = jest.fn(() => {
    finds += 1;
    return Promise.resolve(
      finds === 1
        ? opts.approval === undefined
          ? approvalOf()
          : opts.approval
        : (opts.after ?? null),
    );
  });
  const update = jest.fn(() =>
    Promise.resolve({ affected: opts.affected ?? 1 }),
  );
  const canWriteResource = jest.fn(() =>
    Promise.resolve(opts.aclWrite ?? false),
  );
  const acl = { canWriteResource } as unknown as OfficeAclService;
  const approve = new AiApprovalApproveTool({ findOne, update } as never, acl);
  const reject = new AiApprovalRejectTool({ findOne, update } as never, acl);
  return { approve, reject, findOne, update, canWriteResource };
}

describe('审批决策（R101-AI-38 · Approve/Reject 共用状态机）', () => {
  it('① preview（confirm 缺省）⇒ 不调 update，含 nextStatus', async () => {
    const h = createHarness();

    const result = await h.approve.execute({ approvalId: '12' }, CTX);

    expect(result.success).toBe(true);
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.currentStatus).toBe('pending');
    expect(details.nextStatus).toBe('approved');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('② 🔴 原子迁移条件含 status=pending；确认后置 approved + 意见落库', async () => {
    const h = createHarness();

    const result = await h.approve.execute(
      { approvalId: '12', reason: '同意', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.update).toHaveBeenCalledTimes(1);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].id).toBe('12');
    expect(call[0].tenantId).toBe('t1');
    expect(call[0].status).toBe('pending'); // ← 承重：并发下唯一生效的条件
    expect(call[1].status).toBe('approved');
    expect(call[1].decisionReason).toBe('同意');
    // mutation 检验点：criteria 去掉 status ⇒ 本断言红（并发可双写）
  });

  it('③ 🔴 重复/并发审批 ⇒ 明确失败并告知当前状态（**不回放成功**）', async () => {
    // 场景：我点"通过"，但并发的另一个人已"驳回"（相反决定）
    const h = createHarness({
      affected: 0,
      after: approvalOf({ status: 'rejected', decisionReason: '超预算' }),
    });

    const result = await h.approve.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('已被处理');
    expect(result.error).toContain('rejected');
    expect(result.error).toContain('超预算');
    // 关键：不得把"别人的相反决定"回放成"我通过成功"
    expect(result.idempotent_replay).toBeUndefined();
    // mutation 检验点：退化为"先读后写/直接报成功" ⇒ 本例红
  });

  it('④ 非审批人且无 ACL write ⇒ 拒绝且不 update', async () => {
    const h = createHarness({
      approval: approvalOf({ approver: 'user:u-other' }),
      aclWrite: false,
    });

    const result = await h.approve.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权审批');
    expect(result.suggestion).toContain('u-other');
    expect(h.update).not.toHaveBeenCalled();
    // mutation 检验点：跳过审批人校验 ⇒ 本例红
  });

  it('④b 被 ACL 授予 write 者也可决策（不要求必须是指定审批人）', async () => {
    const h = createHarness({
      approval: approvalOf({ approver: 'role:finance' }),
      aclWrite: true,
    });

    const result = await h.approve.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.canWriteResource).toHaveBeenCalledTimes(1);
  });

  it('⑤ 状态机前置：draft 不可决策、终态不可重复决策', async () => {
    const draft = createHarness({ approval: approvalOf({ status: 'draft' }) });
    const r1 = await draft.approve.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('draft');
    expect(draft.update).not.toHaveBeenCalled();

    const done = createHarness({
      approval: approvalOf({ status: 'approved' }),
    });
    const r2 = await done.approve.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('approved');
    expect(done.update).not.toHaveBeenCalled();
  });

  it('⑥ Reject：理由必填；有理由 ⇒ 目标 rejected 且 reason 落库', async () => {
    const h = createHarness();

    const noReason = await h.reject.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(noReason.success).toBe(false);
    expect(noReason.error).toContain('必须填写理由');
    expect(h.update).not.toHaveBeenCalled();

    const ok = await h.reject.execute(
      { approvalId: '12', reason: '金额超预算', confirm: true },
      CTX,
    );
    expect(ok.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[1].status).toBe('rejected');
    expect(call[1].decisionReason).toBe('金额超预算');
  });

  it('⑦ 审批人匹配口径（user/role/employee）', () => {
    expect(matchesPrincipal('user:u-1', { type: 'user', id: 'u-1' })).toBe(
      true,
    );
    expect(matchesPrincipal('user:u-1', { type: 'user', id: 'u-2' })).toBe(
      false,
    );
    expect(
      matchesPrincipal('role:finance', {
        type: 'user',
        id: 'u-1',
        roles: ['finance'],
      }),
    ).toBe(true);
    expect(
      matchesPrincipal('employee:e-1', { type: 'employee', id: 'e-1' }),
    ).toBe(true);
    // 类型不同不误命中
    expect(matchesPrincipal('role:u-1', { type: 'user', id: 'u-1' })).toBe(
      false,
    );
  });
});
