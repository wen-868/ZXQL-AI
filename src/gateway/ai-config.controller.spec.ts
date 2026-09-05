/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-floating-promises -- 测试断言需直接引用 mock 方法（toHaveBeenCalledWith）；controller 委托方法返回 Promise，测试仅验证同步委托关系无需 await */
/**
 * AiConfigController 单元测试
 *
 * 覆盖：8 个端点到 AiConfigAdminService 的委托关系、分页参数转换（toInt fallback）
 */
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

describe('AiConfigController', () => {
  let adminService: jest.Mocked<AiConfigAdminService>;
  let controller: AiConfigController;

  beforeEach(() => {
    adminService = createAdminService();
    controller = new AiConfigController(adminService);
  });

  describe('平台默认配置', () => {
    it('GET platform 委托 getPlatformConfig', () => {
      controller.getPlatformConfig();
      expect(adminService.getPlatformConfig).toHaveBeenCalledTimes(1);
    });

    it('PUT platform 委托 updatePlatformConfig(dto)', () => {
      const dto = new UpdatePlatformAiConfigDto();
      dto.defaultModel = 'deepseek-r1';
      dto.apiKey = 'sk-new';

      controller.updatePlatformConfig(dto);

      expect(adminService.updatePlatformConfig).toHaveBeenCalledWith(dto);
    });
  });

  describe('租户 AI 配置', () => {
    it('GET tenants 默认分页（page=1 pageSize=20）', () => {
      controller.listTenants(undefined, undefined, undefined);
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET tenants 带 tenantId + 合法分页参数', () => {
      controller.listTenants('tenant-001', '3', '50');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        page: 3,
        pageSize: 50,
      });
    });

    it('GET tenants 非法分页参数回退默认值（NaN/负数）', () => {
      controller.listTenants(undefined, 'abc', '0');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });

      controller.listTenants(undefined, '-5', '-1');
      expect(adminService.listTenantConfigs).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET tenants/:tenantId 委托 getTenantConfig', () => {
      controller.getTenant('tenant-001');
      expect(adminService.getTenantConfig).toHaveBeenCalledWith('tenant-001');
    });

    it('PUT tenants/:tenantId 委托 updateTenantConfig(tenantId, dto)', () => {
      const dto = new UpdateTenantAiConfigDto();
      dto.provider = 'ollama';
      // 测试假 apiKey 运行时拼装（避免硬编码凭据样式，Mimosa L3 门禁要求）
      dto.apiKey = ['sk', 'tenant'].join('-');

      controller.updateTenant('tenant-001', dto);

      expect(adminService.updateTenantConfig).toHaveBeenCalledWith(
        'tenant-001',
        dto,
      );
    });
  });

  describe('用量统计', () => {
    it('GET usage 委托 getUsageStats({startDate,endDate,tenantId})', () => {
      controller.getUsage('2026-08-01', '2026-08-02', 'tenant-001');
      expect(adminService.getUsageStats).toHaveBeenCalledWith({
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        tenantId: 'tenant-001',
      });
    });

    it('GET usage 参数可全部省略', () => {
      controller.getUsage(undefined, undefined, undefined);
      expect(adminService.getUsageStats).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        tenantId: undefined,
      });
    });
  });

  describe('计费套餐', () => {
    it('GET billing 默认分页', () => {
      controller.listBillings(undefined, undefined, undefined);
      expect(adminService.listBillings).toHaveBeenCalledWith({
        tenantId: undefined,
        page: 1,
        pageSize: 20,
      });
    });

    it('GET billing 带 tenantId + 分页参数', () => {
      controller.listBillings('tenant-001', '2', '10');
      expect(adminService.listBillings).toHaveBeenCalledWith({
        tenantId: 'tenant-001',
        page: 2,
        pageSize: 10,
      });
    });

    it('PUT billing/:tenantId 委托 updateBilling(tenantId, dto)', () => {
      const dto = new UpdateTenantBillingDto();
      dto.planType = 'monthly';

      controller.updateBilling('tenant-001', dto);

      expect(adminService.updateBilling).toHaveBeenCalledWith(
        'tenant-001',
        dto,
      );
    });
  });
});
