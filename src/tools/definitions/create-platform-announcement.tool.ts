/**
 * api_platform_create_announcement 工具 — 创建平台公告（总台写操作，预览确认）
 *
 * 对应后端 API：POST /api/platform/announcements（requirePlatformAuth）
 * 后端校验（platform-announcement.controller.ts createAnnouncement zod schema）：
 * - title(必填)、type(必填)、content(必填)、isTop(默认0)、status(默认0)
 *
 * scope = 'platform'：仅总台对话（scope=platform）暴露，租户侧绝不出现。
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式创建。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

@Injectable()
export class CreatePlatformAnnouncementTool implements ITool {
  private readonly logger = new Logger(CreatePlatformAnnouncementTool.name);

  readonly name = 'api_platform_create_announcement';
  readonly description =
    '创建平台公告（总台写操作，需用户确认）：发布平台级公告/通知。' +
    '入参：title(标题)、type(类型)、content(内容)、isTop(是否置顶,可选)、status(状态,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'platform' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  readonly scope = 'platform' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '公告标题（必填）' },
      type: {
        type: 'string',
        description: '公告类型（必填，如 SYSTEM/NOTICE/MAINTENANCE）',
      },
      content: { type: 'string', description: '公告内容（必填）' },
      isTop: { type: 'number', description: '是否置顶（可选，0/1）' },
      status: { type: 'number', description: '状态（可选，0=草稿/1=发布）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['title', 'type', 'content'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = args.title;
    const type = args.type;
    const content = args.content;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return {
        success: false,
        error: '参数 title 必填',
        suggestion: '请提供公告标题',
      };
    }
    if (typeof type !== 'string' || type.trim().length === 0) {
      return {
        success: false,
        error: '参数 type 必填',
        suggestion: '请提供公告类型',
      };
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return {
        success: false,
        error: '参数 content 必填',
        suggestion: '请提供公告内容',
      };
    }
    const isTop = args.isTop === undefined ? 0 : Number(args.isTop);
    const status = args.status === undefined ? 0 : Number(args.status);
    const confirm = args.confirm === true;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '创建平台公告',
          summary: `发布平台公告「${title.trim()}」（${type.trim()}）`,
          details: {
            title: title.trim(),
            type: type.trim(),
            content: content.trim(),
            isTop,
            status,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.PLATFORM_ANNOUNCEMENTS,
        {
          title: title.trim(),
          type: type.trim(),
          content: content.trim(),
          isTop,
          status,
        },
        context,
      );
      this.logger.log(`创建平台公告成功：${title.trim()}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建平台公告失败：${msg}`);
      return {
        success: false,
        error: `创建平台公告失败：${msg}`,
        suggestion: '请使用总台账号会话操作，或检查公告内容',
      };
    }
  }
}
