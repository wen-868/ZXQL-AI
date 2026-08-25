/**
 * CircuitBreakerService — 工具级熔断（P1-3，文档 17.3）
 *
 * 设计原则：Tool 调用微服务故障（超时/5xx/持续失败）不得拖垮 AI 底座，
 * 按工具名独立熔断：
 *
 * - closed（正常）：窗口内失败 < 阈值 → 放行
 * - open（熔断）：窗口内失败 ≥ 阈值 → 拒绝执行（冷却期后进入 half-open）
 * - half-open（半开）：放行单个测试请求；成功 → closed，失败 → 重新 open
 *
 * 配置（env 可覆盖）：
 * - CIRCUIT_FAILURE_THRESHOLD  失败阈值（默认 5）
 * - CIRCUIT_WINDOW_MS          统计窗口（默认 60s）
 * - CIRCUIT_COOLDOWN_MS        熔断冷却（默认 30s）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 熔断状态快照（管理 API 展示） */
export interface BreakerStatus {
  toolName: string;
  state: 'closed' | 'open' | 'half_open';
  /** 窗口内失败次数 */
  failures: number;
  /** 窗口内总调用次数 */
  calls: number;
  /** 熔断打开时间（ms） */
  openedAt: number | null;
  /** 冷却剩余毫秒（open 时） */
  cooldownRemainingMs: number;
}

interface BreakerState {
  /** 窗口内失败时间戳 */
  failureTimestamps: number[];
  /** 窗口内调用次数 */
  calls: number;
  /** 熔断打开时间戳 */
  openedAt: number | null;
  /** 半开：放行单个测试请求 */
  halfOpen: boolean;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly states = new Map<string, BreakerState>();

  constructor(configService: ConfigService) {
    this.failureThreshold =
      Number(configService.get<string>('CIRCUIT_FAILURE_THRESHOLD', '5')) || 5;
    this.windowMs =
      Number(configService.get<string>('CIRCUIT_WINDOW_MS', '60000')) || 60000;
    this.cooldownMs =
      Number(configService.get<string>('CIRCUIT_COOLDOWN_MS', '30000')) ||
      30000;
  }

  /**
   * 检查工具是否允许执行
   *
   * @param toolName 工具名
   * @returns ok=true 放行；ok=false 熔断拒绝
   */
  canProceed(toolName: string): { ok: boolean; reason?: string } {
    const state = this.states.get(toolName);
    if (!state) {
      return { ok: true };
    }

    // 清理窗口外失败记录
    const now = Date.now();
    state.failureTimestamps = state.failureTimestamps.filter(
      (t) => now - t < this.windowMs,
    );

    // open 状态：冷却期判断
    if (state.openedAt !== null) {
      const cooldownLeft = state.openedAt + this.cooldownMs - now;
      if (cooldownLeft > 0) {
        return {
          ok: false,
          reason: `服务暂时熔断，请 ${Math.ceil(cooldownLeft / 1000)} 秒后重试`,
        };
      }
      // 冷却结束 → half-open，放行单个测试请求
      state.openedAt = null;
      state.halfOpen = true;
      state.failureTimestamps = [];
      return { ok: true };
    }

    // closed：失败达到阈值 → open
    if (state.failureTimestamps.length >= this.failureThreshold) {
      state.openedAt = now;
      state.halfOpen = false;
      this.logger.warn(
        `工具熔断已打开：${toolName}（窗口内失败 ${state.failureTimestamps.length}/${this.failureThreshold}）`,
      );
      return {
        ok: false,
        reason: `服务暂时熔断，请 ${Math.ceil(this.cooldownMs / 1000)} 秒后重试`,
      };
    }

    return { ok: true };
  }

  /**
   * 记录执行成功（half-open 测试成功 → 关闭熔断）
   */
  recordSuccess(toolName: string): void {
    const state = this.states.get(toolName);
    if (!state) {
      return;
    }
    if (state.halfOpen) {
      this.logger.log(`工具熔断已恢复：${toolName}`);
    }
    state.halfOpen = false;
    state.openedAt = null;
    state.failureTimestamps = [];
  }

  /**
   * 记录执行失败（half-open 测试失败 → 重新 open）
   */
  recordFailure(toolName: string): void {
    const now = Date.now();
    let state = this.states.get(toolName);
    if (!state) {
      state = {
        failureTimestamps: [],
        calls: 0,
        openedAt: null,
        halfOpen: false,
      };
      this.states.set(toolName, state);
    }

    state.calls += 1;
    state.failureTimestamps.push(now);
    if (state.halfOpen) {
      // 半开测试失败 → 重新打开熔断
      state.openedAt = now;
      state.halfOpen = false;
      this.logger.warn(`工具熔断半开测试失败，重新熔断：${toolName}`);
    }
  }

  /**
   * 熔断状态列表（管理 API）
   */
  status(): BreakerStatus[] {
    const now = Date.now();
    const list: BreakerStatus[] = [];
    for (const [toolName, state] of this.states) {
      const failures = state.failureTimestamps.filter(
        (t) => now - t < this.windowMs,
      ).length;
      const isOpen =
        state.openedAt !== null && now - state.openedAt < this.cooldownMs;
      list.push({
        toolName,
        state: isOpen ? 'open' : state.halfOpen ? 'half_open' : 'closed',
        failures,
        calls: state.calls,
        openedAt: state.openedAt,
        cooldownRemainingMs:
          state.openedAt !== null
            ? Math.max(0, state.openedAt + this.cooldownMs - now)
            : 0,
      });
    }
    return list.sort((a, b) => a.toolName.localeCompare(b.toolName));
  }

  /**
   * 手动重置熔断（指定工具或全部）
   */
  reset(toolName?: string): number {
    if (toolName) {
      const removed = this.states.delete(toolName) ? 1 : 0;
      if (removed) {
        this.logger.log(`工具熔断已手动重置：${toolName}`);
      }
      return removed;
    }
    const count = this.states.size;
    this.states.clear();
    this.logger.log(`全部工具熔断已手动重置（${count} 个）`);
    return count;
  }
}
