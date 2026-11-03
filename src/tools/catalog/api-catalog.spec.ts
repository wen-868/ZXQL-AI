/**
 * API 目录静态护栏（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01）
 *
 * 目录当前不得存在未获准的可执行写条目；全部条目必须能过 fail-closed 元数据校验；
 * dynamicWriteCapability 默认关闭（无条目声明）。未来添加写条目前必须先落地
 * preview/confirm 二段式与幂等契约——仅改目录不构成开放。
 */
import { API_CATALOG } from './api-catalog';
import { validateDynamicToolDef } from './dynamic-api.tool';

describe('API_CATALOG 静态护栏', () => {
  it('目录当前不得存在任何写条目（全部 isWriteOperation=false）', () => {
    const writes = API_CATALOG.filter((d) => d.isWriteOperation);
    expect(writes).toEqual([]);
  });

  it('全部条目通过 fail-closed 元数据校验（含空名称/非法方法/GET 写冲突检查）', () => {
    for (const def of API_CATALOG) {
      const verdict = validateDynamicToolDef(def);
      expect(`${def.name}: ${verdict.reason ?? ''}`).toBe(`${def.name}: `);
      expect(verdict.ok).toBe(true);
    }
  });

  it('名称唯一、api_ 前缀、非空描述', () => {
    const names = API_CATALOG.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of API_CATALOG) {
      expect(def.name).toMatch(/^api_/);
      expect(def.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('无条目声明 dynamicWriteCapability（写能力字段默认关闭的契约）', () => {
    const declared = API_CATALOG.filter((d) => d.dynamicWriteCapability);
    expect(declared).toEqual([]);
  });

  it('纯计算 POST（api_calculate_promotion）与 GET 查询（api_query_sale_bills）两类既有形态在册且可生成', () => {
    const names = new Set(API_CATALOG.map((d) => d.name));
    expect(names.has('api_calculate_promotion')).toBe(true);
    expect(names.has('api_query_sale_bills')).toBe(true);
    const calc = API_CATALOG.find((d) => d.name === 'api_calculate_promotion');
    expect(calc?.method).toBe('POST');
    expect(calc?.isWriteOperation).toBe(false);
  });
});
