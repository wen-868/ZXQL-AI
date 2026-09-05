import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { PushGatewayService } from './gateway/push-gateway.service';

/**
 * 智享AI底座 — 应用入口
 *
 * 启动端口：3016（与现有 backend 8080 端口隔离）
 * 全局前缀：/api（与项目统一标准对齐）
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // 读取配置
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3016);
  const env = configService.get<string>('NODE_ENV', 'development');

  // 全局前缀（与项目统一标准对齐：/api/admin/*、/api/platform/*）
  app.setGlobalPrefix('api');

  // 信任同机 nginx 反代跳数：req.ip 取真实客户端 IP（X-Forwarded-By 之前的最后一跳），
  // 防止客户端伪造 X-Forwarded-For 污染限流与审计日志（2026-09-05 审查 M4/H3）
  app.set('trust proxy', 'loopback');

  // 全局管道：参数校验 + 自动类型转换
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS 白名单（2026-09-05 审查 H1 修复：不再反射任意 Origin）
  // 默认放行智享全链站点与本地开发端口；可用 CORS_ORIGINS（逗号分隔）覆盖。
  const corsOrigins = (configService.get<string>('CORS_ORIGINS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultOrigins = [
    'https://admin.onepan.cn',
    'https://saas.onepan.cn',
    'https://m.onepan.cn',
    'https://store.onepan.cn',
    // 本地开发（admin-web 5173 / saas-admin 5174 / 预览 5175 等）
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
  ];
  const allowedOrigins = new Set(
    corsOrigins.length > 0 ? corsOrigins : defaultOrigins,
  );
  app.enableCors({
    // 无 Origin（curl/服务间调用/同源）放行；浏览器跨域仅放行白名单
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });

  // 初始化 AI 主动推送 WebSocket 通道（/api/ai/ws，JWT 认证 + 按租户广播）
  app.get(PushGatewayService).init(app.getHttpServer());

  await app.listen(port);

  Logger.log(
    `AI底座已启动: http://localhost:${port}（环境：${env}）`,
    'Bootstrap',
  );
}

void bootstrap().catch((err: unknown) => {
  // 启动失败时输出错误并退出进程，避免进程悬挂

  console.error('AI底座启动失败:', err);
  process.exit(1);
});
