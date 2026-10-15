/**
 * aiScheduleComplete — 完成日程（**写工具**；R101-AI-39）
 *
 * 逻辑全在 `ScheduleStateBase`（原子迁移 `planned → done`；afffected=0 且已是 done ⇒ **回放**）。
 * 与 `aiTodoComplete` 同理：**完成是无歧义终态** ⇒ 可回放（对照规范 §2.1）。
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
export class AiScheduleCompleteTool extends ScheduleStateBase {
  readonly name = 'aiScheduleComplete';
  readonly description =
    '完成日程（**写操作**，需确认）：把 planned 日程置为 done。' +
    '**重复完成不会重复改状态**（无歧义终态 ⇒ 回放）；但**已取消的日程不可完成**（两终态互斥，会明确失败）。' +
    '示例参数：{"scheduleId":"12","confirm":false}';
  protected readonly targetStatus: ScheduleStatus = 'done';
  protected readonly actionName = '完成';

  constructor(
    @InjectRepository(AiScheduleEntity)
    scheduleRepo: Repository<AiScheduleEntity>,
    officeAcl: OfficeAclService,
  ) {
    super(scheduleRepo, officeAcl);
  }
}
