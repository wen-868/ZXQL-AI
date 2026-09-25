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
import { TenantModule } from '../../tenant/tenant.module';
import { EmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiEmployeeEntity, AiEmployeeTaskEntity]),
    TenantModule,
  ],
  providers: [EmployeeService],
  controllers: [EmployeeController],
  exports: [EmployeeService],
})
export class EmployeeModule {}
