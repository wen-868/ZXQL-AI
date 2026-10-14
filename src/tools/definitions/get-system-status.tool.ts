/**
 * getSystemStatus 工具 — 系统状态自检（只读；R101-AI-34 P1-4）
 *
 * 用途：一次调用看清 **服务层 / 健康层 / AI 层 / 治理层** 四层状态，供排障与"对话里问一句系统怎么样"。
 *
 * 纪律：
 * 1. **读工具** `isWriteOperation=false` ⇒ 读全自动（不进写全审核门、不耗幂等键）
 * 2. **execute 禁抛 + 部分降级**：每层独立 try/catch，某层不可用 ⇒ 该层 `status:'unavailable'` + 原因，
 *    **不因此整工具失败**（有多少报多少）
 * 3. **治理层只读不消耗**：用 `capacityOf(bucket)` 取**容量口径**，绝不调 `consume`
 *    （否则"查状态"本身会吃掉额度）；因此出参叫 `readCapacity`/`writeCapacity`，**不叫 remaining**（避免误导）
 * 4. 健康层可能较慢（探测 DB）⇒ 由 `detail` 控制：`detail=false`（缺省）跳过，标 `skipped`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RateLimiterService, RateLimitBucket } from '../../common/rate-limiter';
import { resolveIntegrationMode } from '../../database/dialect';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';

/** 单层状态（ok / unavailable / skipped） */
interface LayerStatus {
  status: 'ok' | 'unavailable' | 'skipped';
  /** 不可用或跳过的原因（ok 时缺省不带） */
  reason?: string;
  /** 分层明细 */
  detail?: Record<string, unknown>;
}

@Injectable()
export class GetSystemStatusTool implements ITool {
  private readonly logger = new Logger(GetSystemStatusTool.name);

  readonly name = 'getSystemStatus';
  readonly description =
    '系统状态自检（只读）：分层返回 ①服务层（版本/运行时长/集成形态 standalone|connected）' +
    '②健康层（数据库探测结论，需 detail=true）③AI 层（生效 provider/model + 是否已配置单价）' +
    '④治理层（读/写限流**容量**口径）。某层不可用时该项标 unavailable 并说明原因，不影响其它层。' +
    '适合"系统状态怎么样""AI 底座健康吗"等场景。示例参数：{"detail":true}';
  readonly category = 'system' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      detail: {
        type: 'boolean',
        description:
          '是否执行数据库健康探测（可选，默认 false）：false=跳过（响应快），true=执行（可能较慢）',
      },
    },
  };

  constructor(
    // 健康层：用**主库连接的轻量探针**（`SELECT 1`）
    // 说明：原计划复用 `ReadinessService.check()`，但它仅在 AppModule 提供且未导出，
    // 且其构造依赖 ai_db DataSource（ToolsModule 无该 token）⇒ 注入必然 DI 失败（实测
    // app.module.di.spec 报 `Nest can't resolve dependencies … ReadinessService`）。
    // 取舍：不为此在模块图上做手术（避免影响全局 DI），改为本工具内做轻量探针；
    // 若后续需要 ai_db 结论，可把 ReadinessService 提到可导出模块后在此切换（一行改动）。
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly aiConfig: AiConfigService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const detail = args.detail === true;

    const service: LayerStatus = {
      status: 'ok',
      detail: {
        version: process.env.npm_package_version ?? 'unknown',
        uptimeSeconds: Math.round(process.uptime()),
        integrationMode: resolveIntegrationMode(),
        nodeVersion: process.version,
      },
    };

    const db = detail
      ? await this.probeDb()
      : {
          status: 'skipped' as const,
          reason:
            'detail=false：未探测数据库（避免慢查询；需要时传 detail=true）',
        };

    const ai = await this.probeAi();
    const governance = this.probeGovernance();

    return {
      success: true,
      data: {
        service,
        db,
        ai,
        governance,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /** 健康层：主库轻量探针（`SELECT 1`；复用主库连接，不新建连接） */
  private async probeDb(): Promise<LayerStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'ok',
        detail: { main: 'ok', probe: 'SELECT 1' },
      };
    } catch (err) {
      const reason = messageOf(err);
      this.logger.warn(`健康层探测失败：${reason}`);
      return { status: 'unavailable', reason };
    }
  }

  /** AI 层：生效 provider/model + 是否配置单价（未配 ⇒ 费用告警未生效） */
  private async probeAi(): Promise<LayerStatus> {
    try {
      const resolved = (await this.aiConfig.getResolvedConfig()) as unknown as {
        provider?: unknown;
        model?: unknown;
      };
      const provider =
        typeof resolved?.provider === 'string' ? resolved.provider : 'unknown';
      const model =
        typeof resolved?.model === 'string' ? resolved.model : 'unknown';

      let priceConfigured = false;
      try {
        const price = await this.aiConfig.getModelPrice(provider, model);
        priceConfigured = price !== null && price !== undefined;
      } catch (err) {
        // 单价查询失败 ⇒ 视为未配置（不抛；费用告警是否生效需要人工确认）
        this.logger.warn(`单价查询失败：${messageOf(err)}`);
      }

      return {
        status: 'ok',
        detail: { provider, model, priceConfigured },
        ...(priceConfigured
          ? {}
          : { reason: '费用告警未生效（需平台配置 t_ai_model_price）' }),
      };
    } catch (err) {
      const reason = messageOf(err);
      this.logger.warn(`AI 层取配置失败：${reason}`);
      return { status: 'unavailable', reason };
    }
  }

  /** 治理层：**容量口径**（只读不消耗；余量需 consume 才能得知，会自耗额度 ⇒ 不取） */
  private probeGovernance(): LayerStatus {
    try {
      const buckets: RateLimitBucket[] = ['read', 'write'];
      const detail: Record<string, unknown> = {};
      for (const bucket of buckets) {
        const { capacity, refillPerMs } = this.rateLimiter.capacityOf(bucket);
        detail[`${bucket}Capacity`] = capacity;
        detail[`${bucket}RefillPerMs`] = refillPerMs;
      }
      return { status: 'ok', detail };
    } catch (err) {
      const reason = messageOf(err);
      this.logger.warn(`治理层取容量失败：${reason}`);
      return { status: 'unavailable', reason };
    }
  }
}

/** 错误消息归一（不抛） */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '未知错误';
}
