/**
 * VoiceService — 语音合成网关（输出·说，手机端语音对话必备）
 *
 * TTS 提供商（TTS_PROVIDER）：
 * - xunfei：讯飞在线语音合成（国内稳定，有免费额度），需配置
 *   XF_APP_ID / XF_API_KEY / XF_API_SECRET / XF_VOICE（默认 xiaoyan）
 * - none（默认）：未配置时返回 null，前端自动降级系统语音（H5 speechSynthesis / App plus.speech）
 *
 * ASR：网关预留（讯飞/阿里等云端识别需配置），当前手机端用系统/浏览器原生识别。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'crypto';
import axios from 'axios';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 文本转语音（mp3 base64）
   *
   * @param text 待合成文本（≤1000 字）
   * @returns { audioBase64, format }；失败/未配置返回 null（前端降级系统语音）
   */
  async tts(
    text: string,
  ): Promise<{ audioBase64: string; format: 'mp3' } | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const payload = trimmed.slice(0, 1000);

    const provider = this.config.get<string>('TTS_PROVIDER', 'none');
    switch (provider) {
      case 'xunfei':
        return this.xunfeiTts(payload);
      default:
        this.logger.debug(
          'TTS_PROVIDER 未配置（none），降级为前端系统语音播报',
        );
        return null;
    }
  }

  /** 讯飞在线语音合成（WebAPI v2，输出 mp3） */
  private async xunfeiTts(
    text: string,
  ): Promise<{ audioBase64: string; format: 'mp3' } | null> {
    const appId = this.config.get<string>('XF_APP_ID', '');
    const apiKey = this.config.get<string>('XF_API_KEY', '');
    const apiSecret = this.config.get<string>('XF_API_SECRET', '');
    if (!appId || !apiKey || !apiSecret) {
      this.logger.warn(
        '讯飞 TTS 未配置完整（XF_APP_ID/XF_API_KEY/XF_API_SECRET）',
      );
      return null;
    }
    const voice = this.config.get<string>('XF_VOICE', 'xiaoyan');
    const timeoutMs = this.config.get<number>('TTS_TIMEOUT_MS', 15000);

    try {
      const url = this.buildXunfeiUrl(apiKey, apiSecret);
      const response = await axios.post<{
        code: number;
        message?: string;
        data?: { audio?: string; status?: number };
      }>(
        url,
        {
          common: { app_id: appId },
          business: {
            aue: 'lame',
            sfl: 1,
            vcn: voice,
            tte: 'UTF8',
            speed: 50,
          },
          data: {
            status: 2,
            text: Buffer.from(text, 'utf8').toString('base64'),
          },
        },
        { timeout: timeoutMs },
      );

      const body = response.data;
      if (body.code !== 0 || !body.data?.audio) {
        this.logger.warn(
          `讯飞 TTS 返回错误：${body.code} ${body.message ?? ''}`,
        );
        return null;
      }
      return { audioBase64: body.data.audio, format: 'mp3' };
    } catch (err) {
      this.logger.warn(
        `讯飞 TTS 合成失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 讯飞鉴权 URL（HMAC-SHA256 签名） */
  private buildXunfeiUrl(apiKey: string, apiSecret: string): string {
    const host = 'tts-api.xfyun.cn';
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v2/tts HTTP/1.1`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(signatureOrigin)
      .digest('base64');
    const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    return `https://${host}/v2/tts?authorization=${encodeURIComponent(
      authorization,
    )}&date=${encodeURIComponent(date)}&host=${host}`;
  }
}
