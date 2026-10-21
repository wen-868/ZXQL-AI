/**
 * ReadinessModule — 就绪探针的 DI 归属（R101-AI-47）
 *
 * 为什么单独成模块（两次尝试的教训，都不是"为了好看"）：
 *
 * 1. **原状**：ReadinessService 在**根 AppModule** providers 注册 ⇒ 其他模块
 *    （如 ToolsModule 的 get-system-status 工具）无法 import 它，"复用 readiness
 *    探测结论"这条路被 DI 挡住（R101-AI-34 P1-4 时降级为自建探针）。
 *
 * 2. **第一次尝试（失败，实测）**：把它挪进 OpsModule 并让 ToolsModule import
 *    OpsModule ⇒ **ToolsModule → OpsModule → ProactiveModule → BrainModule →
 *    ToolsModule 成环**（app.module.di.spec 报 circular dependency）。
 *    根因：OpsModule 依赖 ProactiveModule（告警推送），而 BrainModule 又 import
 *    ToolsModule —— 把"被依赖方"挂在一条重依赖链上必然成环。
 *
 * 3. **本模块（正解）**：只 import DatabaseModule + AiDbModule（满足双数据源：
 *    默认连接 + AI_DB_CONNECTION）⇒ **依赖叶子节点，任何模块 import 它都无环**。
 *
 * 单一实例保证：ReadinessService 是**有状态**服务（cache + inFlight 探测去重），
 * 只在本模块 providers 注册一次；AppModule / ToolsModule 均通过 import 复用同一个实例
 * ⇒ 探测状态不分裂（不会出现"两处各查一次、结论互相覆盖"）。
 *
 * 负责人: 阿澈（AI 底座集成 owner）｜创建日期: 2026-10-21
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AiDbModule } from '../database/ai-db.module';
import { ReadinessService } from './readiness.service';

@Module({
  // 双数据源：DatabaseModule 提供默认连接（业务主库），AiDbModule 提供 AI_DB_CONNECTION
  // （其 exports: [TypeOrmModule] ⇒ import 即可注入）。两者都是**叶子依赖**（不依赖
  // tools/brain/proactive）⇒ 无环。
  imports: [DatabaseModule, AiDbModule],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class ReadinessModule {}
