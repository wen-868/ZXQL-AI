/**
 * CryptoService 单元测试
 *
 * 验证 AES-256-GCM 加密/解密/安全解密/密钥校验等核心能力。
 */
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

function createConfigService(encryptionKey: string): ConfigService {
  const mock: Partial<ConfigService> = {
    get: jest.fn((key: string) => {
      if (key === 'ENCRYPTION_KEY') return encryptionKey;
      return undefined;
    }),
  };
  return mock as ConfigService;
}

describe('CryptoService', () => {
  const validKey =
    '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

  describe('构造校验', () => {
    it('ENCRYPTION_KEY 未配置时应抛异常', () => {
      expect(() => new CryptoService(createConfigService(''))).toThrow(
        'ENCRYPTION_KEY 未配置',
      );
    });

    it('ENCRYPTION_KEY 长度不足应抛异常', () => {
      const shortKey = 'aabbccdd';
      expect(() => new CryptoService(createConfigService(shortKey))).toThrow(
        '长度必须为 32 字节',
      );
    });

    it('ENCRYPTION_KEY 为占位符时应抛异常（AUDIT-REPORT R3）', () => {
      const placeholderKeys = [
        'CHANGE_ME_GENERATE_32_BYTE_HEX_KEY',
        'your-encryption-key',
        'your_encryption_key',
        'REPLACE_ME',
        '<请替换为真实值>',
        'xxx_placeholder_xxx',
      ];
      for (const key of placeholderKeys) {
        expect(() => new CryptoService(createConfigService(key))).toThrow(
          'ENCRYPTION_KEY 仍为占位符',
        );
      }
    });
  });

  describe('encrypt / decrypt', () => {
    let service: CryptoService;

    beforeEach(() => {
      service = new CryptoService(createConfigService(validKey));
    });

    it('加密后解密应还原明文', () => {
      const plaintext = 'sk-deepseek-abc123xyz';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('加密结果应与明文不同', () => {
      const plaintext = 'my-secret-api-key';
      const encrypted = service.encrypt(plaintext);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(':');
    });

    it('每次加密结果应不同（IV 随机）', () => {
      const plaintext = 'same-key';
      const enc1 = service.encrypt(plaintext);
      const enc2 = service.encrypt(plaintext);

      expect(enc1).not.toBe(enc2);
    });

    it('加密格式应为 iv:authTag:ciphertext', () => {
      const encrypted = service.encrypt('test');
      const parts = encrypted.split(':');

      expect(parts).toHaveLength(3);
    });

    it('空字符串也应能加解密', () => {
      const encrypted = service.encrypt('');
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe('');
    });

    it('中文字符串也应能加解密', () => {
      const plaintext = '智享AI底座加密测试';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('decryptSafe', () => {
    let service: CryptoService;

    beforeEach(() => {
      service = new CryptoService(createConfigService(validKey));
    });

    it('null 输入返回 null', () => {
      expect(service.decryptSafe(null)).toBeNull();
    });

    it('undefined 输入返回 null', () => {
      expect(service.decryptSafe(undefined)).toBeNull();
    });

    it('空字符串输入返回 null', () => {
      expect(service.decryptSafe('')).toBeNull();
    });

    it('格式错误的密文返回 null（不抛异常）', () => {
      expect(service.decryptSafe('invalid-data')).toBeNull();
    });

    it('正确的密文返回明文', () => {
      const encrypted = service.encrypt('secret');
      expect(service.decryptSafe(encrypted)).toBe('secret');
    });
  });

  describe('不同密钥解密应失败', () => {
    it('用密钥 A 加密，用密钥 B 解密应抛异常', () => {
      const keyA = 'a'.repeat(64);
      const keyB = 'b'.repeat(64);
      const serviceA = new CryptoService(createConfigService(keyA));
      const serviceB = new CryptoService(createConfigService(keyB));

      const encrypted = serviceA.encrypt('secret');
      expect(() => serviceB.decrypt(encrypted)).toThrow();
    });
  });
});
