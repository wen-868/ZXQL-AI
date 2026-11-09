/**
 * AI-SECURITY-BASELINE-01 哨兵测试（四类，mutation 点名对象）
 *
 * 1. crypto 占位密钥黑名单：PLACEHOLDER_MARKERS 少一条 ⇒ 假密钥可绕过启动拒绝
 * 2. outbound-target.guard：isBlockedIp 对回环/内网/保留地址保守拒绝、公网放行
 * 3. bench-auth 出站守卫：postJson 拒绝非 http(s) 与非本地/内网主机
 * 4. 工具调用 ID 加固：agent/v2 四文件经 randomUUID 生成（不含 Math.random 指纹）
 *
 * 负责人: 阿洲 | 创建日期: 2026-10-30
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- CommonJS 脚本无类型声明，经显式类型注接收窄 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isBlockedIp } from './common/outbound-target.guard';

const ROOT = join(__dirname, '..');

describe('AI-SECURITY-BASELINE-01 哨兵', () => {
  it('哨兵1 crypto：占位密钥黑名单条目齐全（change_me/changeme/your-encryption-key/replace_me/placeholder）', () => {
    // mutation 点名：删除任一黑名单条目 ⇒ 本用例红（条目为模块常量，源码级断言）
    const src = readFileSync(
      join(ROOT, 'src/tenant/crypto.service.ts'),
      'utf8',
    );
    for (const marker of [
      'change_me',
      'changeme',
      'your-encryption-key',
      'your_encryption_key',
      'replace_me',
      'placeholder',
    ]) {
      expect(src).toContain(`'${marker}'`);
    }
  });

  it('哨兵2 outbound-target.guard：回环/内网/保留地址保守拒绝，公网放行', () => {
    for (const blocked of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.9',
      '169.254.169.254', // 云元数据
      '::1',
      '0.0.0.0',
    ]) {
      expect(isBlockedIp(blocked)).toBe(true);
    }
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    // 无法解析 ⇒ 保守拒绝
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });

  it('哨兵3 bench-auth：出站守卫存在且限本机/内网（源码级 + 行为级）', () => {
    // 源码级：assertOutboundAllowed 守卫存在且校验协议与主机
    const src = readFileSync(join(ROOT, 'scripts/lib/bench-auth.js'), 'utf8');
    expect(src).toContain('assertOutboundAllowed(url)');
    expect(src).toMatch('/^https?:$/.test(u.protocol)');
    expect(src).toContain('isLocalish(u.hostname)');

    // 行为级：直接加载脚本模块跑导出的守卫（CommonJS 经 createRequire）
    const bench: {
      assertOutboundAllowed: (url: string) => void;
    } = createRequire(__filename)(join(ROOT, 'scripts/lib/bench-auth.js'));
    const rejects = (url: string) =>
      expect(() => bench.assertOutboundAllowed(url)).toThrow();
    rejects('ftp://127.0.0.1:8080/x');
    rejects('https://evil.example.com/login');
    rejects('not-a-url');
    // 本机放行不抛
    expect(() =>
      bench.assertOutboundAllowed('http://127.0.0.1:8080/api'),
    ).not.toThrow();
  });

  it('哨兵4 ID 加固：agent/v2 四文件工具调用 ID 经 randomUUID（Math.random 指纹清零）', () => {
    for (const rel of [
      'src/brain/agent/planner.service.ts',
      'src/brain/agent/task-runner.service.ts',
      'src/brain/v2/report.service.ts',
      'src/brain/v2/v2-handle.service.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).toContain('randomUUID()');
      // mutation 点名：改回 Math.random().toString(36) ⇒ 本用例红
      expect(src).not.toContain('Math.random().toString(36)');
    }
  });
});
