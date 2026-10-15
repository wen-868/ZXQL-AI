/**
 * DocAclService 测试（R101-AI-35 S2 · ACL 判定独立服务）
 *
 * 反测原则（"坏了会红吗"）：每条断言都压在一个**承重条件**上
 * ① **租户优先**：A 租户的文档对 B 租户不可见（mutation：去掉 tenant 判定 ⇒ 本例红）
 * ② **ACL 过滤**：无 ACL 行的非 owner 读不到（mutation：去掉 ACL 检查 ⇒ 本例红）
 * ③ ACL 梯度：read < write < admin（取最高）；匹配 user / role / employee 三类主体
 * ④ 数字员工（employee）同为 principal
 * ⑤ archived：可读不可写
 * ⑥ 平台身份：跨租户 admin 兜底
 *
 * 用轻量仓储桩直接构造（构造依赖只有仓储 ⇒ 无需 Nest 容器）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import {
  AiDocAclEntity,
  DocPerm,
  DocPrincipalType,
} from '../database/entities/ai-doc-acl.entity';
import { AiDocEntity } from '../database/entities/ai-doc.entity';
import { DocAclContext, DocAclService, DocPrincipal } from './doc-acl.service';

function docOf(over: Partial<AiDocEntity> = {}): AiDocEntity {
  return {
    id: '1',
    tenantId: 't1',
    title: '合同A',
    category: 'contract',
    owner: 'u-owner',
    sourceType: 'upload',
    contentHash: 'h1',
    storagePath: null,
    status: 'active',
    version: 1,
    createdBy: 'u-owner',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function aclOf(
  docId: string,
  type: DocPrincipalType,
  id: string,
  perm: DocPerm,
  tenantId = 't1',
): AiDocAclEntity {
  return {
    id: `${docId}-${type}-${id}`,
    tenantId,
    docId,
    principalType: type,
    principalId: id,
    perm,
    createdAt: new Date(),
  };
}

/** 轻量仓储桩：按 where 的 tenantId / docId / principalId In(...) 过滤 */
function createService(docs: AiDocEntity[], acls: AiDocAclEntity[]) {
  const docRepo = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        docs.filter((d) =>
          Object.entries(where).every(([k, v]) => {
            if (v && typeof v === 'object' && '_value' in v) {
              return (v as { _value: string[] })._value.includes(
                String((d as unknown as Record<string, unknown>)[k]),
              );
            }
            return (
              String((d as unknown as Record<string, unknown>)[k]) === String(v)
            );
          }),
        ),
      ),
    ),
    findOne: jest.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(docs.find((d) => d.id === where.id) ?? null),
    ),
  };
  const aclRepo = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        acls.filter((a) => {
          const ids = (where.principalId as { _value?: string[] })?._value;
          return (
            a.docId === where.docId &&
            a.tenantId === where.tenantId &&
            (ids ? ids.includes(a.principalId) : true)
          );
        }),
      ),
    ),
  };
  const svc = new DocAclService(docRepo as never, aclRepo as never);
  return { svc, docRepo, aclRepo };
}

const USER_A: DocPrincipal = { type: 'user', id: 'u-a' };
const ctxOf = (
  tenantId: string,
  principal: DocPrincipal = USER_A,
): DocAclContext => ({ tenantId, principal });

describe('DocAclService（R101-AI-35 S2 ACL 判定）', () => {
  it('① 租户优先：A 租户文档对 B 租户**不可见**（即使 B 有同名 ACL 行）', async () => {
    const doc = docOf({ tenantId: 't1' });
    // 关键：ACL 行挂在**文档所属租户 t1**、主体正是 B 上下文（u-b）
    // ⇒ 若去掉"租户优先"判定，本例会命中该 ACL 变成 admin ⇒ **反测真正承重**
    const acl = aclOf('1', 'user', 'u-b', 'admin'); // tenantId 缺省 = 't1'
    const { svc } = createService([doc], [acl]);

    const access = await svc.resolve(
      doc,
      ctxOf('t2', { type: 'user', id: 'u-b' }),
    );

    expect(access).toBe('none');
    // mutation 检验点：去掉租户判定（doc.tenantId !== ctx.tenantId 分支）⇒ 本条会变成 admin ⇒ 红
    expect(access).not.toBe('admin');
  });

  it('② ACL 默认拒绝：无 ACL 行且非 owner ⇒ none；owner ⇒ admin', async () => {
    const doc = docOf({ owner: 'u-owner' });
    const { svc } = createService([doc], []);

    expect(await svc.resolve(doc, ctxOf('t1', USER_A))).toBe('none');
    expect(
      await svc.resolve(doc, ctxOf('t1', { type: 'user', id: 'u-owner' })),
    ).toBe('admin');
  });

  it('③ ACL 梯度：命中 read ⇒ read；再给 write ⇒ write（取最高）；admin ⇒ admin', async () => {
    const doc = docOf();
    const { svc } = createService(
      [doc],
      [
        aclOf('1', 'user', 'u-a', 'read'),
        aclOf('1', 'role', 'r-ops', 'write'),
        aclOf('1', 'employee', 'e-1', 'admin'),
      ],
    );

    expect(await svc.resolve(doc, ctxOf('t1', USER_A))).toBe('read');
    expect(
      await svc.resolve(
        doc,
        ctxOf('t1', { type: 'user', id: 'u-a', roles: ['r-ops'] }),
      ),
    ).toBe('write');
    expect(
      await svc.resolve(doc, ctxOf('t1', { type: 'employee', id: 'e-1' })),
    ).toBe('admin');
  });

  it('④ 数字员工（employee）同为 principal：employee 行命中即生效', async () => {
    const doc = docOf();
    const { svc } = createService(
      [doc],
      [aclOf('1', 'employee', 'emp-9', 'write')],
    );

    expect(
      await svc.resolve(doc, ctxOf('t1', { type: 'employee', id: 'emp-9' })),
    ).toBe('write');
    expect(
      await svc.resolve(
        doc,
        ctxOf('t1', { type: 'employee', id: 'emp-other' }),
      ),
    ).toBe('none');
  });

  it('⑤ 主体类型必须匹配：user id 与 role id 同名不得误命中', async () => {
    const doc = docOf();
    const { svc } = createService(
      [doc],
      [aclOf('1', 'role', 'same-id', 'admin')],
    );

    // 以 user 身份用同名 id ⇒ 不命中
    expect(
      await svc.resolve(doc, ctxOf('t1', { type: 'user', id: 'same-id' })),
    ).toBe('none');
    // 以 role 身份命中
    expect(
      await svc.resolve(doc, ctxOf('t1', { type: 'role', id: 'same-id' })),
    ).toBe('admin');
  });

  it('⑥ archived：可读但不可写（canWrite 恒 false）', async () => {
    const doc = docOf({ status: 'archived', owner: 'u-owner' });
    const { svc } = createService([doc], []);
    const owner = ctxOf('t1', { type: 'user', id: 'u-owner' });

    expect(await svc.canRead(doc, owner)).toBe(true);
    expect(await svc.canWrite(doc, owner)).toBe(false);
    expect(await svc.canAdmin(doc, owner)).toBe(true);
  });

  it('⑦ 平台身份：跨租户 admin 兜底', async () => {
    const doc = docOf({ tenantId: 't9' });
    const { svc } = createService([doc], []);

    expect(
      await svc.resolve(
        doc,
        ctxOf('t1', { type: 'user', id: 'ops', isPlatform: true }),
      ),
    ).toBe('admin');
  });

  it('⑧ listVisible：只返回本租户 + ACL 可见的文档（租户 + ACL 双重过滤）', async () => {
    const mine = docOf({ id: '1', tenantId: 't1', owner: 'u-owner' });
    const shared = docOf({ id: '2', tenantId: 't1', owner: 'u-x' });
    const otherTenant = docOf({ id: '3', tenantId: 't2', owner: 'u-a' });
    const { svc } = createService(
      [mine, shared, otherTenant],
      [aclOf('2', 'user', 'u-a', 'read')],
    );

    const visible = await svc.listVisible(ctxOf('t1', USER_A), {});

    expect(visible.map((d) => d.id).sort()).toEqual(['2']);
    // mutation 检验点：去掉 tenant 条件 ⇒ 会多出 '3'（跨租户泄漏）⇒ 红；
    //                    去掉 ACL 过滤 ⇒ 会多出 '1' 等 ⇒ 红
    expect(visible.some((d) => d.id === '3')).toBe(false);
  });

  it('⑨ getVisible：无权时返回 doc=null（不泄露"存在但无权"）', async () => {
    const doc = docOf({ id: '7', owner: 'u-owner' });
    const { svc } = createService([doc], []);

    const denied = await svc.getVisible('7', ctxOf('t1', USER_A));
    expect(denied.doc).toBeNull();
    expect(denied.access).toBe('none');

    const allowed = await svc.getVisible(
      '7',
      ctxOf('t1', { type: 'user', id: 'u-owner' }),
    );
    expect(allowed.doc?.id).toBe('7');
    expect(allowed.access).toBe('admin');
  });
});
