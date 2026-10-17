/**
 * guard-tools-wiring —— 工具注册表接线守卫（R101-AI-44 P0 防复发）
 *
 * 🔴 起因（生产事故，2026-10-17 MS 线实证）：
 *   办公 27 个 `Ai*Tool` + `ForecastSales/AnalyzePriceTrend/CancelSalesOrder/GetSystemStatus`
 *   在 `tools.module.ts`（Nest DI 容器）注册了，却**从未**在 `tool-bootstrap.ts` 的
 *   `registry.registerAll([...])`（执行器注册表）登记 ⇒ 生产直调全部"未注册"，
 *   而 182 套件/1898 用例全绿 —— 因为没有任何断言把"定义文件"与"注册数组"绑在一起。
 *
 * 守卫形态（照 MS 仓 `guard-rbac-wiring.mjs` 的静态比对思路）：
 *   - **A 面**：`src/tools/definitions/*.tool.ts` 枚举出的 ITool 实现类（kebab→Pascal+Tool）
 *   - **B 面**：`tool-bootstrap.ts` 中 `registry.registerAll([...])` 数组内的
 *     `this.xxxTool` 条目（camelCase）反推回 Pascal 类名
 *   - 双向断言：A − B = 空（漏注册必红）；B − A ⊆ 豁免表
 *
 * 豁免表（每条必须有注释依据，不允许静默豁免）：
 *   - EchoTool：2026-09-05 刻意移除（tool-bootstrap.ts 注释"不再进入生产注册表与工具数口径"）
 *
 * 负责人: 阿澈（代笔凌舟，因阿洲执行通道失效）｜创建日期: 2026-10-17
 */
import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const BOOTSTRAP = join(__dirname, 'tool-bootstrap.ts');
const DEFS_DIR = join(__dirname, 'definitions');

/** kebab-case 文件名 → PascalCase 类名（与既有命名约定一致：x.tool.ts → XTool） */
function fileNameToClassName(file: string): string {
  const base = basename(file).replace(/\.tool\.ts$/, '');
  const pascal = base
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('');
  return pascal + 'Tool';
}

/** camelCase 实例字段名 → PascalCase 类名：**从 bootstrap 的构造注入声明解析**，不靠命名约定反推
 *  （反例：`this.dispatchTool` ↔ `DispatchEmployeeTaskTool`，机械映射会得出错误的 `DispatchToolTool`） */
function buildInstanceToClassMap(bootstrapSrc: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /private\s+readonly\s+(\w+Tool)\s*:\s*(\w+Tool)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bootstrapSrc))) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** 刻意豁免（不进执行器注册表）的具名清单 —— 每条必须写明依据 */
const EXEMPT_CLASS_NAMES = new Set<string>([
  // 2026-09-05：移除 echo 测试工具，"不再进入生产注册表与工具数口径"（tool-bootstrap.ts 注释原文）
  'EchoTool',
]);

describe('guard-tools-wiring：definitions/*.tool.ts 与执行器注册表必须一致（R101-AI-44）', () => {
  let definedClasses: string[];
  let registeredClasses: string[];

  beforeAll(() => {
    // ── A 面：definitions 目录枚举 ──
    const files = readdirSync(DEFS_DIR).filter(
      (f) => f.endsWith('.tool.ts') && !f.endsWith('.spec.ts'),
    );
    definedClasses = files.map(fileNameToClassName).sort();

    // ── B 面：bootstrap 源码里的 registerAll 条目 ──
    const src = readFileSync(BOOTSTRAP, 'utf8');
    const m = src.match(/this\.registry\.registerAll\(\[([\s\S]*?)\]\);/);
    if (!m) throw new Error('tool-bootstrap.ts 中找不到 registerAll 数组');
    const arr = m[1];
    const instances = [...arr.matchAll(/this\.(\w+Tool)\b/g)].map((x) => x[1]);
    // 实例字段名 → 类名：用构造注入声明的真实映射（不靠命名约定）
    const inst2cls = buildInstanceToClassMap(src);
    const unmapped = instances.filter((i) => !inst2cls.has(i));
    if (unmapped.length) {
      throw new Error(
        `registerAll 条目在构造注入中找不到对应声明: ${unmapped.join(', ')}`,
      );
    }
    registeredClasses = [
      ...new Set(instances.map((i) => inst2cls.get(i)!)),
    ].sort();
  });

  it('A − B = 0：definitions 里每个工具类都已进 registerAll（漏注册 ⇒ 本守卫红）', () => {
    const missing = definedClasses.filter(
      (c) => !registeredClasses.includes(c) && !EXEMPT_CLASS_NAMES.has(c),
    );
    expect(missing).toEqual([]);
  });

  it('B − A ⊆ 豁免表：registerAll 里不存在"凭空注册"的类', () => {
    const extra = registeredClasses.filter((c) => !definedClasses.includes(c));
    const unknownExtra = extra.filter((c) => !EXEMPT_CLASS_NAMES.has(c));
    // 空数组即通过；若出现"凭空注册"（有 registerAll 条目但无定义文件）⇒ 红
    expect(unknownExtra).toEqual([]);
  });

  it('豁免表不得为空转：豁免类必须真实存在于 definitions（否则豁免是死配置）', () => {
    const exemptButMissing = [...EXEMPT_CLASS_NAMES].filter(
      (c) => !definedClasses.includes(c),
    );
    expect(exemptButMissing).toEqual([]);
  });

  it('注册数量守恒：registerAll 条目数 == definitions − 豁免 + 动态工具位（ToolGenerator 由它自己注册，不占静态数组）', () => {
    // 静态条目（registerAll 数组）与 definitions 的关系必须精确：
    //   definitions 总数 == 注册数 + 豁免数
    // （ToolGeneratorService 的 api_* 动态工具在 registerAll 之外单独 generateAndRegister，不进本守卫口径）
    const exempted = definedClasses.filter((c) => EXEMPT_CLASS_NAMES.has(c));
    expect(definedClasses.length).toBe(
      registeredClasses.length + exempted.length,
    );
  });
});
