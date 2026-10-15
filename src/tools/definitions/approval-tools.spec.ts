/**
 * 审批工具（Create / List / Cancel / Update）测试 —— R101-AI-38
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① Create preview 零副作用（不查库不落库）；mutation：去早返回 ⇒ 红
 * ② Create 幂等**业务层承重**（related_biz 可空 ⇒ DB 唯一键不判重时靠它）；mutation：去业务幂等 ⇒ 红
 * ③ Create 竞态兜底（DB 唯一键冲突 ⇒ 再读回放）；mutation：去兜底 ⇒ 红
 * ④ List **库层条件**必须是三支 OR（ACL 授予 / 我申请 / 待我审批）；mutation：收窄为 base ⇒ 红
 * ⑤ List **纵深防御**：库条件漏配多返回越权行时逐行确认须丢弃；mutation：全放行 ⇒ 红
 * ⑥ Cancel 复用基类：申请人可撤 pending；**已 approved ⇒ 明确失败不改状态**；mutation：去 status 条件 ⇒ 红
 * ⑦ Update **拒 status**；mutation：允许 ⇒ 红
 * ⑧ Update **仅 draft 可改**（pending ⇒ 拒绝）；mutation：去掉 draft 判定 ⇒ 红
 *
 * 说明：本文件把 4 个工具放在一起（同一批、同一 ACL 桩），**每个工具均有独立断言与 mutation**。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiApprovalCancelTool } from './ai-approval-cancel.tool';
import { AiApprovalCreateTool } from './ai-approval-create.tool';
import { AiApprovalListTool } from './ai-approval-list.tool';
import { AiApprovalUpdateTool } from './ai-approval-update.tool';

function opValue(v: unknown): unknown[] | null {
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; _value?: unknown; type?: string };
    const raw = o.value ?? o._value;
    if (o.type === "in" && Array.isArray(raw)) return raw as unknown[];
  }
  return null;
}

const CTX: ToolContext = { tenantId: 't1', userId: 'u-app' };

function approvalOf(over: Partial<AiApprovalEntity> = {}): AiApprovalEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '差旅报销 3200 元',
    type: 'expense',
    applicant: 'user:u-app',
    approver: 'user:u-approver',
    status: 'pending',
    payload: null,
    decisionReason: null,
    relatedBiz: 'BILL-1',
    createdBy: 'u-app',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function aclStub(
  opts: { granted?: string[]; access?: string; write?: boolean } = {},
) {
  return {
    aclGrantedIds: jest.fn(() => Promise.resolve(opts.granted ?? [])),
    resolveResource: jest.fn(() => Promise.resolve(opts.access ?? 'admin')),
    canWriteResource: jest.fn(() => Promise.resolve(opts.write ?? true)),
  } as unknown as OfficeAclService;
}

// ══════════════ Create ══════════════
function createHarness(
  opts: {
    existing?: AiApprovalEntity | null;
    raced?: AiApprovalEntity | null;
    saveRejects?: string;
  } = {},
) {
  let finds = 0;
  const findOne = jest.fn(() => {
    finds += 1;
    return Promise.resolve(
      finds === 1 ? (opts.existing ?? null) : (opts.raced ?? null),
    );
  });
  const save = jest.fn((e: Partial<AiApprovalEntity>) => {
    if (opts.saveRejects) return Promise.reject(new Error(opts.saveRejects));
    return Promise.resolve({ ...e, id: '55' } as AiApprovalEntity);
  });
  const create = jest.fn((e: Partial<AiApprovalEntity>) => e);
  return {
    tool: new AiApprovalCreateTool({ findOne, save, create } as never),
    findOne,
    save,
    create,
  };
}

describe('AiApprovalCreateTool（R101-AI-38 提交申请）', () => {
  it('① preview 零副作用', async () => {
    const h = createHarness();
    const result = await h.tool.execute(
      { title: '差旅报销', type: 'expense', approver: 'user:u-approver' },
      CTX,
    );
    expect(result.success).toBe(true);
    const d = result.preview?.details as Record<string, unknown>;
    expect(d.nextStatus).toBe('pending');
    expect(d.applicant).toBe('user:u-app');
    expect(String(d.boundary)).toContain('不替代 MS');
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('② 幂等业务层（承重）：同键未终态 ⇒ 回放且不重复 save', async () => {
    const h = createHarness({
      existing: approvalOf({ id: '9', status: 'draft' }),
    });
    const result = await h.tool.execute(
      {
        title: '差旅报销',
        type: 'expense',
        approver: 'user:t',
        relatedBiz: 'BILL-1',
        confirm: true,
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    expect((result.data as { approvalId: string }).approvalId).toBe('9');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('③ 竞态兜底：DB 唯一键冲突 ⇒ 再读回放', async () => {
    const h = createHarness({
      existing: null,
      raced: approvalOf({ id: '88' }),
      saveRejects: 'UNIQUE constraint failed: t_ai_approval',
    });
    const result = await h.tool.execute(
      {
        title: 'T',
        type: 'expense',
        approver: 'user:t',
        relatedBiz: 'BILL-1',
        confirm: true,
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    expect((result.data as { approvalId: string }).approvalId).toBe('88');
  });

  it('④ submit=false ⇒ 草稿；approver 格式非法 ⇒ 拒绝', async () => {
    const h = createHarness();
    const draft = await h.tool.execute(
      {
        title: 'T',
        type: 'expense',
        approver: 'user:t',
        submit: false,
        confirm: true,
      },
      CTX,
    );
    expect((draft.data as { status: string }).status).toBe('draft');

    const bad = await h.tool.execute(
      { title: 'T', type: 'expense', approver: 'boss', confirm: true },
      CTX,
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('approver');
  });
});

// ══════════════ List ══════════════
function listHarness(
  rows: AiApprovalEntity[],
  opts: { granted?: string[]; access?: string; injectRogue?: boolean } = {},
) {
  const find = jest.fn(() => {
    const out = rows.slice();
    if (opts.injectRogue) {
      out.push(
        approvalOf({
          id: '999',
          applicant: 'user:other',
          approver: 'user:other',
        }),
      );
    }
    return Promise.resolve(out);
  });
  const tool = new AiApprovalListTool(
    { find } as never,
    aclStub({ granted: opts.granted, access: opts.access }),
  );
  return { tool, find };
}

describe('AiApprovalListTool（R101-AI-38 审批列表 · 库层隔离）', () => {
  it('④ 库层条件为三支 OR（ACL 授予 / 我申请 / 待我审批）', async () => {
    const h = listHarness([approvalOf()], { granted: ['7'] });
    const result = await h.tool.execute({}, CTX);
    expect(result.success).toBe(true);
    const where = (h.find.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    expect(Array.isArray(where)).toBe(true);
    const branches = where as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(3);
    expect(branches.every((b) => b.tenantId === 't1')).toBe(true);
    // 补测点（自审发现的漏测）：ACL 授予支必须携带 granted 集合，否则收窄失效
    expect(opValue(branches[0].id)).toEqual(['7']);
    expect(branches[1].applicant).toBe('user:u-app');
    expect(branches[2].approver).toBeDefined();
    const bucket = (result.data as { aclBucket: { scope: string } }).aclBucket;
    expect(bucket.scope).toContain('tenant');
  });

  it('⑤ 纵深防御：库条件漏配多返回越权行 ⇒ 逐行确认丢弃它', async () => {
    const h = listHarness([approvalOf()], {
      access: 'none',
      injectRogue: true,
    });
    const result = await h.tool.execute({}, CTX);
    // 只有"我申请的"那条通过逐行确认（access=none，但 applicant=me）
    const ids = (
      result.data as { list: Array<{ approvalId: string }> }
    ).list.map((x) => x.approvalId);
    expect(ids).toEqual(['12']);
    // mutation 检验点：逐行确认全放行 ⇒ 999 出现 ⇒ 本例红
  });
});

// ══════════════ Cancel ══════════════
function cancelHarness(
  opts: {
    approval?: AiApprovalEntity | null;
    affected?: number;
    after?: AiApprovalEntity | null;
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
  return {
    tool: new AiApprovalCancelTool(
      { findOne, update } as never,
      aclStub({ write: false }),
    ),
    findOne,
    update,
  };
}

describe('AiApprovalCancelTool（R101-AI-38 撤回 · 复用基类状态机）', () => {
  it('⑥ 申请人可撤 pending（原子条件 status=pending）', async () => {
    const h = cancelHarness();
    const result = await h.tool.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(result.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].status).toBe('pending');
    expect(call[1].status).toBe('cancelled');
  });

  it('⑥b 已 approved ⇒ 明确失败、不改状态（撤回限制）', async () => {
    const h = cancelHarness({ approval: approvalOf({ status: 'approved' }) });
    const result = await h.tool.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('approved');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑥c 非申请人且无 ACL write ⇒ 拒绝', async () => {
    const h = cancelHarness({
      approval: approvalOf({ applicant: 'user:other' }),
    });
    const result = await h.tool.execute(
      { approvalId: '12', confirm: true },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('无权');
    expect(h.update).not.toHaveBeenCalled();
  });
});

// ══════════════ Update ══════════════
function updateHarness(
  opts: { approval?: AiApprovalEntity | null; write?: boolean } = {},
) {
  const findOne = jest.fn(() =>
    Promise.resolve(
      opts.approval === undefined
        ? approvalOf({ status: 'draft' })
        : opts.approval,
    ),
  );
  const save = jest.fn((e: AiApprovalEntity) => Promise.resolve(e));
  return {
    tool: new AiApprovalUpdateTool(
      { findOne, save } as never,
      aclStub({ write: opts.write ?? true }),
    ),
    findOne,
    save,
  };
}

describe('AiApprovalUpdateTool（R101-AI-38 改草稿）', () => {
  it('⑦ 不接受 status（先于一切拒绝）', async () => {
    const h = updateHarness();
    const result = await h.tool.execute(
      { approvalId: '12', status: 'approved', confirm: true },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('不接受 status');
    expect(result.suggestion).toContain('aiApprovalApprove');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('⑧ 仅 draft 可改：pending ⇒ 明确拒绝', async () => {
    const h = updateHarness({ approval: approvalOf({ status: 'pending' }) });
    const result = await h.tool.execute(
      { approvalId: '12', title: '改标题', confirm: true },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('仅草稿');
    expect(h.save).not.toHaveBeenCalled();

    const ok = updateHarness();
    const r2 = await ok.tool.execute(
      { approvalId: '12', title: '改标题', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(true);
    expect(ok.save.mock.calls[0][0].title).toBe('改标题');
  });

  it('⑧b preview 不落库 + 权限不足拒绝', async () => {
    const h = updateHarness();
    const preview = await h.tool.execute(
      { approvalId: '12', title: '改标题' },
      CTX,
    );
    expect(preview.success).toBe(true);
    expect(h.save).not.toHaveBeenCalled();

    const denied = updateHarness({ write: false });
    const r = await denied.tool.execute(
      { approvalId: '12', title: 'x', confirm: true },
      CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('无权修改');
  });
});
