/**
 * VisionService — 图片理解（感知·看）
 *
 * 调用智谱视觉模型（glm-4v-flash，免费）生成图片内容描述，
 * 供对话链路把"图片感知"转成文本上下文（当前 LLM 主链路为纯文本）。
 *
 * 环境变量：复用 GLM_BASE_URL / GLM_API_KEY；模型默认 glm-4v-flash，
 * 可通过 GLM_VISION_MODEL 覆盖。
 *
 * 降级：GLM_API_KEY 未配置或调用失败时返回 null，对话不阻塞（图片描述缺失）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const DEFAULT_VISION_MODEL = 'glm-4v-flash';

interface VisionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (configService.get<string>('GLM_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    this.apiKey = configService.get<string>('GLM_API_KEY', '') ?? '';
    this.model = configService.get<string>(
      'GLM_VISION_MODEL',
      DEFAULT_VISION_MODEL,
    );
    this.timeoutMs = configService.get<number>('GLM_TIMEOUT_MS', 30000);
  }

  /**
   * 是否已配置视觉模型（GLM_API_KEY 非空即可用）
   */
  isEnabled(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0;
  }

  /**
   * 生成图片内容描述
   *
   * @param imageBase64 图片 base64（可含 data:image/*;base64, 前缀，兼容裸 base64）
   * @param prompt      引导词（默认：识别图片内容，输出中文描述）
   * @returns 描述文本；未配置/失败返回 null（调用方降级）
   */
  async describeImage(
    imageBase64: string,
    prompt = '请识别这张图片的内容，用中文简洁描述（如单据/商品/场景，关键信息如商品名、数量、金额）。',
  ): Promise<string | null> {
    if (!this.isEnabled()) {
      this.logger.warn('GLM_API_KEY 未配置，图片理解降级跳过');
      return null;
    }
    const dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    try {
      const response = await axios.post<VisionResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl },
                },
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        },
      );
      const content = response.data?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        this.logger.warn('视觉模型返回空描述');
        return null;
      }
      return content;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`图片理解失败（降级跳过）：${detail}`);
      return null;
    }
  }
}
