/**
 * ExecuteToolDto 校验测试（R101-AI-28）
 *
 * 缺陷：`POST /api/admin/tools/execute` 缺 `context` 时，`@ValidateNested()` 对
 * `undefined` **不报错** ⇒ controller 读 `dto.context.tenantId` 抛 TypeError ⇒ **500**。
 * 修复：补 `@IsDefined()` ⇒ 缺 context ⇒ **400**（与全仓 ValidationPipe 一致）。
 *
 * 本文件用与 `main.ts:42-44` 相同的 ValidationPipe 配置（transform + whitelist）
 * 断言"管道层拒绝"，即真实 HTTP 400 的依据。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-13
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExecuteToolDto } from './execute-tool.dto';

/** 与 main.ts 一致的全局管道配置（transform + whitelist） */
const pipe = new ValidationPipe({ transform: true, whitelist: true });

async function runPipe(body: unknown): Promise<ExecuteToolDto> {
  return pipe.transform(body, {
    type: 'body',
    metatype: ExecuteToolDto,
  }) as Promise<ExecuteToolDto>;
}

describe('ExecuteToolDto（R101-AI-28：缺 context 必须 400）', () => {
  it('缺 context ⇒ 管道抛 BadRequestException（HTTP 400，不再是 500）', async () => {
    await expect(
      runPipe({ name: 'queryInventory', args: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      await runPipe({ name: 'queryInventory', args: {} });
    } catch (err) {
      const response = (err as BadRequestException).getResponse() as {
        message?: string[];
      };
      expect(JSON.stringify(response.message)).toContain('context');
    }
  });

  it('context 为空对象（缺 tenantId）⇒ 400（嵌套校验生效）', async () => {
    await expect(
      runPipe({ name: 'queryInventory', args: {}, context: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('合法请求 ⇒ 通过校验并得到 DTO 实例', async () => {
    const dto = await runPipe({
      name: 'queryInventory',
      args: {},
      context: { tenantId: 'tenant-A', userId: '1' },
    });
    expect(dto).toBeInstanceOf(ExecuteToolDto);
    expect(dto.context.tenantId).toBe('tenant-A');
  });

  it('class-validator 层：缺 context 的校验错误明确指向 context 字段', async () => {
    const errors = await validate(
      plainToInstance(ExecuteToolDto, {
        name: 'queryInventory',
        args: {},
      }),
    );
    const contextError = errors.find((e) => e.property === 'context');
    expect(contextError).toBeDefined();
    expect(Object.values(contextError?.constraints ?? {}).join(' ')).toContain(
      'context 不能为空',
    );
  });
});
