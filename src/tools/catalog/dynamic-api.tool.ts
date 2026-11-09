/**
 * DynamicApiTool — 通用动态 API 工具（完善度 P0-8「功能即技能」）
 *
 * 由 ToolGeneratorService 按 API 目录条目生成：一个条目 = 一个工具，
 * 内部经 ServiceClient 调用管理系统后端真实端点（路径占位符替换 + GET 参数透传）。
 *
 * 写确认闸（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01，fail-closed）：
 * - 构造期：非法元数据（空名称/非法方法/GET 与写标记冲突）直接拒绝；
 * - 执行期：写条目（isWriteOperation=true）一律拒绝执行，零 HTTP 请求——
 *   动态写能力的 preview/confirm 二段式与幂等契约未实现前，任何写条目
 *   不得进入写请求，即使绕过生成器直接构造实例也一样；
 * - def 以冻结快照持有：注册后篡改目录对象无法解除执行闸。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { ServiceClient } from '../../bridge/service-client';
import {
  ITool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolRisk,
  ToolScope,
} from '../tool.interface';
import type { ApiRouteDef } from './api-catalog';

/** 动态工具定义校验结论（fail-closed 拒绝原因结构化载体） */
export interface DynamicToolDefVerdict {
  ok: boolean;
  reason?: string;
}

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/**
 * 元数据合法性校验（不含写能力判定）——构造期拒绝坏对象（空名称/非法方法/GET 写冲突）
 */
function validateMetadata(def: ApiRouteDef): DynamicToolDefVerdict {
  if (!def || typeof def.name !== 'string' || def.name.trim() === '') {
    return { ok: false, reason: '空名称或名称非法' };
  }
  if (
    !def.method ||
    !(VALID_METHODS as readonly string[]).includes(def.method)
  ) {
    return { ok: false, reason: `非法 HTTP 方法：${String(def.method)}` };
  }
  if (def.isWriteOperation && def.method === 'GET') {
    return {
      ok: false,
      reason: '元数据冲突：GET 方法不得标记写操作',
    };
  }
  return { ok: true };
}

/**
 * 目录条目完整校验（生成器/目录护栏口径，fail-closed）
 *
 * 在元数据合法性之上拒绝一切写条目：动态写确认链未实现，
 * dynamicWriteCapability 声明也不开放——唯一开放条件是先落地 preview/confirm/幂等。
 */
export function validateDynamicToolDef(
  def: ApiRouteDef,
): DynamicToolDefVerdict {
  const meta = validateMetadata(def);
  if (!meta.ok) return meta;
  if (def.isWriteOperation) {
    return {
      ok: false,
      reason:
        '动态 API 写能力未开放：preview/confirm 二段式与幂等契约未实现（fail-closed），' +
        'dynamicWriteCapability 声明不构成开放条件',
    };
  }
  return { ok: true };
}

@Injectable()
export class DynamicApiTool implements ITool {
  private readonly logger: Logger;
  /** 目录定义冻结快照：注册后篡改原 def 对象无法解除执行闸 */
  private readonly def: ApiRouteDef;

  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly parameters: object;
  readonly isWriteOperation: boolean;
  readonly risk: ToolRisk;
  readonly needsReview?: boolean;
  readonly scope?: ToolScope;

  constructor(
    private readonly serviceClient: ServiceClient,
    def: ApiRouteDef,
  ) {
    // 非法元数据构造期拒绝（fail-closed：坏对象不允许存在可执行实例）。
    // 写条目不在构造期拒绝——统一走 execute() 执行闸（零 HTTP 写请求），
    // 保证「绕过生成器直接构造」路径也有独立活靶防线。
    const meta = validateMetadata(def);
    if (!meta.ok) {
      throw new Error(
        `DynamicApiTool 定义拒绝（fail-closed）：name=${def?.name ?? '<空>'} reason=${meta.reason}`,
      );
    }
    this.logger = new Logger(`DynamicApi:${def.name}`);
    this.def = Object.freeze({ ...def });
    this.name = def.name;
    this.description = def.description;
    this.category = def.category;
    this.parameters = def.parameters;
    this.isWriteOperation = def.isWriteOperation;
    this.risk = def.risk;
    this.needsReview = def.needsReview;
    this.scope = def.scope ?? 'mgmt';
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // 执行闸（纵深防御）：即使绕过生成器直接构造写条目实例，也零 HTTP 写请求
    if (this.def.isWriteOperation) {
      const reason =
        '动态 API 写能力未开放：preview/confirm 二段式与幂等契约未实现（fail-closed）';
      this.logger.warn(
        `动态写条目已拒绝执行：tool=${this.def.name} method=${this.def.method} ` +
          `path=${this.def.path} tenant=${context?.tenantId ?? '-'} reason=${reason}`,
      );
      return {
        success: false,
        error: `工具 ${this.name} 已拒绝执行：${reason}`,
        suggestion:
          '如需写能力，须先实现动态写 preview/confirm 与幂等契约并显式声明能力',
      };
    }
    try {
      // 1. 路径占位符替换 + 参数分流（GET→query，其余→body）
      let path = this.def.path;
      const query: Record<string, unknown> = {};
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (path.includes(`{${key}}`)) {
          path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
        } else if (this.def.method === 'GET') {
          query[key] = value;
        } else {
          body[key] = value;
        }
      }

      // 2. 调用后端真实端点
      let data: unknown;
      switch (this.def.method) {
        case 'GET':
          data = await this.serviceClient.get(path, context, {
            params: query,
          });
          break;
        case 'POST':
          data = await this.serviceClient.post(path, body, context);
          break;
        case 'PUT':
          data = await this.serviceClient.put(path, body, context);
          break;
        case 'DELETE':
          data = await this.serviceClient.delete(path, context);
          break;
      }

      return { success: true, data };
    } catch (err) {
      // TODO(P1-D): 本处降级值依赖异常本身（error 需携带 err.message 给模型），
      // 而 degrade() 的 fallback 是静态值、拿不到 err。
      // 待 degrade 增补「带错误上下文的 fallback」能力（如 degrade(op, (err) => fallback, ctx)）后再迁。
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${this.def.method} ${this.def.path} 失败：${message}`);
      return {
        success: false,
        error: `调用 ${this.name} 失败：${message}`,
        suggestion: '请检查参数是否完整或稍后重试',
      };
    }
  }
}
