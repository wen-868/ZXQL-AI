/**
 * NoticeBridgeService 测试 —— R101-AI-40（落通知与推送的关系）
 *
 * 🔴 本文件的核心是**语义纠正的承重验证**（凌舟裁定 ②）：
 * ① **先落通知 → 再推送**（次序断言：调用顺序）
 * ② 🔴 **推送失败（`ok=false`）⇒ 通知仍然落库**（mutation：加回 `if (pushOk)` 包裹 ⇒ 本例如红）
 *    准确的"为什么"：`push()` 的 `ok=false` **只意味着 `t_push_log` INSERT 失败**，而 `t_push_log` 是
 *    **跨线审计表（MS 拥有）** ⇒ 它故障时，"站内通知"这条**本应独立的持久化兜底**绝不能被连带失效；
 *    而"push_log 写不进去"正是站内通知**最该顶上**的时刻。
 * （注：`broadcast` 失败不改 `ok` ⇒ 离线用户 `ok` 仍为 true；故"离线丢消息"不适用作本纠正的理由。）
 * ③ `notice.record` 抛错 ⇒ **不影响** 推送与返回值（主次不倒置）
 * ④ 去重键/receiver/source/refId 如实透传（供通知中心归属与去重）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { NoticeBridgeService } from './notice-bridge.service';
import { NoticeService } from './notice.service';
import { ProactivePushService } from './proactive-push.service';

const PUSH = {
  title: '日程提醒：季度复盘会',
  content: '14:00 开始',
  type: 'system' as const,
  priority: 'reminder' as const,
};
const CTX = {
  receiver: 'user:u-1,user:u-2',
  source: 'schedule' as const,
  refId: '12',
  dedupeKey: 'schedule:12:2026-10-20T05:30:00.000Z',
};

function createHarness(
  o: { pushOk?: boolean; recordThrows?: boolean; inserted?: boolean } = {},
) {
  const calls: string[] = [];
  const record = jest.fn(() => {
    calls.push('record');
    if (o.recordThrows) return Promise.reject(new Error('通知表不可用'));
    return Promise.resolve({ inserted: o.inserted ?? true, noticeId: 'n1' });
  });
  const push = jest.fn(() => {
    calls.push('push');
    return Promise.resolve(o.pushOk ?? true);
  });
  const svc = new NoticeBridgeService(
    { record } as unknown as NoticeService,
    { push } as unknown as ProactivePushService,
  );
  return { svc, record, push, calls };
}

describe('NoticeBridgeService（R101-AI-40 落通知 × 推送）', () => {
  it('① 次序：先落通知，再推送', async () => {
    const h = createHarness();

    const ok = await h.svc.pushWithNotice('t1', 'schedule_reminder', PUSH, CTX);

    expect(ok).toBe(true);
    expect(h.calls).toEqual(['record', 'push']);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it('② 🔴 推送失败 ⇒ 通知**仍然落库**（离线用户不丢）', async () => {
    const h = createHarness({ pushOk: false });

    const ok = await h.svc.pushWithNotice('t1', 'schedule_reminder', PUSH, CTX);

    expect(ok).toBe(false); // 返回值语义 = 实时推送结果
    expect(h.record).toHaveBeenCalledTimes(1); // ← 承重：与推送成败**无关**
    // mutation 检验点：改成 `const pushOk = await push(...); if (pushOk) await record(...)` ⇒ 本例红
  });

  it('③ 通知落库失败 ⇒ 不影响推送与返回值（主次不倒置）', async () => {
    const h = createHarness({ recordThrows: true });

    const ok = await h.svc.pushWithNotice('t1', 'schedule_reminder', PUSH, CTX);

    expect(ok).toBe(true); // 推送仍执行且结果如实返回
    expect(h.push).toHaveBeenCalledTimes(1);
    // 说明：record 内部契约是"绝不抛"，此处由 jest 桩抛以验证调用方**也不依赖**其成功
  });

  it('④ 去重键/receiver/source/refId 如实透传', async () => {
    const h = createHarness();

    await h.svc.pushWithNotice('t1', 'schedule_reminder', PUSH, CTX);

    const arg = (
      h.record.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(arg.tenantId).toBe('t1');
    expect(arg.receiver).toBe('user:u-1,user:u-2');
    expect(arg.source).toBe('schedule');
    expect(arg.refId).toBe('12');
    expect(arg.dedupeKey).toBe('schedule:12:2026-10-20T05:30:00.000Z');
    expect(arg.title).toContain('日程提醒');
  });

  it('⑤ 去重命中（inserted=false）⇒ 仍继续推送，返回值不受影响', async () => {
    const h = createHarness({ inserted: false });

    const ok = await h.svc.pushWithNotice('t1', 'schedule_reminder', PUSH, CTX);

    expect(ok).toBe(true);
    expect(h.calls).toEqual(['record', 'push']);
  });
});
