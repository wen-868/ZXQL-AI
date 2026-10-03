/**
 * DispatchEmployeeTaskTool — 上级数字员工派发任务给下级（2026-09-05 MVP）
 *
 * 执行模型（用户定案）：异步任务交接——派发即返回"已派发"，下级员工
 * 在自己的对话框中执行任务，完成后结果回传到上级对话框供验收。
 * 非同步子代理：上级不阻塞等待下级。
 *
 * 权限：仅数字员工身份可调用（ToolContext.employeeUid 必须存在）；
 * 目标必须在调用者的可调用员工列表（边表）内；深度上限防递归。
 * 下级的执行同样过写全审核强制门。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable } from '@nestjs/common';
import { EmployeeService } from '../../brain/employee/employee.service';
import { ITool, ToolContext, ToolResult } from '../../tools/tool.interface';

@Injectable()
export class DispatchEmployeeTaskTool implements ITool {
  readonly name = 'dispatchEmployeeTask';
  readonly description =
    '把任务派发给可调用的下级数字员工执行（异步）。' +
    '调用后立即返回"已派发"，下级员工在自己的工作中执行，完成后结果会回传到本会话供验收。' +
    '仅在任务确属下级职责范围时使用；目标用员工名称或岗位名称指定。';
  readonly category = 'system' as const;
  readonly isWriteOperation = false;
  readonly risk = 'low' as const;

  constructor(private readonly employeeService: EmployeeService) {}

  readonly parameters = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '目标员工名称或岗位（必须是本员工可调用的下级）',
      },
      task: {
        type: 'string',
        description: '任务描述（需包含下级完成该任务所需的全部信息）',
      },
      taskType: {
        type: 'string',
        description:
          '任务业务域（可选，如 inventory/report/office_report），供任务归档与进化飞轮按域回流',
      },
    },
    required: ['target', 'task'],
  };

  async execute(
    args: { target: string; task: string; taskType?: string },
    context: ToolContext,
  ): Promise<ToolResult> {
    // P2 修复（2026-10-04）：工具声明"仅数字员工可调用"此前无运行时强制——
    // 普通会话在 fallback 车道（全量工具集）可见本工具，context.employeeUid
    // 为 undefined 时 dispatchTask 视作"用户直接交办"跳过边表校验，LLM 可
    // 把对话静默改写为任务派发。非员工身份一律拒绝。
    if (!context.employeeUid) {
      return {
        success: false,
        error:
          '任务派发仅限数字员工身份使用。如需人工协作，请直接在对话中说明需求',
      };
    }
    const targetName =
      typeof args.target === 'string' ? args.target.trim() : '';
    const taskText = typeof args.task === 'string' ? args.task.trim() : '';
    if (!targetName || !taskText) {
      return {
        success: false,
        error: '参数缺失：target（目标员工）与 task（任务描述）均为必填',
      };
    }

    const result = await this.employeeService.dispatchTask({
      callerUid: context.employeeUid,
      tenantId: context.tenantId,
      targetKeyword: targetName,
      task: taskText,
      dispatchDepth: context.dispatchDepth ?? 0,
      originConversationId: context.sessionId,
      // 透传客户分区键：上级员工经工具派发时，回传也要写回发起会话的
      // 正确记忆分区（运营客户端 key 含 customerId，缺了就失联）
      customerId: context.customerId,
      // P3 修复（2026-10-04）：工具路径派发透传 taskType——此前一律按
      // office_document 归档，E3 few-shot 域匹配失真
      taskType:
        typeof args.taskType === 'string' && args.taskType.trim()
          ? args.taskType.trim()
          : undefined,
    });

    if (!result.accepted) {
      return { success: false, error: result.message };
    }

    return {
      success: true,
      data: {
        taskId: result.taskId,
        employee: result.employeeName,
        message: result.message,
      },
    };
  }
}
