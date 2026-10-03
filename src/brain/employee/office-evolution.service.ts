/**
 * OfficeEvolutionService — 办公场景进化（2026-09-05）
 *
 * 背景：进化飞轮此前只覆盖结构化抽取（write_schema.*）与对话纠错；
 * 数字员工承接的办公任务（报告/通知/纪要/分析/汇总）产出的验收结果
 * 没有回流通道。本服务补上办公场景的进化输入端：
 *
 * 1. 评分回流：用户对员工完成的办公任务评分（1-5 + 采纳/驳回 + 修改意见）
 *    - 采纳（score≥4）→ ai_sample（prompt=任务、completion=产出，quality=score）
 *      → 喂 E3 few-shot 回流 / E4 数据管线
 *    - 驳回（score≤2 或 adopted=false）→ ai_correction（wrong=产出、right=意见）
 *      → 喂 E2 萃取 / E5 校准
 * 2. 办公任务类型注册表：统一任务类型口径（报告/通知/纪要/分析/汇总），
 *    供样本归档、few-shot 匹配与 E4 就绪度统计共用
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { CaptureService } from '../../evolution/capture.service';
import { EmployeeService } from './employee.service';

/** 办公场景任务类型（注册表：口径统一供样本/few-shot/E4 共用） */
export const OFFICE_TASK_TYPES = [
  'office_report', // 报告（周报/月报/经营分析报告）
  'office_notification', // 通知/公告文案
  'office_minutes', // 会议纪要
  'office_analysis', // 数据分析/汇总
  'office_document', // 通用办公文档
] as const;

export type OfficeTaskType = (typeof OFFICE_TASK_TYPES)[number];

/** 评分输入 */
export interface OfficeTaskRatingInput {
  taskId: number;
  tenantId: string;
  /** 评分 1-5（5=完全采纳） */
  score: number;
  /** 是否采纳产出 */
  adopted: boolean;
  /** 修改意见/正确做法（驳回时必填） */
  feedback?: string;
  /** 任务类型（缺省按 office_document 归档） */
  taskType?: string;
}

@Injectable()
export class OfficeEvolutionService {
  private readonly logger = new Logger(OfficeEvolutionService.name);

  constructor(
    private readonly capture: CaptureService,
    private readonly employeeService: EmployeeService,
  ) {}

  /**
   * 办公任务评分回流：
   * - 采纳（score≥4）→ ai_sample（E3 few-shot / E4 数据管线）
   * - 驳回（score≤2 或明确不采纳）→ ai_correction（E2 萃取 / E5 校准）
   * - 中评（3）→ 仅记录经验，不进样本池
   */
  async rate(
    input: OfficeTaskRatingInput,
  ): Promise<{ routedTo: 'sample' | 'correction' | 'experience' }> {
    const taskType = input.taskType ?? 'office_document';
    const score = Math.max(1, Math.min(5, Math.round(input.score)));
    const task = await this.employeeService.getTaskById(
      input.taskId,
      input.tenantId,
    );
    if (!task) {
      throw new Error(`任务不存在：id=${input.taskId}`);
    }

    if (input.adopted && score >= 4) {
      // 采纳 → 高质量样本（E3 few-shot / E4 训练管线；quality 按评分入库）
      await this.capture.captureTask({
        tenantId: input.tenantId,
        domain: 'analysis',
        intent: taskType,
        userMessage: task.task,
        reply: task.resultSummary ?? '',
        outcome: 'success',
        sampleQuality: score,
      });
      this.logger.log(
        `办公任务评分采纳：task=${input.taskId} type=${taskType} score=${score} → ai_sample`,
      );
      await this.employeeService.markTaskRated(
        input.taskId,
        'sample',
        input.tenantId,
      );
      return { routedTo: 'sample' };
    }

    if (!input.adopted || score <= 2) {
      // 驳回 → 纠正样本（E2 萃取 / E5 校准）
      await this.capture.captureCorrection({
        tenantId: input.tenantId,
        taskType,
        wrongPayload: { output: task.resultSummary ?? '' },
        rightPayload: input.feedback
          ? { feedback: input.feedback }
          : { feedback: '产出被驳回，需重新完成' },
        reason: `办公任务评分驳回：score=${score}${input.feedback ? '｜' + input.feedback.slice(0, 80) : ''}`,
      });
      this.logger.log(
        `办公任务评分驳回：task=${input.taskId} score=${score} → ai_correction`,
      );
      await this.employeeService.markTaskRated(
        input.taskId,
        'correction',
        input.tenantId,
      );
      return { routedTo: 'correction' };
    }

    // 中评（3）：仅记录经验，不进样本池也不进纠错
    await this.capture.captureTask({
      tenantId: input.tenantId,
      domain: 'analysis',
      intent: taskType,
      userMessage: task.task,
      reply: task.resultSummary ?? '',
      outcome: 'success',
    });
    this.logger.log(`办公任务中评记录：task=${input.taskId} score=${score}`);
    await this.employeeService.markTaskRated(
      input.taskId,
      'experience',
      input.tenantId,
    );
    return { routedTo: 'experience' };
  }
}
