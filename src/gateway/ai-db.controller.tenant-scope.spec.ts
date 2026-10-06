/**
 * AiDbController 租户口径测试（2026-10-04）
 *
 * 背景：管理路由不在 TenantMiddleware 覆盖内（tenant.module.ts 只注册
 * chat / ai/agent / ai/v2 / ai/employees），故本控制器此前用
 * `TenantContext.getData()?.tenantId ?? 'default'` —— **真实租户永远取不到**，
 * E4 训练/看板/导出对真实租户全部失效，且所有租户共用一份 'default' 样本池互相污染。
 * 现改为从 AdminGuard 挂载的 JWT 身份解析（见 admin-tenant-scope.ts）。
 *
 * 本文件用最小 harness（Object.create 原型 + 挂依赖）直接调控制器方法，
 * 避开整个 Nest 容器与数据库，专注验证"租户到底传了什么给服务层"。
 */
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { AiDbController } from './ai-db.controller';

/** 带身份的伪请求 */
const reqWith = (identity: unknown): Request =>
  ({ adminIdentity: identity }) as unknown as Request;

const merchant = (tenantId: string) => ({
  identityType: 'merchant' as const,
  tenantId,
  userId: 1,
  username: 'boss',
});

const platform = () => ({
  identityType: 'platform' as const,
  userId: 9,
  username: 'ops',
});

/** 记录服务层实际收到的调用参数 */
function makeController() {
  const calls = {
    train: [] as Array<Record<string, unknown>>,
    readiness: [] as string[],
    dataset: [] as Array<unknown[]>,
    listSamples: [] as Array<unknown>,
    captureCorrection: [] as Array<Record<string, unknown>>,
    runAutoClosure: [] as number[],
  };

  const ctx = {
    getData: () => undefined, // 管理路由下恒为空 —— 模拟生产真实情况
    run: (_data: unknown, fn: () => unknown) => fn(),
  };

  const controller = Object.create(AiDbController.prototype) as AiDbController;
  Object.assign(controller, {
    capture: {
      listSamples: (t?: string, _l?: number) => {
        calls.listSamples.push(t);
        return Promise.resolve([]);
      },
      captureCorrection: (p: Record<string, unknown>) => {
        calls.captureCorrection.push(p);
        return Promise.resolve({});
      },
    },
    e4: {
      train: (_t: string, opts: Record<string, unknown>) => {
        calls.train.push(opts);
        return Promise.resolve({});
      },
      readiness: (t: string) => {
        calls.readiness.push(t);
        return Promise.resolve({});
      },
      exportDataset: (...args: unknown[]) => {
        calls.dataset.push(args);
        return Promise.resolve([]);
      },
    },
    versions: {
      runAutoClosure: (id: number) => {
        calls.runAutoClosure.push(id);
        return Promise.resolve({});
      },
    },
    tenantContext: ctx,
  });
  return { controller, calls };
}

describe('AiDbController 租户口径', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  describe('e4/train', () => {
    it('商户身份 → 训练样本锁定本租户（修复点：此前恒为 default）', async () => {
      const { controller, calls } = makeController();
      await controller.e4Train(reqWith(merchant('t_real')), {
        taskType: 'order',
      });
      // 反测信号：若仍走 getData()??'default'，这里会是 'default'
      expect(calls.train[0].tenantId).toBe('t_real');
    });

    it('平台身份未指定租户 → 400（不接受缺省，避免训练错租户数据）', async () => {
      const { controller } = makeController();
      await expect(
        controller.e4Train(reqWith(platform()), { taskType: 'order' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('平台身份显式指定租户 → 按指定租户训练（P1 回归：三端点此前无传租户通道致平台恒 400 死锁）', async () => {
      const { controller, calls } = makeController();
      await controller.e4Train(reqWith(platform()), {
        taskType: 'order',
        tenantId: 't_target',
      });
      expect(calls.train[0].tenantId).toBe('t_target');
    });
  });

  describe('e4/readiness', () => {
    it('商户身份 → 看板锁定本租户', () => {
      const { controller, calls } = makeController();
      void controller.e4Readiness(reqWith(merchant('t_real')));
      expect(calls.readiness[0]).toBe('t_real');
    });

    it('平台身份未指定 → 400（看板不得静默落到 default）', () => {
      const { controller } = makeController();
      expect(() => controller.e4Readiness(reqWith(platform()))).toThrow(
        BadRequestException,
      );
    });

    it('平台身份显式指定 → 按指定租户出看板', () => {
      const { controller, calls } = makeController();
      void controller.e4Readiness(reqWith(platform()), 't_target');
      expect(calls.readiness[0]).toBe('t_target');
    });
  });

  describe('e4/dataset', () => {
    it('商户身份 → 导出锁定本租户', () => {
      const { controller, calls } = makeController();
      void controller.e4Dataset(reqWith(merchant('t_real')), 'order', '10');
      expect(calls.dataset[0][2]).toBe('t_real');
    });

    it('平台身份显式指定 → 按指定租户导出（P1 回归）', () => {
      const { controller, calls } = makeController();
      void controller.e4Dataset(reqWith(platform()), 'order', '10', 't_target');
      expect(calls.dataset[0][2]).toBe('t_target');
    });
  });

  describe('samples 列表（报告未列的同型问题）', () => {
    it('商户不传租户 → 仍锁本租户，不返回全部租户', () => {
      const { controller, calls } = makeController();
      void controller.listSamples(reqWith(merchant('t_a')));
      // 反测信号：若直接透传查询参数，这里会是 undefined（= 查全部租户）
      expect(calls.listSamples[0]).toBe('t_a');
    });

    it('商户传他人租户 → 403', () => {
      const { controller } = makeController();
      expect(
        () => void controller.listSamples(reqWith(merchant('t_a')), 't_b'),
      ).toThrow(ForbiddenException);
    });

    it('平台不传 → undefined 表示查全部（跨租户运维保留）', () => {
      const { controller, calls } = makeController();
      void controller.listSamples(reqWith(platform()));
      expect(calls.listSamples[0]).toBeUndefined();
    });
  });

  describe('createCorrection（报告未列的同型问题）', () => {
    it('商户自报他人租户 → 403（此前可污染他人样本池）', () => {
      const { controller } = makeController();
      expect(
        () =>
          void controller.createCorrection(reqWith(merchant('t_a')), {
            tenantId: 't_b',
            taskType: 'order',
          }),
      ).toThrow(ForbiddenException);
    });

    it('商户传自己租户 → 正常写入', () => {
      const { controller, calls } = makeController();
      void controller.createCorrection(reqWith(merchant('t_a')), {
        tenantId: 't_a',
        taskType: 'order',
      });
      expect(calls.captureCorrection[0].tenantId).toBe('t_a');
    });
  });

  describe('E5 auto-close', () => {
    it('商户身份 → 评测在本租户上下文执行', async () => {
      const { controller, calls } = makeController();
      await controller.autoCloseVersion(reqWith(merchant('t_real')), 1, {});
      expect(calls.runAutoClosure).toContain(1);
    });

    it('平台身份未指定租户 → 400（评测结论不得基于错误租户的配置）', async () => {
      const { controller } = makeController();
      await expect(
        controller.autoCloseVersion(reqWith(platform()), 1, {}),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
