/* eslint-disable @typescript-eslint/unbound-method -- 断言需直接引用 mock 方法（toHaveBeenCalled/not.toHaveBeenCalled） */
/**
 * P0-1 反测用例：外部模型平台级端点必须校验「平台身份」
 *
 * 目标行为（规格）：
 * - 商家 4 类管理角色（AdminGuard 放行：SUPER_ADMIN / OPERATION_ADMIN /
 *   WAREHOUSE_ADMIN / FINANCE_ADMIN）调用平台级外部模型**写端点**
 *   （create / update / remove / test / testById）必须 403，且不得触达 service。
 * - 平台（总台）身份调用同一批端点必须放行。
 * - 匿名（无 Bearer JWT）仍为 401（守卫未被摘掉）。
 *
 * 反测方向：「修复不存在」时本文件必须红——商家身份会拿到 201/200 并触达
 * ExternalModelService（平台级外部模型库可被任意租户管理员改写/取走密钥）。
 *
 * 取证方式：走真实 HTTP 层（真实 AdminGuard + 真实 ExternalModelController，
 * 仅 ExternalModelService 用 mock），因此不耦合控制器方法签名，
 * 对「控制器内联 requirePlatformIdentity」与「新增平台守卫类」两种修复形态均成立。
 * 未断言 list/options（读侧口径由 task-1 决定，本卡不擅自放宽写侧）。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-09
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { ExternalModelService } from '../tenant/external-model.service';
import { ExternalModelController } from './external-model.controller';

/** 测试专用 JWT 签名密钥（不读 .env，避免污染真实部署配置） */
const TEST_JWT_SECRET = 'p0-1-external-model-scope-spec-secret';

/** 平台级外部模型端点基址（测试模块无全局前缀） */
const BASE = '/admin/ai-config/external-models';

/** 商家 JWT：AdminGuard 放行的管理角色（tenantId=tenant-a） */
function merchantToken(): string {
  return jwt.sign(
    {
      id: 1001,
      username: 'merchant-super-admin',
      tenantId: 'tenant-a',
      roles: ['SUPER_ADMIN'],
    },
    TEST_JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: 'zhixiang-system',
      audience: 'zhixiang-client',
      expiresIn: '1h',
    },
  );
}

/** 平台（总台 saas-admin）JWT */
function platformToken(): string {
  return jwt.sign({ id: 9, username: 'platform-admin' }, TEST_JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'zhixiang-platform',
    audience: 'zhixiang-platform-client',
    expiresIn: '1h',
  });
}

function createServiceMock(): jest.Mocked<ExternalModelService> {
  return {
    list: jest.fn().mockResolvedValue([]),
    options: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 1 }),
    update: jest.fn().mockResolvedValue({ id: 1 }),
    remove: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn().mockResolvedValue({ success: true }),
    testById: jest.fn().mockResolvedValue({ success: true }),
  } as unknown as jest.Mocked<ExternalModelService>;
}

describe('P0-1 ExternalModelController 平台级端点身份收口', () => {
  let app: INestApplication;
  let service: jest.Mocked<ExternalModelService>;
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    service = createServiceMock();
    const moduleRef = await Test.createTestingModule({
      controllers: [ExternalModelController],
      providers: [
        AdminGuard,
        { provide: ExternalModelService, useValue: service },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** 以指定身份发起写请求，返回 HTTP 状态码 */
  async function send(
    method: 'post' | 'put' | 'delete',
    path: string,
    token?: string,
  ): Promise<number> {
    const server = app.getHttpServer() as Server;
    let req = request(server)[method](path);
    if (token) {
      req = req.set('Authorization', `Bearer ${token}`);
    }
    const res = await req.send({});
    return res.status;
  }

  describe('商家身份 → 平台级写端点必须 403', () => {
    it('POST /（新增外部模型）→ 403，不触达 service', async () => {
      const status = await send('post', BASE, merchantToken());
      expect(status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('PUT /:id（修改外部模型）→ 403，不触达 service', async () => {
      const status = await send('put', `${BASE}/7`, merchantToken());
      expect(status).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('DELETE /:id（删除外部模型）→ 403，不触达 service', async () => {
      const status = await send('delete', `${BASE}/7`, merchantToken());
      expect(status).toBe(403);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('POST /test（明文连通性测试）→ 403，不触达 service', async () => {
      const status = await send('post', `${BASE}/test`, merchantToken());
      expect(status).toBe(403);
      expect(service.testConnection).not.toHaveBeenCalled();
    });

    it('POST /test/:id（解密已存密钥测试）→ 403，不触达 service', async () => {
      const status = await send('post', `${BASE}/test/7`, merchantToken());
      expect(status).toBe(403);
      expect(service.testById).not.toHaveBeenCalled();
    });
  });

  describe('平台身份 → 放行（修复不得过度拦截）', () => {
    it('POST /（新增外部模型）放行并委托 service.create', async () => {
      const status = await send('post', BASE, platformToken());
      expect(status).toBe(201);
      expect(service.create).toHaveBeenCalledTimes(1);
    });

    it('DELETE /:id（删除外部模型）放行并委托 service.remove(7)', async () => {
      const status = await send('delete', `${BASE}/7`, platformToken());
      expect(status).toBe(200);
      expect(service.remove).toHaveBeenCalledWith(7);
    });
  });

  describe('匿名 → 守卫仍然生效', () => {
    it('POST /（无 Bearer JWT）→ 401，不触达 service', async () => {
      const status = await send('post', BASE);
      expect(status).toBe(401);
      expect(service.create).not.toHaveBeenCalled();
    });
  });
});
