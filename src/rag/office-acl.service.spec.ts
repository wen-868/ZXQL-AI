/**
 * OfficeAclService 测试（R101-AI-37 步骤 2 泛化后）
 *
 * **契约演进留痕**：资源从「doc」泛化为「{resourceType, resourceId}」；
 * 判定逻辑**未复制** —— 文档域只是薄适配（docToResource + archived 域规则），
 * 通用核心 resolveResource 由 doc 与 todo（及后续 approval/schedule）**共用**。
 *
 * 本文件由 doc-acl.service.spec.ts 改名而来（原 9 例语义不变），新增：
 * - ⑩ 通用资源：resourceType 隔离（todo#5 与 doc#5 授权互不串用）
 * - ⑪ **租户守卫 mutation 用例**：把 ctx.tenantId 换成 resource.tenantId（自比恒真）
 *      ⇒ 本例必须红（语义空转只有反测能兜住，lint 抓不到）
 */
import {
  AiAclEntity,
  AclPerm,
  AclPrincipalType,
} from '../database/entities/ai-acl.entity';
import { AiDocEntity } from '../database/entities/ai-doc.entity';
import {
  OfficeAclContext,
  OfficeAclService,
  OfficePrincipal,
} from './office-acl.service';

function docOf(over: Partial<AiDocEntity> = {}): AiDocEntity {
  return {
    id: '1',
    tenantId: 't1',
    title: '合同A',
    category: 'contract',
    tags: null,
    ragStatus: 'pending',
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
  type: AclPrincipalType,
  id: string,
  perm: AclPerm,
  tenantId = 't1',
): AiAclEntity {
  return {
    id: `${docId}-${type}-${id}`,
    tenantId,
    resourceType: 'doc',
    resourceId: docId,
    principalType: type,
    principalId: id,
    perm,
    createdAt: new Date(),
  };
}

/** 轻量仓储桩：按 where 的 tenantId / docId / principalId In(...) 过滤 */
function createService(docs: AiDocEntity[], acls: AiAclEntity[]) {
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
          // 桩语义：**只在 where 提供了该键时**才比较（未提供 = 不参与过滤）
          // —— ACL 实体演进（resource_type/resource_id）后，硬比较会因键缺失而误判为"无行"
          const eq = (k: string): boolean => {
            const expected = where[k];
            // 只对**原始值**比较；FindOperator 之类的包装（如 principalId: In([])）走专项分支
            if (typeof expected !== 'string' && typeof expected !== 'number') {
              return true;
            }
            const actual = (a as unknown as Record<string, unknown>)[k];
            return String(actual) === String(expected);
          };
          return (
            eq('resourceId') &&
            eq('resourceType') &&
            eq('tenantId') &&
            (ids ? ids.includes(a.principalId) : true)
          );
        }),
      ),
    ),
  };
  // R101-AI-37 步骤 2 契约演进：OfficeAclService(aclRepo, docRepo) —— 注意**顺序**：
  // 通用 ACL 仓储在前（判定核心用），文档仓储在后（仅文档域包装用）
  const svc = new OfficeAclService(aclRepo as never, docRepo as never);
  return { svc, docRepo, aclRepo };
}

const USER_A: OfficePrincipal = { type: 'user', id: 'u-a' };
const ctxOf = (
  tenantId: string,
  principal: OfficePrincipal = USER_A,
): OfficeAclContext => ({ tenantId, principal });

describe('OfficeAclService（R101-AI-35 S2 ACL 判定）', () => {
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

  // ══════ R101-AI-37 步骤 2 新增：通用资源泛化 + 租户守卫 mutation 用例 ══════
  it('⑩ 通用资源：resourceType 隔离 —— todo#5 与 doc#5 授权互不串用', async () => {
    const doc = docOf({ id: '5', owner: 'u-owner' });
    // 同一 resourceId=5，两种资源类型、两种 perm
    const docAcl = aclOf('5', 'user', 'u-a', 'write'); // resourceType='doc'
    const todoAcl = {
      id: 'todo-5-user-u-a',
      tenantId: 't1',
      resourceType: 'todo',
      resourceId: '5',
      principalType: 'user',
      principalId: 'u-a',
      perm: 'read',
      createdAt: new Date(),
    } as unknown as AiAclEntity;
    const { svc } = createService([doc], [docAcl, todoAcl]);

    // todo#5 ⇒ 只认 todo 行（read）
    expect(
      await svc.resolveResource(
        { resourceType: 'todo', resourceId: '5', tenantId: 't1', owner: null },
        ctxOf('t1', USER_A),
      ),
    ).toBe('read');
    // doc#5 ⇒ 只认 doc 行（write）
    expect(
      await svc.resolveResource(
        { resourceType: 'doc', resourceId: '5', tenantId: 't1', owner: null },
        ctxOf('t1', USER_A),
      ),
    ).toBe('write');
    // mutation 检验点：忽略 resourceType（只按 resourceId 查）⇒ 两处都会取 max='write' ⇒ 本例红
  });

  it('⑪ 🔴 租户守卫：ACL 行在本租户、但**调用方租户不同** ⇒ none（自比恒真会红）', async () => {
    const doc = docOf({ id: '5', owner: 'u-owner' });
    const todoAcl = {
      id: 'todo-5-user-u-a',
      tenantId: 't1',
      resourceType: 'todo',
      resourceId: '5',
      principalType: 'user',
      principalId: 'u-a',
      perm: 'read',
      createdAt: new Date(),
    } as unknown as AiAclEntity;
    const { svc } = createService([doc], [todoAcl]);

    // resource.tenantId='t1'，ACL 行也在 't1'，**唯一差异是 ctx.tenantId='t2'**
    // ⇒ 只有"与调用方租户比较"才判 none；
    //   若把比较写成 resource.tenantId !== resource.tenantId（自比恒真）⇒ 会返回 'read' ⇒ 本例红
    expect(
      await svc.resolveResource(
        { resourceType: 'todo', resourceId: '5', tenantId: 't1', owner: null },
        ctxOf('t2', USER_A),
      ),
    ).toBe('none');

    // 对照：同租户 ⇒ read（证明差异确实来自 ctx.tenantId）
    expect(
      await svc.resolveResource(
        { resourceType: 'todo', resourceId: '5', tenantId: 't1', owner: null },
        ctxOf('t1', USER_A),
      ),
    ).toBe('read');
  });

  it('⑫ filterVisible 直测：按 resourceType 过滤（忽略类型 ⇒ 本例红）', async () => {
    // 三个资源：todo#5 / todo#6 / doc#5；ACL 只给 todo#5 与 **doc#6**
    // ⇒ 若忽略 resourceType，doc#6 的行会命中 todo#6 ⇒ 输出出现 todo:6 ⇒ 本例红
    const resources = [
      {
        resourceType: 'todo' as const,
        resourceId: '5',
        tenantId: 't1',
        owner: null,
      },
      {
        resourceType: 'todo' as const,
        resourceId: '6',
        tenantId: 't1',
        owner: null,
      },
      {
        resourceType: 'doc' as const,
        resourceId: '5',
        tenantId: 't1',
        owner: null,
      },
    ];
    const acls = [
      {
        id: 'todo-5',
        tenantId: 't1',
        resourceType: 'todo',
        resourceId: '5',
        principalType: 'user',
        principalId: 'u-a',
        perm: 'read',
        createdAt: new Date(),
      },
      {
        id: 'doc-6',
        tenantId: 't1',
        resourceType: 'doc',
        resourceId: '6',
        principalType: 'user',
        principalId: 'u-a',
        perm: 'read',
        createdAt: new Date(),
      },
    ] as unknown as AiAclEntity[];
    const { svc } = createService([], acls);

    const out = await svc.filterVisible(
      resources,
      (r) => r,
      ctxOf('t1', USER_A),
    );

    expect(out.map((r) => r.resourceType + ':' + r.resourceId)).toEqual([
      'todo:5',
    ]);
  });
});
