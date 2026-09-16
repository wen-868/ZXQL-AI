/**
 * WeeklyPlanService — S3 主动周计划（2026-09-05，同日细化）
 *
 * 像店长一样"自己决定本周值得关注的三件事"：
 * 1. 信号源：t_push_log 里本周的 ai_proactive 推送记录（库存预警/应收/异常
 *    等巡检的真实产出，schema 与 ProactivePushService 完全一致，零猜测）；
 *    同标题去重——同一预警每天重复推送，计划里只留一条；
 * 2. LLM 规划：把信号喂给当前路由模型，产出「本周值得关注的三件事」计划
 *    （每件事：一句话 + 数据依据 + 建议动作），剥 markdown 围栏容错；
 * 3. 落地：通过 ProactivePushService 落库推送（审计留痕）+ 返回给调用方；
 * 4. 自动化：每周一 09:00 定时生成 default 租户计划（WEEKLY_PLAN_CRON_ENABLED
 *    开关，默认关闭——多租户租户清单接入前先覆盖单体场景）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { ProactivePushService } from './proactive-push.service';

/** 本周信号行（t_push_log ai_proactive 通道） */
interface WeeklySignalRow {
  title: string;
  content: string;
  created_at: string | Date;
}

export interface WeeklyPlanResult {
  tenantId: string;
  /** 本周信号条数（按标题去重后） */
  signals: number;
  /** 周计划文本（LLM 规划） */
  plan: string;
}

@Injectable()
export class WeeklyPlanService {
  private readonly logger = new Logger(WeeklyPlanService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly aiConfigService: AiConfigService,
    private readonly router: ProviderRouterService,
    private readonly push: ProactivePushService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 每周一 09:00 自动生成 default 租户周计划
   *
   * 默认关闭（WEEKLY_PLAN_CRON_ENABLED=true 开启）：多租户的租户清单
   * 接入前，先覆盖单体/默认租户场景，避免误推。
   */
  @Cron('0 0 9 * * 1')
  async handleWeeklyCron(): Promise<void> {
    if (
      this.configService.get<string>('WEEKLY_PLAN_CRON_ENABLED', 'false') !==
      'true'
    ) {
      return;
    }
    try {
      await this.buildWeeklyPlan('default');
    } catch (err) {
      this.logger.warn(
        `周计划定时生成失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 生成本周经营计划：聚合本周主动信号（去重）→ LLM 规划三件事 → 推送留痕
   */
  async buildWeeklyPlan(tenantId: string): Promise<WeeklyPlanResult> {
    // 1. 本周主动信号（t_push_log ai_proactive 通道，schema 与推送服务一致）
    const rows = await this.dataSource.query<WeeklySignalRow[]>(
      `SELECT title, content, created_at
         FROM t_push_log
        WHERE channel = 'ai_proactive'
          AND status = 'SUCCESS'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ORDER BY created_at DESC
        LIMIT 30`,
    );

    const seenTitles = new Set<string>();
    const uniqRows = rows.filter((r) => {
      const key = String(r.title ?? '').trim();
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    const signals = uniqRows.length;
    const brief =
      uniqRows.length > 0
        ? uniqRows
            .map(
              (r) =>
                `- [${String(r.created_at).slice(5, 10)}] ${String(
                  r.title ?? '',
                ).slice(0, 60)}`,
            )
            .join('\n')
        : '（本周暂无主动推送信号）';

    // 2. LLM 规划三件事
    let plan: string;
    try {
      const resolved = await this.aiConfigService.getResolvedConfig();
      const routed = this.router.route({
        requestedModel: undefined,
        resolved,
        systemScope: 'mgmt',
      });
      const res = await routed.provider.chatSync(
        [
          {
            role: 'user',
            content:
              `你是酒水门店的经营助手。以下是系统本周自动产生的主动提醒信号（最新在前）：\n${brief}\n\n` +
              '请为老板制定「本周值得关注的三件事」：每件事一行，格式为「标题 —— 数据依据 → 建议动作」；' +
              '标题前用 1./2./3. 编号；总长不超过 8 行，简体中文。' +
              '若信号为空，给出周初经营检查清单三条（库存/应收/动销各一条）。',
          },
        ],
        { temperature: 0.3, max_tokens: 500 },
      );
      let planText = res.content?.trim() ?? '';
      // 剥 markdown 代码块围栏（部分模型会给计划套 ```）
      if (planText.startsWith('```')) {
        const nl = planText.indexOf('\n');
        if (nl >= 0) planText = planText.slice(nl + 1);
        if (planText.endsWith('```')) planText = planText.slice(0, -3);
        planText = planText.trim();
      }
      plan = planText;
    } catch (err) {
      this.logger.warn(
        `周计划 LLM 规划失败（降级为信号清单）：${err instanceof Error ? err.message : String(err)}`,
      );
      plan =
        signals > 0
          ? `本周共 ${signals} 条主动提醒，请按时间顺序查看：\n${brief}`
          : '本周暂无主动提醒信号。周初建议检查：①低库存商品补货；②逾期应收催收；③滞销品动销方案。';
    }

    // 3. 落库推送（审计留痕；失败不阻塞返回）
    try {
      await this.push.push(tenantId, 'weekly-plan', {
        type: 'system',
        priority: 'important',
        title: '本周经营计划（AI 规划）',
        content: plan,
      });
    } catch (err) {
      this.logger.warn(
        `周计划推送失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(
      `S3 周计划已生成：tenant=${tenantId} signals=${signals} plan=${plan.length}字`,
    );
    return { tenantId, signals, plan };
  }
}
