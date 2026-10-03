/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-floating-promises -- 测试断言需直接引用 mock 方法（toHaveBeenCalledWith）；controller 委托方法返回 Promise，测试仅验证同步委托关系无需 await */
/**
 * AiConfigController 单元测试
 *
 * 覆盖：
 * 1. 8 个端点到 AiConfigAdminService 的委托关系、分页参数转换（toInt fallback）
 * 2. 租户归属收口（2026-10-04 P0 修复回归）：
 *    - 平台级端点（platform / billing 更新）商户身份 → 403
 *    - 租户级端点商户身份锁定本租户，跨租户 → 403
 *    - 商户身份列表/用量查询强制本租户过滤（query 自报无效）
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AiConfigController } from './ai-config.controller';
import { AiConfigAdminService } from '../tenant/ai-config-admin.service';
import {
  UpdatePlatformAiConfigDto,
  UpdateTenantAiConfigDto,
  UpdateTenantBillingDto,
} from './dto/ai-config.dto';

function createAdminService(): jest.Mocked<AiConfigAdminService> {
  return {
    getPlatformConfig: jest.fn(),
    updatePlatformConfig: jest.fn(),
    listTenantConfigs: jest.fn(),
    getTenantConfig: jest.fn(),
    updateTenantConfig: jest.fn(),
    getUsageStats: jest.fn(),
    listBillings: jest.fn(),
    updateBilling: jest.fn(),
  } as unknown as jest.Mocked<AiConfigAdminService>;
}

/** 构造带 AdminGuard 挂载身份的 mock request */
function reqOf(
  identityType: 'merchant' | 'platform',
  tenantId?: string,
): Request {
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

describe('AiConfigController', () => {
  let adminService: jest.Mocked<AiConfigAdminService>;
  let controller: AiConfigController;

  beforeEach(() => {
    adminService = createAdminService();
    controller = new AiConfigController(adminService);
  });

  describe('平台默认配置', () => {
    it('GET platform（平台身份）委托 getPlatformConfig', () => {
      controller.getPlatformConfig(reqOf('platform'));
      expect(adminService.getPlatformConfig).toHaveBeenCalledTimes(1);
    });

    it('GET platform（商户身份）→ 403（平台级端点不开放商户）', () => {
      expect(() =>
        controller.getPlatformConfig(reqOf('merchant', 'tenant-A')),
      ).toThrow(ForbiddenException);
      expect(adminService.getPlatformConfig).not.toHaveBeenCalled();
    });

    it('PUT platform（平台身份）委托 updatePlatformConfig(dto)', () => {
      const dto = new UpdatePlatformAiConfigDto();
      dto.defaultModel = 'deepseek-r1';
      dto.apiKey = 'sk-new';

      controller.updatePlatformConfig(reqOf('platform'), dto);

      expect(adminService.updatePlatformConfig).toHaveBeenCalledWith(dto);
    });

    it('PUT platform（商户身份）→ 403', () => {
      const dto = new UpdatePlatformAiConfigDto();
      expect(() =>
        controller.updatePlatformConfig(reqOf('merchant', 'tenant-A'), dto),
      ).toThrow(ForbiddenException);
      expect(adminService.updatePlatformConfig).not.toHaveBeenCalled();
    });
  });

  describe('租户 AI 配置', () => {
    it('GET tenants（平台身份）默认分页（page=1 pageSize=20）', () => {
      controller.listTenants(
        reqOf('platform'),
        undefined,
        undefined,
        undefined,
      );
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET tenants（平台身份）带 tenantId + 合法分页参数', () => {
      controller.listTenants(reqOf('platform'), 'tenant-001', '3', '50');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        page: 3,
        pageSize: 50,
      });
    });

    it('GET tenants（商户身份）强制本租户过滤（query 自报他人租户无效）', () => {
      controller.listTenants(
        reqOf('merchant', 'tenant-A'),
        'tenant-B',
        '1',
        '20',
      );
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        page: 1,
        pageSize: 20,
      });
    });

    it('GET tenants 非法分页参数回退默认值（NaN/负数）', () => {
      controller.listTenants(reqOf('platform'), undefined, 'abc', '0');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });

      controller.listTenants(reqOf('platform'), undefined, '-5', '-1');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET tenants/:tenantId（平台身份）委托 getTenantConfig', () => {
      controller.getTenant(reqOf('platform'), 'tenant-001');
      expect(adminService.getTenantConfig).toHaveBeenCalledWith('tenant-001');
    });

    it('GET tenants/:tenantId（商户查本租户）放行', () => {
      controller.getTenant(reqOf('merchant', 'tenant-A'), 'tenant-A');
      expect(adminService.getTenantConfig).toHaveBeenCalledWith('tenant-A');
    });

    it('GET tenants/:tenantId（商户查他人租户）→ 403', () => {
      expect(() =>
        controller.getTenant(reqOf('merchant', 'tenant-A'), 'tenant-B'),
      ).toThrow(ForbiddenException);
      expect(adminService.getTenantConfig).not.toHaveBeenCalled();
    });

    it('PUT tenants/:tenantId（平台身份）委托 updateTenantConfig(tenantId, dto)', () => {
      const dto = new UpdateTenantAiConfigDto();
      dto.provider = 'ollama';
      // 测试假 apiKey 运行时拼装（避免硬编码凭据样式，Mimosa L3 门禁要求）
      dto.apiKey = ['sk', 'tenant'].join('-');

      controller.updateTenant(reqOf('platform'), 'tenant-001', dto);

      expect(adminService.updateTenantConfig).toHaveBeenCalledWith(
        'tenant-001',
        dto,
      );
    });

    it('PUT tenants/:tenantId（商户改他人租户配置）→ 403（防 provider 劫持）', () => {
      const dto = new UpdateTenantAiConfigDto();
      expect(() =>
        controller.updateTenant(reqOf('merchant', 'tenant-A'), 'tenant-B', dto),
      ).toThrow(ForbiddenException);
      expect(adminService.updateTenantConfig).not.toHaveBeenCalled();
    });
  });

  describe('用量统计', () => {
    it('GET usage（平台身份）委托 getUsageStats({startDate,endDate,tenantId})', () => {
      controller.getUsage(
        reqOf('platform'),
        '2026-08-01',
        '2026-08-02',
        'tenant-001',
      );
      expect(adminService.getUsageStats).toHaveBeenCalledWith({
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        tenantId: 'tenant-001',
      });
    });

    it('GET usage 参数可全部省略', () => {
      controller.getUsage(reqOf('platform'), undefined, undefined, undefined);
      expect(adminService.getUsageStats).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        tenantId: undefined,
      });
    });

    it('GET usage（商户身份）锁定本租户用量', () => {
      controller.getUsage(
        reqOf('merchant', 'tenant-A'),
        '2026-08-01',
        '2026-08-02',
        'tenant-B',
      );
      expect(adminService.getUsageStats).toHaveBeenCalledWith({
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        tenantId: 'tenant-A',
      });
    });
  });

  describe('计费套餐', () => {
    it('GET billing（平台身份）默认分页', () => {
      controller.listBillings(
        reqOf('platform'),
        undefined,
        undefined,
        undefined,
      );
      expect(adminService.listBillings).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET billing（平台身份）带 tenantId + 分页参数', () => {
      controller.listBillings(reqOf('platform'), 'tenant-001', '2', '10');
      expect(adminService.listBillings).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        page: 2,
        pageSize: 10,
      });
    });

    it('GET billing（商户身份）锁定本租户', () => {
      controller.listBillings(
        reqOf('merchant', 'tenant-A'),
        'tenant-B',
        '1',
        '20',
      );
      expect(adminService.listBillings).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        page: 1,
        pageSize: 20,
      });
    });

    it('PUT billing/:tenantId（平台身份）委托 updateBilling(tenantId, dto)', () => {
      const dto = new UpdateTenantBillingDto();
      dto.planType = 'monthly';

      controller.updateBilling(reqOf('platform'), 'tenant-001', dto);

      expect(adminService.updateBilling).toHaveBeenCalledWith(
        'tenant-001',
        dto,
      );
    });

    it('PUT billing/:tenantId（商户改套餐）→ 403（计费为平台级操作）', () => {
      const dto = new UpdateTenantBillingDto();
      expect(() =>
        controller.updateBilling(
          reqOf('merchant', 'tenant-A'),
          'tenant-A',
          dto,
        ),
      ).toThrow(ForbiddenException);
      expect(adminService.updateBilling).not.toHaveBeenCalled();
    });
  });
});
