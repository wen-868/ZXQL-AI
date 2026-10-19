/**
 * EmployeeTodoSyncService 单元测试 —— R101-AI-46
 *
 * 覆盖：原子迁移（affected>0 / =0 两种）、回放（已是 done）、不存在、
 *      异常吞掉不抛（主次不倒置）
 */
import { EmployeeTodoSyncService } from './employee-todo-sync.service';
import type { Repository } from 'typeorm';
import { Not } from 'typeorm';
import type { AiTodoEntity } from '../../database/entities/ai-todo.entity';

describe('EmployeeTodoSyncService（R101-AI-46 待办回写）', () => {
  let service: EmployeeTodoSyncService;
  let repo: {
    update: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      update: jest.fn(),
      findOne: jest.fn(),
    };
    service = new EmployeeTodoSyncService(
      repo as unknown as Repository<AiTodoEntity>,
    );
  });

  it('① affected>0 ⇒ changed=true（真正改了状态）', async () => {
    repo.update.mockResolvedValue({ affected: 1 });

    const r = await service.markDone('t1', '99', '任务完成');

    expect(r).toEqual({ changed: true });
    // 🔴 原子条件必须含 status Not('done')（不先读后写，并发下只一个请求改成功）
    expect(repo.update).toHaveBeenCalledWith(
      {
        id: '99',
        tenantId: 't1',
        status: Not('done'),
      },
      { status: 'done' },
    );
    // changed 时不需要再查一次
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('② affected=0 且已是 done ⇒ replayed=true（幂等，不重复改）', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue({ id: '99', status: 'done' });

    const r = await service.markDone('t1', '99', '任务完成');

    expect(r).toEqual({ changed: false, replayed: true });
  });

  it('③ affected=0 且待办不存在 ⇒ notFound=true（不抛）', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue(null);

    const r = await service.markDone('t1', '99', '任务完成');

    expect(r).toEqual({ changed: false, notFound: true });
  });

  it('④ update 抛异常 ⇒ 吞掉返回 error（绝不外抛，主次不倒置）', async () => {
    repo.update.mockRejectedValue(new Error('DB 连接丢失'));

    const r = await service.markDone('t1', '99', '任务完成');

    expect(r.changed).toBe(false);
    expect(r.error).toContain('DB 连接丢失');
  });

  it('⑤ findOne 抛异常（affected=0 后的二次查询）也吞掉', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockRejectedValue(new Error('DB 抖动'));

    const r = await service.markDone('t1', '99', '任务完成');

    expect(r.changed).toBe(false);
    expect(r.error).toContain('DB 抖动');
  });
});
