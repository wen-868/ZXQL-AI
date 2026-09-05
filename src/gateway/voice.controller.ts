/**
 * Voice Controller — 语音对话网关（手机端必备）
 *
 * - POST /api/voice/tts：文字 → mp3 音频（微软 Edge TTS，免费无 Key）
 * - POST /api/voice/asr：音频 → 文字（云端识别网关，需配置服务商后启用；
 *   当前手机端使用系统/浏览器原生语音识别，接口返回 501 明确提示）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../tenant/admin-auth.guard';
import { VoiceService } from '../providers/voice.service';

@UseGuards(JwtGuard)
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** 文字转语音（mp3 base64） */
  @Post('tts')
  async tts(@Body() dto: { text?: string }): Promise<{
    code: string;
    msg: string;
    data?: { audio: string; format: string };
  }> {
    const text = typeof dto?.text === 'string' ? dto.text.trim() : '';
    if (!text) {
      return { code: '400', msg: '参数 text 必填' };
    }
    const result = await this.voice.tts(text);
    if (!result) {
      return {
        code: '501',
        msg: '语音合成服务未配置或暂时不可用（已切换系统语音播报）',
      };
    }
    return {
      code: '0',
      msg: '成功',
      data: { audio: result.audioBase64, format: result.format },
    };
  }

  /** 语音转文字（网关预留：云端 ASR 需配置服务商） */
  @Post('asr')
  asr(): { code: string; msg: string } {
    return {
      code: '501',
      msg: '云端语音识别未配置，手机端请使用系统/浏览器原生语音识别',
    };
  }
}
