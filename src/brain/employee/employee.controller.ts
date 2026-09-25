/**
 * EmployeeController — 数字员工管理 API（2026-09-05 MVP）
 *
 * 端点：
 * - GET    /api/ai/employees            员工列表（=对话列表数据源；JWT 即可读）
 * - POST   /api/ai/employees            新建员工（管理角色）
 * - PUT    /api/ai/employees/:id        更新员工（管理角色）
 * - GET    /api/ai/employees/:id/tasks  该员工任务列表（对话框工作台内容）
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AdminGuard, JwtGuard } from '../../tenant/admin-auth.guard';
import { TenantContext } from '../../tenant/tenant-context';
import { EmployeeService } from './employee.service';
import type { AiEmployeeUpdate } from './employee.service';

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty({ message: 'name 不能为空' })
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'post 不能为空' })
  post!: string;

  @IsString()
  @IsNotEmpty({ message: 'department 不能为空' })
  department!: string;

  @IsOptional()
  @IsString()
  personaPrompt?: string;

  @IsOptional()
  @IsArray()
  toolCategories?: string[];

  @IsOptional()
  @IsString()
  replyStyle?: string;

  /** 可调用的员工 employeeUid 列表（边表） */
  @IsOptional()
  @IsArray()
  dispatchUids?: string[];
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  post?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  personaPrompt?: string;

  @IsOptional()
  @IsArray()
  toolCategories?: string[];

  @IsOptional()
  @IsString()
  replyStyle?: string;

  @IsOptional()
  @IsArray()
  dispatchUids?: string[];

  @IsOptional()
  status?: number;
}

@UseGuards(JwtGuard)
@Controller('ai/employees')
export class EmployeeController {
  constructor(
    private readonly employeeService: EmployeeService,
    private readonly tenantContext: TenantContext,
  ) {}

  /** 员工列表（=对话列表数据源） */
  @Get()
  list() {
    return this.employeeService.list(this.tenantContext.require().tenantId);
  }

  /** 新建员工（自动生成对话列表项；管理角色） */
  @UseGuards(AdminGuard)
  @Post()
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeeService.create({
      ...dto,
      tenantId: this.tenantContext.require().tenantId,
    });
  }

  /** 更新员工（管理角色） */
  @UseGuards(AdminGuard)
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: AiEmployeeUpdate) {
    return this.employeeService.update(
      id,
      this.tenantContext.require().tenantId,
      dto,
    );
  }

  /** 员工任务列表（对话框工作台内容：任务下达→结果→回传） */
  @Get(':id/tasks')
  tasks(@Param('id', ParseIntPipe) id: number) {
    const tenantId = this.tenantContext.require().tenantId;
    return this.employeeService
      .getById(id, tenantId)
      .then((e) => this.employeeService.listTasksFor(e.employeeUid, e.id));
  }
}
