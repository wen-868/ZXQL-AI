/* eslint-disable @typescript-eslint/unbound-method -- 断言需直接引用 mock 方法（toHaveBeenCalled/not.toHaveBeenCalled） */
/**
 * R101-AI-01 缺口1：外部模型平台级端点的**读端点**（list / options）身份收口断言
 *
 * 背景：e787dce 已给 ExternalModelController 全部 7 个端点加了 requirePlatformIdentity，
 * 但 external-model.scope.spec.ts:18 明确写了"未断言 list/options" ⇒ 若后续重构
 * 只丢掉**读端点**的身份判定（商家可枚举平台外部模型库、拿到 baseUrl 甚至脱敏前的
 * 端点信息），现有测试不会红。本文件补上这 4 条断言，消除该盲区。
 *
 * 反测方向（「修复不存在」）：把 external-model.controller.ts 的 list()/options() 里
 * 的 `this.requirePlatformIdentity(req);` 删掉 ⇒ 本文件"商家身份 → 403"两条必红
 * （商家会拿到 200 并触达 service）。平台放行两条不受影响（证明反测是精确命中的）。
 *
 * 取证方式与既有 external-model.scope.spec.ts 同构：走真实 HTTP 层
 * （真实 AdminGuard + 真实 ExternalModelController，仅 ExternalModelService 用 mock）。
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
const TEST_JWT_SECRET = 'r101-ai-01-read-scope-spec-secret';

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

describe('R101-AI-01 ExternalModelController 读端点（list/options）身份收口', () => {
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

  /** 以指定身份发起 GET 请求，返回 HTTP 状态码 */
  async function sendGet(path: string, token?: string): Promise<number> {
    const server = app.getHttpServer() as Server;
    let req = request(server).get(path);
    if (token) {
      req = req.set('Authorization', `Bearer ${token}`);
    }
    const res = await req.send();
    return res.status;
  }

  describe('商家身份 → 平台级读端点必须 403', () => {
    it('GET /（外部模型列表）→ 403，不触达 service.list', async () => {
      const status = await sendGet(BASE, merchantToken());
      expect(status).toBe(403);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('GET /options（启用模型选项下拉）→ 403，不触达 service.options', async () => {
      const status = await sendGet(`${BASE}/options`, merchantToken());
      expect(status).toBe(403);
      expect(service.options).not.toHaveBeenCalled();
    });
  });

  describe('平台身份 → 读端点放行（修复不得过度拦截）', () => {
    it('GET / 放行并委托 service.list', async () => {
      const status = await sendGet(BASE, platformToken());
      expect(status).toBe(200);
      expect(service.list).toHaveBeenCalledTimes(1);
    });

    it('GET /options 放行并委托 service.options', async () => {
      const status = await sendGet(`${BASE}/options`, platformToken());
      expect(status).toBe(200);
      expect(service.options).toHaveBeenCalledTimes(1);
    });
  });

  describe('匿名 → 守卫仍然生效', () => {
    it('GET /（无 Bearer JWT）→ 401，不触达 service.list', async () => {
      const status = await sendGet(BASE);
      expect(status).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
    });
  });
});
