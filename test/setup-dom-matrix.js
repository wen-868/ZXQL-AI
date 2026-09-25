/**
 * Jest 测试环境预置：DOMMatrix polyfill
 *
 * 背景：`pdf-parse@2.x` 间接依赖 `pdfjs-dist`，后者在模块顶层使用浏览器 API `DOMMatrix`。
 * 在 `testEnvironment: node` 下该全局不存在，导致 rag/document-loader 相关的 3 个测试套件
 * 加载即失败（ReferenceError: DOMMatrix is not defined）。
 *
 * 本 polyfill 仅提供模块加载与单测所需的最小矩阵语义（单测不解析真实 PDF，
 * 不做像素级矩阵运算），避免为此引入 jsdom 环境。
 *
 * 负责人: 苏然（测试） | 创建日期: 2026-09-26
 */
/* eslint-disable */
if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrixPolyfill {
    constructor(init) {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
      this.m11 = 1;
      this.m12 = 0;
      this.m21 = 0;
      this.m22 = 1;
      this.m41 = 0;
      this.m42 = 0;
      this.is2D = true;
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init.slice(0, 6);
        [this.m11, this.m12, this.m21, this.m22, this.m41, this.m42] =
          init.slice(0, 6);
      } else if (typeof init === 'string') {
        const nums = init
          .replace(/matrix\(|matrix3d\(|\)/g, '')
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => !Number.isNaN(n));
        if (nums.length >= 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = nums.slice(0, 6);
        }
      }
    }

    static fromMatrix(other) {
      const m = new DOMMatrixPolyfill();
      if (other) {
        m.a = other.a ?? m.a;
        m.b = other.b ?? m.b;
        m.c = other.c ?? m.c;
        m.d = other.d ?? m.d;
        m.e = other.e ?? m.e;
        m.f = other.f ?? m.f;
      }
      return m;
    }

    scale() {
      return this;
    }
    translate() {
      return this;
    }
    rotate() {
      return this;
    }
    multiply() {
      return this;
    }
    inverse() {
      return this;
    }
    transformPoint(point) {
      return point;
    }
    toFloat32Array() {
      return Float32Array.from([this.a, this.b, this.c, this.d, this.e, this.f]);
    }
    toFloat64Array() {
      return Float64Array.from([this.a, this.b, this.c, this.d, this.e, this.f]);
    }
    toString() {
      return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
    }
  }

  globalThis.DOMMatrix = DOMMatrixPolyfill;
}
