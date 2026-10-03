import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ReadinessService } from './ops/readiness.service';
import type { ReadinessReport } from './ops/readiness.service';

describe('AppController', () => {
  let appController: AppController;
  let readinessService: { check: jest.Mock };

  const readyReport = (
    overrides: Partial<ReadinessReport> = {},
  ): ReadinessReport => ({
    status: 'ready',
    service: 'zhixiang-ai-base',
    checkedAt: '2026-10-03T00:00:00.000Z',
    durationMs: 1,
    cached: false,
    databases: [],
    summary: { missingTables: 0, missingColumns: 0 },
    ...overrides,
  });

  beforeEach(async () => {
    readinessService = { check: jest.fn().mockResolvedValue(readyReport()) };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: ReadinessService, useValue: readinessService },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return health status with service name', () => {
      const result = appController.getHealth();
      expect(result.status).toBe('ok');
      expect(result.service).toBe('zhixiang-ai-base');
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('health/ready', () => {
    /** 伪 express 响应：只需 setHeader */
    const mockRes = () => {
      const headers: Record<string, string> = {};
      return {
        headers,
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      };
    };

    it('ready 时返回报告并置响应头 X-AI-Readiness: ready', async () => {
      const res = mockRes();
      const result = await appController.getReady(
        res as unknown as import('express').Response,
      );
      expect(result.status).toBe('ready');
      expect(res.headers['X-AI-Readiness']).toBe('ready');
    });

    it('degraded 时仍返回报告（不抛异常）并置响应头为 degraded', async () => {
      // 反测信号：若实现改成 degraded 就抛错/返回 5xx，本例会红
      readinessService.check.mockResolvedValue(
        readyReport({
          status: 'degraded',
          summary: { missingTables: 1, missingColumns: 3 },
          message: '迁移未执行',
        }),
      );
      const res = mockRes();
      const result = await appController.getReady(
        res as unknown as import('express').Response,
      );
      expect(result.status).toBe('degraded');
      expect(result.summary).toEqual({ missingTables: 1, missingColumns: 3 });
      expect(res.headers['X-AI-Readiness']).toBe('degraded');
    });
  });
});
