/**
 * aiScheduleCancel — 取消日程（**写工具**；R101-AI-39）
 *
 * 逻辑全在 `ScheduleStateBase`（原子迁移 `planned → cancelled`；已是 cancelled ⇒ 回放；
 * **已 done ⇒ 明确失败**（两终态互斥，凌舟裁定"已 done 不可撤"））。
 *
 * 对照规范 §2.1：取消是**无歧义终态** ⇒ 同终态可回放；跨终态（done→cancelled）必须明确失败。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiScheduleEntity,
  ScheduleStatus,
} from '../../database/entities/ai-schedule.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ScheduleStateBase } from './schedule-state.base';

@Injectable()
export class AiScheduleCancelTool extends ScheduleStateBase {
  readonly name = 'aiScheduleCancel';
  readonly description =
    '取消日程（**写操作**，需确认）：把 planned 日程置为 cancelled。' +
    '**已完成的日程不可取消**（会明确失败）；重复取消不会重复改状态（回放）。' +
    '示例参数：{"scheduleId":"12","confirm":false}';
  protected readonly targetStatus: ScheduleStatus = 'cancelled';
  protected readonly actionName = '取消';

  constructor(
    @InjectRepository(AiScheduleEntity)
    scheduleRepo: Repository<AiScheduleEntity>,
    injectAcl: OfficeAclService,
  ) {
    super(scheduleRepo, injectAcl);
  }
}
