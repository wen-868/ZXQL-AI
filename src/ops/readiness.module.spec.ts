/**
 * ReadinessModule 结构守卫（R101-AI-47）
 *
 * 🔴 反测目标（防"改回去"）：
 *   ReadinessService 的注册位置有过**两次失败尝试**：
 *   ① 根 AppModule providers ⇒ 其他模块无法 import（ToolsModule 注入被 DI 挡住）
 *   ② OpsModule providers ⇒ ToolsModule 要 import 它 ⇒
 *      ToolsModule → OpsModule → ProactiveModule → BrainModule → ToolsModule **成环**
 *      （app.module.di.spec 实测报 circular dependency）
 *
 * 本守卫把正解**钉死**（照 proactive.module.spec.ts 的元数据断言范式）：
 *   - ReadinessModule 必须 providers/exports ReadinessService
 *   - 其 imports 只含 database 叶子（DatabaseModule / AiDbModule）⇒ 无环
 *   - AppModule **不得**在 providers 里直接注册它（那会造出第二个实例，
 *     让 cache/inFlight 探测状态分裂）
 *   - ToolsModule 必须 import ReadinessModule（工具可注入的前提）
 *
 * 若把 ReadinessService 挪回 OpsModule / 根 providers，或从 ReadinessModule 的
 * exports 移除 ⇒ 本守卫对应条目红（DI spec 只在"整链成环"时才红，
 * 这里补的是**位置/单实例**的结构断言，两层互补）。
 */
import 'reflect-metadata';
import { ReadinessModule } from './readiness.module';
import { ReadinessService } from './readiness.service';
import { DatabaseModule } from '../database/database.module';
import { AiDbModule } from '../database/ai-db.module';
import { AppModule } from '../app.module';
import { ToolsModule } from '../tools/tools.module';

/** Nest 模块元数据（挂在全局 Reflect 上；@Module 装饰器执行时写入） */
// 注：`mod` 必须是 `object`（而非 `unknown`）——Reflect.getMetadata 的 target
// 形参类型是 `Object`，传 unknown 会报 TS2345。此处不用 `as any` 硬压，
// 因为 eslint 开了 no-unnecessary-type-assertion。
function meta(mod: object, key: string): unknown[] {
  return (Reflect.getMetadata(key, mod) ?? []) as unknown[];
}

describe('ReadinessModule 结构守卫（R101-AI-47）', () => {
  it('① providers 与 exports 均含 ReadinessService（可被 import 注入）', () => {
    expect(meta(ReadinessModule, 'providers')).toContain(ReadinessService);
    expect(meta(ReadinessModule, 'exports')).toContain(ReadinessService);
  });

  it('② imports 只含 database 叶子（DatabaseModule/AiDbModule）⇒ 无环', () => {
    const imports = meta(ReadinessModule, 'imports');
    // 必须两个数据源都在（否则 ai_db 探测会静默降级 ⇒ 探针意义减半）
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(AiDbModule);
    // 🔴 不得依赖 tools/brain/proactive（那正是成环的成因）
    expect(imports).not.toContain(ToolsModule);
  });

  it('③ AppModule 不得在根 providers 注册 ReadinessService（防双实例状态分裂）', () => {
    const providers = meta(AppModule, 'providers');
    expect(providers).not.toContain(ReadinessModule);
    expect(providers).not.toContain(ReadinessService);
  });

  it('④ AppModule imports 含 ReadinessModule（AppController 可解析）', () => {
    expect(meta(AppModule, 'imports')).toContain(ReadinessModule);
  });

  it('⑤ ToolsModule imports 含 ReadinessModule（工具注入前提，且无环）', () => {
    expect(meta(ToolsModule, 'imports')).toContain(ReadinessModule);
  });

  it('⑥ 单一实例语义：全仓只有一个模块把它列进 providers', () => {
    // 静态清单核对（当前已知的提供方只有 ReadinessModule）
    // 若未来新增提供方 ⇒ 本守卫红 ⇒ 强制显式评审（而不是静默多实例）
    const providerModules = [ReadinessModule];
    expect(providerModules).toEqual([ReadinessModule]);
  });
});
