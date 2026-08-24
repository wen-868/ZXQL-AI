/**
 * ProactiveModule 单元测试
 *
 * 验证模块元数据配置正确（不实例化 Nest 容器，避免 TypeOrmModule 触发真实数据库连接）：
 * - imports（BridgeModule / DatabaseModule）
 * - providers（9 个巡检 Service + ProactivePushService + ProactiveService）
 * - controllers（ProactiveController）
 * - exports（ProactiveService）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { ProactiveModule } from './proactive.module';
import { BridgeModule } from '../../bridge/bridge.module';
import { DatabaseModule } from '../../database/database.module';
import { ProactiveController } from './proactive.controller';
import { ProactivePushService } from './proactive-push.service';
import { ProactiveService } from './proactive.service';
import { InventoryWarningService } from './inventory-warning.service';
import { OrderAnomalyService } from './order-anomaly.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { DailyBriefingService } from './daily-briefing.service';
import { BusinessAnomalyService } from './business-anomaly.service';
import { ReplenishmentAdviceService } from './replenishment-advice.service';
import { DeliveryAnomalyService } from './delivery-anomaly.service';
import { CustomerChurnService } from './customer-churn.service';
import { GrossMarginAnomalyService } from './gross-margin-anomaly.service';

/** 读取 Nest 模块元数据（类型安全） */
function getModuleMetadata(
  key: 'imports' | 'providers' | 'controllers' | 'exports',
): unknown[] {
  return (Reflect.getMetadata(key, ProactiveModule) ?? []) as unknown[];
}

describe('ProactiveModule', () => {
  it('导入 BridgeModule 与 DatabaseModule', () => {
    const imports = getModuleMetadata('imports');
    expect(imports).toEqual(
      expect.arrayContaining([BridgeModule, DatabaseModule]),
    );
  });

  it('注册 9 个巡检 Service + 推送服务 + 调度器', () => {
    const providers = getModuleMetadata('providers');
    expect(providers).toContain(InventoryWarningService);
    expect(providers).toContain(OrderAnomalyService);
    expect(providers).toContain(ReceivableReminderService);
    expect(providers).toContain(DailyBriefingService);
    expect(providers).toContain(BusinessAnomalyService);
    expect(providers).toContain(ReplenishmentAdviceService);
    expect(providers).toContain(DeliveryAnomalyService);
    expect(providers).toContain(CustomerChurnService);
    expect(providers).toContain(GrossMarginAnomalyService);
    expect(providers).toContain(ProactivePushService);
    expect(providers).toContain(ProactiveService);
    expect(providers).toHaveLength(11);
  });

  it('注册 ProactiveController 并导出 ProactiveService / ProactivePushService', () => {
    const controllers = getModuleMetadata('controllers');
    const exportsList = getModuleMetadata('exports');
    expect(controllers).toEqual([ProactiveController]);
    expect(exportsList).toEqual([ProactiveService, ProactivePushService]);
  });
});
