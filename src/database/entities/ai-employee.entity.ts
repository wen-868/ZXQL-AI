/**
 * 数字员工 Entity（2026-09-05 数字员工 MVP）
 *
 * 设计定案（用户确认）：
 * - 每个员工就是一个对话框（新建员工自动进入对话列表），对话框内容即工作台
 * - 上级数字员工可经 dispatchEmployeeTask 工具调度下级（子代理语义，
 *   任务在下级自己的会话中执行并留痕），层级最多两级
 *
 * 岗位档案表 = 凌舟"Capability Scoping"判定的一张表：
 * 岗位 → 工具子集 + 数据权限 + 人设 + 记忆命名空间 + 审阅规则
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('t_ai_employee')
export class AiEmployeeEntity {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 所属租户（多租户隔离） */
  @Index('idx_emp_tenant')
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 32,
    comment: '所属租户',
  })
  tenantId!: string;

  /** 员工唯一标识（会话前缀/记忆命名空间用） */
  @Index('idx_emp_uid')
  @Column({
    name: 'employee_uid',
    type: 'varchar',
    length: 40,
    comment: '员工唯一标识',
  })
  employeeUid!: string;

  /** 员工名称（如"张选选"，展示在对话列表） */
  @Column({ name: 'name', type: 'varchar', length: 64, comment: '员工名称' })
  name!: string;

  /** 岗位（如"运营专员"） */
  @Column({ name: 'post', type: 'varchar', length: 64, comment: '岗位' })
  post!: string;

  /** 部门 */
  @Column({
    name: 'department',
    type: 'varchar',
    length: 64,
    comment: '部门',
  })
  department!: string;

  /** 岗位人设系统提示词（覆盖默认助手提示词） */
  @Column({
    name: 'persona_prompt',
    type: 'text',
    nullable: true,
    comment: '岗位人设系统提示词',
  })
  personaPrompt!: string | null;

  /** 工具子集：按业务域限定（JSON 数组，如 ["inventory","order"]；空=全量） */
  @Column({
    name: 'tool_categories',
    type: 'json',
    nullable: true,
    comment: '工具业务域子集',
  })
  toolCategories!: string[] | null;

  /** 数据权限范围（JSON，预留：可读写表/接口白名单） */
  @Column({
    name: 'data_scope',
    type: 'json',
    nullable: true,
    comment: '数据权限范围',
  })
  dataScope!: Record<string, unknown> | null;

  /** 可调用的员工 employeeUid 列表（边表：组织树的替代；空=终端岗位不可派发） */
  @Column({
    name: 'dispatch_uids',
    type: 'json',
    nullable: true,
    comment: '可调用的员工 employeeUid 列表（边表）',
  })
  dispatchUids!: string[] | null;

  /** 对话风格（如"高效直接"） */
  @Column({
    name: 'reply_style',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '对话风格',
  })
  replyStyle!: string | null;

  /** 状态：1=启用 0=停用 */
  @Column({ name: 'status', type: 'tinyint', default: 1, comment: '状态' })
  status!: number;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
    comment: '更新时间',
  })
  updatedAt!: Date;
}

/**
 * 员工任务记录（下级对话框的工作留痕：任务下达→执行→结果）
 */
@Entity('t_ai_employee_task')
@Index('idx_emp_task_emp', ['employeeId'])
export class AiEmployeeTaskEntity {
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 执行该任务的员工 */
  @Column({
    name: 'employee_id',
    type: 'int',
    unsigned: true,
    comment: '执行员工ID（t_ai_employee.id）',
  })
  employeeId!: number;

  /** 任务描述（上级派发/用户直接交办） */
  @Column({ name: 'task', type: 'text', comment: '任务描述' })
  task!: string;

  /** 派发来源：user=用户直接交办 / employee:XX=上级员工派发 */
  @Column({
    name: 'dispatched_by',
    type: 'varchar',
    length: 64,
    default: 'user',
    comment: '派发来源',
  })
  dispatchedBy!: string;

  /** 执行产出的摘要文本 */
  @Column({
    name: 'result_summary',
    type: 'text',
    nullable: true,
    comment: '执行结果摘要',
  })
  resultSummary!: string | null;

  /** 状态：running/completed/failed */
  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: 'running',
    comment: '状态：running/completed/failed',
  })
  status!: string;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
