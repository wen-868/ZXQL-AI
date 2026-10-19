/**
 * EmployeeTodoSyncService — 数字员工任务结果 ⇒ 待办状态回写（R101-AI-46）
 *
 * 为什么单独成服务（而不是在 bridge 里写 UPDATE）：
 * - **单一真相**：待办状态迁移的原子判定只有一处实现；`AiTodoCompleteTool`（tools 面）
 *   与 `EmployeeTaskBridge`（brain 面）都调用本服务 ⇒ 避免"两份 UPDATE 逻辑"漂移
 *   （这是本项目反复踩过的病根：同逻辑两处必漂）。
 * - **零循环依赖**：本服务在 EmployeeModule 内（只依赖 TypeORM 仓储）；
 *   `ToolsModule → EmployeeModule` 已是既有依赖方向（tools.module.ts 已 import 它）⇒
 *   tools 侧反向调用本服务**不新增环**。
 *
 * 语义（R101-AI-46 定案）：
 * - **仅任务成功 ⇒ 回写 done**；任务失败**不改状态**（失败自动改 done 会掩盖问题，
 *   待办应保持未完结让人看到"还没处理完"）。
 * - **原子迁移，不先读后写**：`UPDATE ... WHERE status <> 'done'` ⇒ affected=0 即
 *   "已完成/不存在" ⇒ 回放（与 aiTodoComplete 同口径，并发下只有一个请求真正改状态）。
 * - **回写失败绝不影响任务结果**（主次不倒置）：调用方（bridge）已包 try/catch；
 *   本服务自身也吞异常并返回结果对象（不抛）。
 * - **权限**：回写是"系统代办的内部状态同步"，不经过 ACL（数字员工本就是被指派的
 *   负责人；ACL 校验在用户态的 aiTodoComplete 那一侧）。
 *
 * 负责人: 阿澈（AI 底座集成 owner）｜创建日期: 2026-10-19
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';

/** 回写结果（不抛异常，调用方按字段判断） */
export interface TodoSyncResult {
  /** 是否由本次调用改变了状态（false = 已是 done / 不存在） */
  changed: boolean;
  /** 回放（已是 done） */
  replayed?: boolean;
  /** 待办不存在（已被删/从未建） */
  notFound?: boolean;
  /** 失败原因（吞异常时给） */
  error?: string;
}

@Injectable()
export class EmployeeTodoSyncService {
  private readonly logger = new Logger(EmployeeTodoSyncService.name);

  constructor(
    @InjectRepository(AiTodoEntity)
    private readonly todoRepo: Repository<AiTodoEntity>,
  ) {}

  /**
   * 把待办标记为 done（原子迁移；幂等）
   *
   * @param tenantId 租户（与待办联合定位，防跨租户误写）
   * @param todoId   待办 ID
   * @param reason   回写来源说明（日志用，如"数字员工任务完成"）
   */
  async markDone(
    tenantId: string,
    todoId: string,
    reason: string,
  ): Promise<TodoSyncResult> {
    try {
      // ── 原子迁移：只把"非 done"的改成 done；affected=0 ⇒ 已是 done 或不存在 ──
      const upd = await this.todoRepo.update(
        { id: todoId, tenantId, status: Not('done') },
        { status: 'done' },
      );
      if ((upd.affected ?? 0) > 0) {
        this.logger.log(
          `待办回写 done：todo=${todoId} tenant=${tenantId}（${reason}）`,
        );
        return { changed: true };
      }

      // affected=0：区分"已是 done（回放）"与"不存在"
      const existing = await this.todoRepo.findOne({
        where: { id: todoId, tenantId },
      });
      if (existing && existing.status === 'done') {
        return { changed: false, replayed: true };
      }
      return { changed: false, notFound: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 主次不倒置：回写失败只记录，不抛（bridge 的任务结果不得被它改写）
      this.logger.warn(
        `待办回写失败（已隔离，不影响任务结果）：todo=${todoId} tenant=${tenantId} ${message}`,
      );
      return { changed: false, error: message };
    }
  }
}
