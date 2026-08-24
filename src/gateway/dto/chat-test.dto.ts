import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * 对话测试 DTO（R70-03 验收用，R70-06 将被正式 ChatDto 替代）
 */
export class ChatTestDto {
  /** 用户消息内容 */
  @IsString({ message: 'message 必须是字符串' })
  @IsNotEmpty({ message: 'message 不能为空' })
  @MaxLength(2000, { message: 'message 不能超过 2000 字符' })
  message!: string;
}
