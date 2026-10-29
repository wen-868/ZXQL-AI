/**
 * ScheduleModule —— 日程领域层 DI 归属（AI-P2-2）
 *
 * 为什么单独成模块：
 * - 卡面 §五.7 要求人工入口（gateway）与 AI 工具**共用同一领域服务**
 *   ⇒ 该服务必须能被 **ToolsModule** 与 **GatewayModule** 同时拿到
 * - 但 ToolsModule **不能** import BrainModule（既有架构红线：会成环
 *   BrainModule → ToolsModule），所以领域服务不能挂在 BrainModule 下
 * ⇒ 独立模块：只依赖 `TypeOrmModule.forFeature(AiScheduleEntity/AiAclEntity/AiDocEntity)`
 *   而 ToolsModule 与 GatewayModule 各自 import 本模块 ⇒ 拿到**同一个**领域服务 Singleton
 *
 * 关于 OfficeAclService 的实例问题（如实登记）：
 * - 该服务**无状态**（仅两个仓储注入，判定全部走 SQL），且 ToolsModule 内
 *   原本就地 provide（"无需跨模块导出"注释在案）；本模块为 ScheduleDomainService
 *   **就地再 provide 一个实例** ⇒ 两处各持一个实例，但**行为逐位等价**（同表同逻辑）。
 * - §五.7「同源」约束的承载体是 **ScheduleDomainService**（唯一导出 Singleton，
 *   权限矩阵/租户过滤/审计都在它内部）⇒ 共享判定只有一份实现，满足卡面。
 *   若后续要把 ACL 收敛为单实例，应新建跨模块 Provider（超出本卡允许路径，留待专卡）。
 *
 * 依赖方向核对（无环）：
 *   ScheduleModule → { TypeOrmModule }
 *   TypeOrmModule 是全局数据源绑定，不含业务模块 ⇒ 不成环
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-28
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import { AiAclEntity } from '../../database/entities/ai-acl.entity';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ScheduleDomainService } from './schedule-domain.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiScheduleEntity, AiAclEntity, AiDocEntity]),
  ],
  providers: [OfficeAclService, ScheduleDomainService],
  exports: [ScheduleDomainService],
})
export class ScheduleModule {}
