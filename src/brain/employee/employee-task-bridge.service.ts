/**
 * EmployeeTaskBridge — 数字员工任务执行桥（2026-09-05 MVP）
 *
 * 职责：把 EmployeeService 的任务执行回调接到 Brain 侧组件
 * （Orchestrator 执行下级会话轮 + MemoryManager 写任务/回传消息）。
 * 用回调注册而非直接注入，避免 EmployeeModule↔BrainModule 循环依赖。
 *
 * 执行模型（用户定案）：异步任务交接——
 * 1. 任务消息写入下级会话（下级对话框显示任务下达）
 * 2. 以下级员工身份运行 Orchestrator（独立会话轮，写确认也在下级会话）
 * 3. 完成后结果回传消息写入上级（或用户）会话，任务表 completed/failed
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MemoryManager } from '../memory-manager.service';
import { Orchestrator } from '../orchestrator.service';
import { EmployeeService, EmployeeTaskRunInput } from './employee.service';

@Injectable()
export class EmployeeTaskBridge implements OnModuleInit {
  private readonly logger = new Logger(EmployeeTaskBridge.name);

  constructor(
    private readonly employeeService: EmployeeService,
    private readonly orchestrator: Orchestrator,
    private readonly memoryManager: MemoryManager,
  ) {}

  onModuleInit(): void {
    this.employeeService.setTaskRunner(async (input) => this.run(input));
  }

  /** 执行下级会话轮：任务入账 → Orchestrator 跑 → 结果回传 */
  private async run(
    input: EmployeeTaskRunInput,
  ): Promise<{ summary: string; status: 'completed' | 'failed' }> {
    const convId = `emp_${input.employee.employeeUid}`;
    const fromLabel = input.dispatchedBy.startsWith('employee:')
      ? '上级数字员工'
      : '用户';

    // 1. 任务消息写入下级会话（下级对话框显示任务下达）
    await this.memoryManager.saveHistory(input.tenantId, convId, [
      {
        role: 'user',
        content: `【任务派发】来自${fromLabel}\n${input.taskText}`,
      },
    ]);

    // 2. 以下级员工身份运行 Orchestrator（独立会话轮）
    let text = '';
    let sawPendingWrite = false;
    let sawError: string | null = null;
    for await (const ev of this.orchestrator.run({
      message: input.taskText,
      conversationId: convId,
      tenantId: input.tenantId,
      employeeUid: input.employee.employeeUid,
      dispatchDepth: input.depth,
    })) {
      if (ev.type === 'text') text += ev.content || '';
      if (ev.type === 'pending_write') sawPendingWrite = true;
      if (ev.type === 'error') {
        sawError = ev.message;
        text += `\n⚠ ${ev.message}`;
      }
    }

    const status: 'completed' | 'failed' = sawError ? 'failed' : 'completed';
    let summary = text.trim() || '（无文本产出）';
    if (sawPendingWrite) {
      summary += '\n（已生成写操作预览，等待在员工对话框中确认执行）';
    }

    // 任务状态落库（completed/failed）
    await this.employeeService.completeTask(input.taskId, summary, status);

    // 3. 结果回传：写入派发方的会话（上级员工或用户所在对话）
    try {
      const report = `【任务回传】${input.employee.name}：${
        status === 'completed' ? '任务已完成' : '任务执行失败'
      }\n${summary.slice(0, 800)}`;
      if (input.dispatchedBy.startsWith('employee:')) {
        const callerUid = input.dispatchedBy.slice('employee:'.length);
        await this.memoryManager.saveHistory(
          input.tenantId,
          `emp_${callerUid}`,
          [{ role: 'user', content: report }],
        );
      } else {
        // 用户直接交办：写回下级会话本身（结果已在下级对话框可见）
        await this.memoryManager.saveHistory(input.tenantId, convId, [
          {
            role: 'assistant',
            content: `【任务完成回执】\n${summary.slice(0, 800)}`,
          },
        ]);
      }
    } catch (err) {
      this.logger.warn(
        `任务回传写入失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(
      `数字员工任务完成：employee=${input.employee.name} status=${status} depth=${input.depth}`,
    );
    return { summary, status };
  }
}
