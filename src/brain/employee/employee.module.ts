/**
 * EmployeeModule — 数字员工模块（2026-09-05 MVP）
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AiEmployeeEntity,
  AiEmployeeTaskEntity,
} from '../../database/entities/ai-employee.entity';
// R101-AI-46：待办回写（数字员工任务完成 ⇒ 待办 done）
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { TenantModule } from '../../tenant/tenant.module';
import { EvolutionModule } from '../../evolution/evolution.module';
import { EmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';
import { OfficeEvolutionService } from './office-evolution.service';
import { EmployeeTodoSyncService } from './employee-todo-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiEmployeeEntity,
      AiEmployeeTaskEntity,
      // R101-AI-46：待办回写需要 AiTodoEntity 仓储
      AiTodoEntity,
    ]),
    TenantModule,
    EvolutionModule,
  ],
  providers: [
    EmployeeService,
    OfficeEvolutionService,
    // R101-AI-46：导出以便 ToolsModule 的 AiTodoCompleteTool 复用同一实现（单一真相）
    EmployeeTodoSyncService,
  ],
  exports: [EmployeeService, EmployeeTodoSyncService],
  controllers: [EmployeeController],
})
export class EmployeeModule {}
