import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { Server as HttpServer } from 'http';
import { AppModule } from './app.module';
import { PushGatewayService } from './gateway/push-gateway.service';

/**
 * 智享AI底座 — 应用入口
 *
 * 启动端口：3016（与现有 backend 8080 端口隔离）
 * 全局前缀：/api（与项目统一标准对齐）
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // 读取配置
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3016);
  const env = configService.get<string>('NODE_ENV', 'development');

  // 全局前缀（与项目统一标准对齐：/api/admin/*、/api/platform/*）
  app.setGlobalPrefix('api');

  // 全局管道：参数校验 + 自动类型转换
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 启用 CORS（前端 admin-web / app-mobile 跨域调用）
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // 初始化 AI 主动推送 WebSocket 通道（/api/ai/ws，JWT 认证 + 按租户广播）
  app.get(PushGatewayService).init(app.getHttpServer() as HttpServer);

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
