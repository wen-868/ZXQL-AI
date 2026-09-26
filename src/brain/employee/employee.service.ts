/**
 * EmployeeService — 数字员工管理（2026-09-05 MVP）
 *
 * 设计定案：每个员工就是一个对话框（新建员工自动进入对话列表），
 * 对话框内容即工作台；指挥关系 = 员工档案上的"可调用员工列表"（边表），
 * 上级员工经 dispatchEmployeeTask 工具派发任务（异步交接+回传验收）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import {
  AiEmployeeEntity,
  AiEmployeeTaskEntity,
} from '../../database/entities/ai-employee.entity';

/** 员工对话列表项（前端对话列表直接渲染） */
export interface EmployeeDialogItem {
  id: number;
  employeeUid: string;
  name: string;
  post: string;
  department: string;
  dispatchUids: string[];
  status: string;
}

/** 员工更新输入（controller 复用） */
export type AiEmployeeUpdate = Partial<{
  name: string;
  post: string;
  department: string;
  personaPrompt: string;
  toolCategories: string[];
  replyStyle: string;
  dispatchUids: string[];
  status: number;
}>;

/** 员工任务执行输入（bridge 回调用） */
export interface EmployeeTaskRunInput {
  taskId: number;
  employee: AiEmployeeEntity;
  taskText: string;
  depth: number;
  tenantId: string;
  dispatchedBy: string;
}

/** 任务执行回调签名（Brain 侧 bridge 注册，避免 EmployeeModule↔BrainModule 循环依赖） */
export type EmployeeTaskRunnerFn = (
  input: EmployeeTaskRunInput,
) => Promise<{ summary: string; status: 'completed' | 'failed' }>;

@Injectable()
export class EmployeeService {
  /** 任务执行回调（Brain 侧 bridge 注册） */
  private taskRunner: EmployeeTaskRunnerFn | null = null;

  setTaskRunner(fn: EmployeeTaskRunnerFn): void {
    this.taskRunner = fn;
  }

  constructor(
    @InjectRepository(AiEmployeeEntity)
    private readonly employeeRepo: Repository<AiEmployeeEntity>,
    @InjectRepository(AiEmployeeTaskEntity)
    private readonly taskRepo: Repository<AiEmployeeTaskEntity>,
  ) {}

  /** 新建员工（自动生成 employeeUid，前端据此外发对话列表项） */
  async create(input: {
    tenantId: string;
    name: string;
    post: string;
    department: string;
    personaPrompt?: string;
    toolCategories?: string[];
    replyStyle?: string;
    dispatchUids?: string[];
  }): Promise<AiEmployeeEntity> {
    return this.employeeRepo.save(
      this.employeeRepo.create({
        tenantId: input.tenantId,
        employeeUid: `emp_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        name: input.name,
        post: input.post,
        department: input.department,
        personaPrompt: input.personaPrompt ?? null,
        toolCategories: input.toolCategories ?? null,
        replyStyle: input.replyStyle ?? null,
        dispatchUids: input.dispatchUids ?? null,
        status: 1,
      }),
    );
  }

  /** 员工列表（即对话列表数据源，按创建倒序） */
  async list(tenantId: string): Promise<EmployeeDialogItem[]> {
    const items = await this.employeeRepo.find({
      where: { tenantId, status: 1 },
      order: { id: 'DESC' },
    });
    return items.map((e) => ({
      id: e.id,
      employeeUid: e.employeeUid,
      name: e.name,
      post: e.post,
      department: e.department,
      dispatchUids: e.dispatchUids ?? [],
      status: (e.dispatchUids?.length ?? 0) > 0 ? '管理岗' : '就绪',
    }));
  }

  async getById(id: number, tenantId: string): Promise<AiEmployeeEntity> {
    const e = await this.employeeRepo.findOne({ where: { id, tenantId } });
    if (!e) throw new NotFoundException(`数字员工不存在：id=${id}`);
    return e;
  }

  async getByUid(
    uid: string,
    tenantId: string,
  ): Promise<AiEmployeeEntity | null> {
    return this.employeeRepo.findOne({ where: { employeeUid: uid, tenantId } });
  }

  /** 按名称/岗位前缀查找（上级派发时用自然语言指名） */
  async findByNameOrPost(
    keyword: string,
    tenantId: string,
  ): Promise<AiEmployeeEntity | null> {
    return (
      (await this.employeeRepo
        .createQueryBuilder('e')
        .where('e.tenant_id = :tenantId AND e.status = 1')
        .andWhere('(e.name LIKE :kw OR e.post LIKE :kw)')
        .setParameter('tenantId', tenantId)
        .setParameter('kw', `${keyword}%`)
        .getOne()) ?? null
    );
  }

  async update(
    id: number,
    tenantId: string,
    input: AiEmployeeUpdate,
  ): Promise<AiEmployeeEntity> {
    const e = await this.getById(id, tenantId);
    if (input.name !== undefined) e.name = input.name;
    if (input.post !== undefined) e.post = input.post;
    if (input.department !== undefined) e.department = input.department;
    if (input.personaPrompt !== undefined)
      e.personaPrompt = input.personaPrompt;
    if (input.toolCategories !== undefined)
      e.toolCategories = input.toolCategories;
    if (input.replyStyle !== undefined) e.replyStyle = input.replyStyle;
    if (input.dispatchUids !== undefined) e.dispatchUids = input.dispatchUids;
    if (input.status !== undefined) e.status = input.status;
    return this.employeeRepo.save(e);
  }

  /**
   * 派发任务给员工（异步任务交接：派发即返回，执行与回传异步进行）
   *
   * 校验链：目标解析 → 调用者边表校验（用户直接交办跳过）→ 深度上限
   * → 执行器预检 → 建任务记录 → 触发执行
   *
   * 执行器预检前置（2026-09-26）：未装配时直接拒绝，不再先落库，
   * 避免产生永远停留在 running 的孤儿任务记录。
   */
  async dispatchTask(input: {
    callerUid?: string;
    tenantId: string;
    targetKeyword: string;
    task: string;
    dispatchDepth: number;
  }): Promise<{
    accepted: boolean;
    taskId?: number;
    employeeName?: string;
    employeeUid?: string;
    message: string;
  }> {
    // 1. 目标解析（名称/岗位前缀匹配）
    const target = await this.findByNameOrPost(
      input.targetKeyword,
      input.tenantId,
    );
    if (!target) {
      return {
        accepted: false,
        message: `未找到员工或岗位「${input.targetKeyword}」`,
      };
    }

    // 2. 调用者校验：员工调用必须在边表内；用户直接交办不限
    let dispatchedBy = 'user';
    if (input.callerUid) {
      const caller = await this.getByUid(input.callerUid, input.tenantId);
      if (!caller) {
        return { accepted: false, message: '调用者员工不存在' };
      }
      dispatchedBy = `employee:${caller.employeeUid}`;
      if (!(caller.dispatchUids ?? []).includes(target.employeeUid)) {
        return {
          accepted: false,
          message: `「${target.name}」不在「${caller.name}」的可调用员工列表中`,
        };
      }
    }

    // 3. 深度上限（防无限派发链）
    const maxDepth = Number(process.env.MAX_DISPATCH_DEPTH || 2);
    if ((input.dispatchDepth ?? 0) + 1 > maxDepth) {
      return {
        accepted: false,
        message: `已达派发深度上限（${maxDepth} 级），请在上级会话直接处理`,
      };
    }

    // 4. 执行器预检：先校验再落库
    // （旧实现先 recordTask 后校验，未装配时会留下一条永远 running 的孤儿任务记录）
    if (!this.taskRunner) {
      return { accepted: false, message: '任务执行器未装配' };
    }

    // 5. 建任务记录 + 异步触发执行（派发即返回；异常由 catch 落 failed）
    const record = await this.recordTask({
      employeeId: target.id,
      task: input.task,
      dispatchedBy,
    });
    void this.taskRunner({
      taskId: record.id,
      employee: target,
      taskText: input.task,
      depth: (input.dispatchDepth ?? 0) + 1,
      tenantId: input.tenantId,
      dispatchedBy,
    }).catch((err: unknown) => {
      void this.completeTask(
        record.id,
        `执行异常：${err instanceof Error ? err.message : String(err)}`,
        'failed',
      );
    });

    return {
      accepted: true,
      taskId: record.id,
      employeeName: target.name,
      employeeUid: target.employeeUid,
      message: `任务已派发给「${target.name}」（任务#${record.id}），完成后结果将回传`,
    };
  }

  /** 记录下级会话中的任务（工作留痕：任务下达→结果） */
  async recordTask(input: {
    employeeId: number;
    task: string;
    dispatchedBy: string;
  }): Promise<AiEmployeeTaskEntity> {
    return this.taskRepo.save(
      this.taskRepo.create({
        employeeId: input.employeeId,
        task: input.task,
        dispatchedBy: input.dispatchedBy,
        status: 'running',
      }),
    );
  }

  async completeTask(
    taskId: number,
    resultSummary: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.taskRepo.update(taskId, {
      resultSummary: resultSummary.slice(0, 4000),
      status,
    });
  }

  /** 员工任务列表（对话框工作台：执行的任务 + 派发出的任务） */
  async listTasksFor(
    employeeUid: string,
    employeeId: number,
  ): Promise<AiEmployeeTaskEntity[]> {
    return this.taskRepo
      .createQueryBuilder('t')
      .where('t.employee_id = :eid OR t.dispatched_by = :uid', {
        eid: employeeId,
        uid: `employee:${employeeUid}`,
      })
      .orderBy('t.id', 'DESC')
      .take(50)
      .getMany();
  }
}
