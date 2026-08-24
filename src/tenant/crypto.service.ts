/**
 * CryptoService — API Key 加解密服务
 *
 * 职责：
 * 1. 加密 API Key（AES-256-GCM），存入 t_tenant_ai_config.api_key / t_platform_ai_config.default_api_key
 * 2. 运行时解密 API Key，传给 Provider
 * 3. 密钥来源：ENCRYPTION_KEY 环境变量（32 字节 hex = 256bit）
 *
 * 加密格式：`<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 * - iv：12 字节初始化向量（GCM 推荐长度）
 * - authTag：16 字节认证标签
 * - ciphertext：加密后的密文
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.2 安全设计
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/** IV 长度（GCM 推荐 12 字节） */
const IV_LENGTH = 12;

/** 常见占位密钥标记（命中任一即视为未配置真实密钥，拒绝启动，AUDIT-REPORT R3） */
const PLACEHOLDER_MARKERS = [
  'change_me',
  'changeme',
  'your-encryption-key',
  'your_encryption_key',
  'replace_me',
  'placeholder',
  '请替换',
  'xxx',
];

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  /** 加密密钥 Buffer（32 字节 = 256bit） */
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const hexKey = this.configService.get<string>('ENCRYPTION_KEY');
    if (!hexKey) {
      throw new Error(
        "ENCRYPTION_KEY 未配置，请在 .env 中设置 32 字节 hex 密钥（生成命令：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"）",
      );
    }
    const normalizedKey = hexKey.trim().toLowerCase();
    if (PLACEHOLDER_MARKERS.some((marker) => normalizedKey.includes(marker))) {
      throw new Error(
        'ENCRYPTION_KEY 仍为占位符（如 CHANGE_ME / your-encryption-key），禁止使用占位密钥启动，请生成真实 32 字节 hex 密钥（生成命令：openssl rand -hex 32）',
      );
    }
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY 长度必须为 32 字节（64 位 hex 字符），当前为 ${this.key.length} 字节`,
      );
    }
  }

  /**
   * 加密明文
   *
   * @param plaintext 明文 API Key
   * @returns 加密后的字符串 `<iv_hex>:<authTag_hex>:<ciphertext_hex>`
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * 解密密文
   *
   * @param encrypted 加密字符串 `<iv_hex>:<authTag_hex>:<ciphertext_hex>`
   * @returns 明文 API Key
   * @throws Error 解密失败（密钥错误/数据篡改/格式错误）
   */
  decrypt(encrypted: string): string {
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error(
        '加密数据格式错误，应为 `<iv_hex>:<authTag_hex>:<ciphertext_hex>`',
      );
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * 安全解密：解密失败返回 null 而非抛异常
   *
   * 用于读取数据库中可能为 null 或格式不正确的 API Key 字段，
   * 避免因个别数据问题导致整个请求失败。
   *
   * @param encrypted 加密字符串（可能为 null）
   * @returns 明文 API Key，失败返回 null
   */
  decryptSafe(encrypted: string | null | undefined): string | null {
    if (!encrypted) {
      return null;
    }

    try {
      return this.decrypt(encrypted);
    } catch (err) {
      this.logger.warn(
        `API Key 解密失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
