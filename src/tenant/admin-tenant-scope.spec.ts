/**
 * AdminTenantScope 单元测试
 *
 * 背景：管理路由不在 TenantMiddleware 覆盖内，`ai-db.controller.ts` 此前用
 * `TenantContext.getData()?.tenantId ?? 'default'`，导致**真实租户永远取不到**
 * （一律 'default'，E4 训练/看板/导出对真实租户全部失效）。
 * 本模块把租户口径收敛为唯一实现，供 admin/ai-config/ai-db 三处共用。
 */
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  resolveAdminTenantId,
  resolveOptionalAdminTenantId,
} from './admin-tenant-scope';

/** 构造带有 AdminGuard 挂载身份的伪请求 */
const reqWith = (identity: unknown): Request =>
  ({ adminIdentity: identity }) as unknown as Request;

/** 商户身份（有 tenantId） */
const merchant = (tenantId: string, extra: Record<string, unknown> = {}) => ({
  identityType: 'merchant',
  tenantId,
  userId: 1,
  username: 'boss',
  ...extra,
});

/** 平台身份（跨租户，通常无 tenantId） */
const platform = (extra: Record<string, unknown> = {}) => ({
  identityType: 'platform',
  userId: 9,
  username: 'ops',
  ...extra,
});

describe('resolveAdminTenantId', () => {
  // 生产中 getAdminIdentity 缺失身份会打 403，此处仅静音其日志噪音
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  describe('商户身份：强制锁本租户', () => {
    it('不传租户 → 返回本租户（修复点：此前恒为 default）', () => {
      // 反测信号：若实现仍是 `getData()?.tenantId ?? 'default'`，这里会得到 'default'
      expect(resolveAdminTenantId(reqWith(merchant('t_real')))).toBe('t_real');
    });

    it('传自己租户 → 放行', () => {
      expect(resolveAdminTenantId(reqWith(merchant('t_a')), 't_a')).toBe('t_a');
    });

    it('传他人租户 → 403（不静默改写，避免难排查的数据错位）', () => {
      expect(() =>
        resolveAdminTenantId(reqWith(merchant('t_a')), 't_b'),
      ).toThrow(ForbiddenException);
    });

    it('越权报错信息带出被拒租户，便于运维定位', () => {
      try {
        resolveAdminTenantId(reqWith(merchant('t_a')), 't_b');
        throw new Error('应当抛出 403 但未抛');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const body = (err as ForbiddenException).getResponse() as {
          message?: string;
          detail?: string;
        };
        expect(JSON.stringify(body)).toContain('t_b');
      }
    });

    it('商户 JWT 缺 tenantId → 403（不放行到默认租户）', () => {
      expect(() =>
        resolveAdminTenantId(
          reqWith({ identityType: 'merchant', userId: 1, username: 'x' }),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('平台身份：跨租户运维但必须显式指定', () => {
    it('显式指定 → 返回指定租户', () => {
      expect(resolveAdminTenantId(reqWith(platform()), 't_b')).toBe('t_b');
    });

    it('未指定 → 400（关键：不得静默退化 default，正是本次事故根因）', () => {
      // 反测信号：若实现回退 'default'，这里不会抛错
      expect(() => resolveAdminTenantId(reqWith(platform()))).toThrow(
        BadRequestException,
      );
    });

    it('传空白字符串视同未指定（防绕过）', () => {
      expect(() => resolveAdminTenantId(reqWith(platform()), '   ')).toThrow(
        BadRequestException,
      );
    });

    it('平台身份即使自带 tenantId，未指定目标也要求显式指定', () => {
      expect(() =>
        resolveAdminTenantId(reqWith(platform({ tenantId: 't_own' }))),
      ).toThrow(BadRequestException);
    });
  });

  describe('无身份：拒绝执行', () => {
    it('未经守卫直调 → 403（防绕过 AdminGuard）', () => {
      expect(() =>
        resolveAdminTenantId({ headers: {} } as unknown as Request),
      ).toThrow(ForbiddenException);
    });
  });

  it('两端空格被裁剪（防止 " t_a " 绕过等值比较）', () => {
    expect(resolveAdminTenantId(reqWith(merchant('t_a')), ' t_a ')).toBe('t_a');
  });
});

describe('resolveOptionalAdminTenantId（看板类可选租户端点）', () => {
  it('商户不传 → 返回本租户', () => {
    expect(resolveOptionalAdminTenantId(reqWith(merchant('t_a')))).toBe('t_a');
  });

  it('商户传他人 → 403', () => {
    expect(() =>
      resolveOptionalAdminTenantId(reqWith(merchant('t_a')), 't_b'),
    ).toThrow(ForbiddenException);
  });

  it('平台不传 → undefined 表示"查全部"，绝不映射为 default', () => {
    // 反测信号：若返回 'default'，会把"查全部"变成"只查 default 租户"
    expect(resolveOptionalAdminTenantId(reqWith(platform()))).toBeUndefined();
  });

  it('平台指定 → 返回指定租户', () => {
    expect(resolveOptionalAdminTenantId(reqWith(platform()), 't_c')).toBe(
      't_c',
    );
  });
});
