/**
 * WriteGuardActionDto × 显式幂等键 校验测试（R101-AI-24）
 *
 * 证据用途：证明 HTTP 接入层（`POST /api/ai/agent/confirm`）对 `idempotencyKey`
 * 有**格式校验 + 长度上限**，不合规会被 class-validator 拦下 ⇒ GlobalValidationPipe
 * 返回 400 与明确 message（不是静默忽略）。
 *
 * 与闸门共用同一正则（`EXPLICIT_KEY_PATTERN`，唯一真源），避免两处规则漂移。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WriteGuardActionDto } from './write-guard.dto';

function toDto(body: Record<string, unknown>): WriteGuardActionDto {
  return plainToInstance(WriteGuardActionDto, body);
}

async function keyErrors(idempotencyKey: unknown): Promise<string[]> {
  const errors = await validate(
    toDto({ token: 'wg_token_1', action: 'confirm', idempotencyKey }),
  );
  const keyField = errors.find((e) => e.property === 'idempotencyKey');
  return keyField ? Object.values(keyField.constraints ?? {}) : [];
}

describe('WriteGuardActionDto · idempotencyKey（R101-AI-24）', () => {
  it('合法键（8~128、字母数字开头、[A-Za-z0-9._:-]）⇒ 无校验错误', async () => {
    await expect(keyErrors('ERP2026-0001')).resolves.toEqual([]);
    await expect(keyErrors('a1234567')).resolves.toEqual([]); // 恰好 8 字符
    await expect(keyErrors(`K${'x'.repeat(127)}`)).resolves.toEqual([]); // 恰好 128
  });

  it('不传 ⇒ 可选字段，无校验错误（行为零变化）', async () => {
    const errors = await validate(
      toDto({ token: 'wg_token_1', action: 'confirm' }),
    );
    expect(errors).toEqual([]);
  });

  it('非法/超长键 ⇒ 被拒且带明确 message（HTTP 层 400 依据）', async () => {
    const tooShort = await keyErrors('ERP-1');
    expect(tooShort).toHaveLength(1);
    expect(tooShort[0]).toContain('8~128 字符');

    const illegalChars = await keyErrors('ERP 2026#0001');
    expect(illegalChars).toHaveLength(1);

    const tooLong = await keyErrors(`K${'x'.repeat(128)}`);
    expect(tooLong).toHaveLength(1);

    const notString = await keyErrors(12345678);
    expect(notString.length).toBeGreaterThanOrEqual(1);
  });

  it('token/action 既有契约未被破坏（缺 token 仍必填、action 仍枚举）', async () => {
    const missingToken = await validate(
      toDto({ action: 'confirm', idempotencyKey: 'ERP2026-0001' }),
    );
    expect(missingToken.map((e) => e.property)).toContain('token');

    const badAction = await validate(
      toDto({ token: 'wg_token_1', action: 'nope' }),
    );
    expect(badAction.map((e) => e.property)).toContain('action');
  });
});
