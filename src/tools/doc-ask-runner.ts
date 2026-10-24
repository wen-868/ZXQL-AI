/**
 * DocAskRunner — 文档问答执行器的**注册槽**（AI-P1-3，叶子件）
 *
 * 为什么是 holder 而不是直接注入 ProviderRouterService（硬约束 1 的落点）：
 * - `ProviderRouterService` 在 BrainModule，而 BrainModule 已 `import ToolsModule`
 *   ⇒ 工具直接注入它 = `ToolsModule → BrainModule → ToolsModule` **成环**
 *   （R101-AI-47 readiness 单实测踩过：`circular dependency`，靠"被依赖方下沉叶子"解）。
 * - 本类是**零依赖叶子**（不 import 任何 brain/rag 服务）；Brain 侧 `DocAskBridge`
 *   在 `onModuleInit` 把真实现经 `setRunner()` 注入（与 `EmployeeTaskBridge`
 *   注册 taskRunner 完全同构，范式已被本仓验证）。
 *
 * 未注册时 `ask()` 抛错 ⇒ 工具走"模型不可用"降级分支（**不编造答案**），
 * 这与 aiDocSearch 的 @Optional 降级语义一致：增强缺失只降级，不伪装成功。
 *
 * 负责人: 阿澈 | 创建日期: 2026-10-24（AI-P1-3）
 */
import { Injectable, Logger } from '@nestjs/common';

/** 一次问答的输入（正文由工具层取出后传入，Runner 不碰数据访问） */
export interface DocAskInput {
  tenantId: string;
  docId: string;
  docTitle: string;
  question: string;
  /** 原文片段（已按 chunkIndex 排序并截断；编号即引用出处） */
  passages: Array<{ index: number; chunkIndex: number; text: string }>;
}

/** Runner 返回（answer 文本；provider 与降级事实供可观测） */
export interface DocAskOutput {
  answer: string;
  /** 实际服务的 provider 名（降级后为兜底者） */
  provider: string;
  /** 是否发生降级 */
  fallbackUsed: boolean;
}

/** 执行器签名（Bridge 注入；类型上只依赖本文件，防成环） */
export type DocAskFn = (input: DocAskInput) => Promise<DocAskOutput>;

@Injectable()
export class DocAskRunner {
  private readonly logger = new Logger(DocAskRunner.name);
  private fn?: DocAskFn;

  /** Brain 侧 Bridge 在 onModuleInit 注册（后注册覆盖，仅应发生一次） */
  setRunner(fn: DocAskFn): void {
    if (this.fn) {
      this.logger.warn(
        'DocAskRunner 重复注册执行器（不应发生，检查 Bridge 装配）',
      );
    }
    this.fn = fn;
  }

  /** 是否已装配（诊断/测试用） */
  isRegistered(): boolean {
    return this.fn !== undefined;
  }

  async ask(input: DocAskInput): Promise<DocAskOutput> {
    if (!this.fn) {
      throw new Error('文档问答执行器未注册（DocAskBridge 未装配）');
    }
    return this.fn(input);
  }
}
