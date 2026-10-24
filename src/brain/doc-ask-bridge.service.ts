/**
 * DocAskBridge — 文档问答执行桥（AI-P1-3，Brain 侧）
 *
 * 职责：把 tools 叶子 `DocAskRunner` 的 ask() 接到真实 LLM 路由
 * （ProviderRouterService.chatSyncWithFallback：租户配置 + 降级链 + 超时中止）。
 *
 * 为什么用回调注册而不是工具直接注入 ProviderRouterService（硬约束 1）：
 * - ProviderRouterService 在 BrainModule，BrainModule 已 import ToolsModule
 *   ⇒ 反向注入 = ToolsModule → BrainModule → ToolsModule **成环**
 *   （R101-AI-47 实测踩过的 circular dependency）。
 * - 本桥在 **Brain 侧**（合法依赖两侧）于 onModuleInit 把实现塞进叶子 holder，
 *   方向与 EmployeeTaskBridge.setTaskRunner 完全同构（范式已验证）。
 *
 * 商户安全线：LLM 失败时**原样抛错**给工具层降级为失败结果——
 * 桥这一层绝不吞错返回空串（会被当成"文档没答案"的假成功）。
 *
 * 负责人: 阿澈 | 创建日期: 2026-10-24
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiConfigService } from '../tenant/ai-config.service';
import { ProviderRouterService } from './router/provider-router.service';
import type { ChatMessage } from '../providers/provider.interface';
import {
  DocAskInput,
  DocAskOutput,
  DocAskRunner,
} from '../tools/doc-ask-runner';

@Injectable()
export class DocAskBridge implements OnModuleInit {
  private readonly logger = new Logger(DocAskBridge.name);

  constructor(
    private readonly runner: DocAskRunner,
    private readonly router: ProviderRouterService,
    private readonly aiConfig: AiConfigService,
  ) {}

  onModuleInit(): void {
    this.runner.setRunner(async (input) => this.ask(input));
    this.logger.log('文档问答执行器已注册（DocAskRunner ← DocAskBridge）');
  }

  private async ask(input: DocAskInput): Promise<DocAskOutput> {
    // 出处锚点说明写进 prompt：模型按 [n] 引用，n 与工具侧 citations 的 index 对齐
    const passagesText = input.passages
      .map((p) => `[${p.index}] ${p.text}`)
      .join('\n\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `你是文档问答助手。只依据用户消息中提供的《${input.docTitle}》原文片段回答问题。` +
          '规则：①原文没有的信息，回答"文档中未提及"，不得脑补、不得用常识补全；' +
          '②回答用中文，简明直接；③引用依据时在句末标注片段编号，如 [1][3]；' +
          '④不要复述整段原文。',
      },
      {
        role: 'user',
        content: `问题：${input.question}\n\n原文片段：\n${passagesText}`,
      },
    ];

    // RouteInput 装配照抄 planner.service.ts 范式（租户配置 + 系统形态）
    const resolved = await this.aiConfig.getResolvedConfig();
    const result = await this.router.chatSyncWithFallback(
      messages,
      { temperature: 0.2, max_tokens: 1024 },
      {
        resolved,
        systemScope: this.router.getSystemScope(),
      },
    );

    return {
      answer: result.content ?? '',
      provider: result.fallback?.to ?? 'default',
      fallbackUsed: result.fallback?.used ?? false,
    };
  }
}
