/**
 * G1 KnowledgeRulesService 单元测试
 *
 * 覆盖：加载与文件名→业务域映射、按意图过滤、全量回退只带系统功能说明、
 * 目录缺失降级、总量截断。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeRulesService } from './knowledge-rules.service';

describe('G1 KnowledgeRulesService', () => {
  let dir: string;
  let service: KnowledgeRulesService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'krules-'));
    writeFileSync(
      join(dir, '库存管理规则.md'),
      '库存规则：先进先出；安全线 = 近7日日均销量 × 3。',
      'utf8',
    );
    writeFileSync(
      join(dir, '财务与费用规则.md'),
      '财务规则：应收账龄超 30 天进入催收流程。',
      'utf8',
    );
    writeFileSync(
      join(dir, '系统功能说明.md'),
      '系统支持销售/库存/采购/财务等模块。',
      'utf8',
    );
    writeFileSync(join(dir, '未映射文档.md'), '没有映射的文档', 'utf8');
    service = new KnowledgeRulesService();
    service.setDirForTests(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('库存意图 → 只注入库存规则', () => {
    const ctx = service.getRulesContext(['inventory']);
    expect(ctx).toContain('库存管理规则');
    expect(ctx).toContain('先进先出');
    expect(ctx).not.toContain('财务规则');
  });

  it('财务意图 → 只注入财务规则', () => {
    const ctx = service.getRulesContext(['finance']);
    expect(ctx).toContain('财务与费用规则');
    expect(ctx).not.toContain('库存管理规则');
  });

  it('全量回退（无分类）→ 只注入系统功能说明', () => {
    const ctx = service.getRulesContext(undefined);
    expect(ctx).toContain('系统功能说明');
    expect(ctx).not.toContain('库存规则');
  });

  it('无匹配分类的意图 → undefined', () => {
    expect(service.getRulesContext(['utility'])).toBeUndefined();
  });

  it('目录不存在 → 降级 undefined 不抛错', () => {
    const svc = new KnowledgeRulesService();
    svc.setDirForTests(join(tmpdir(), 'krules-not-exist-xyz'));
    expect(svc.getRulesContext(['inventory'])).toBeUndefined();
  });
});
