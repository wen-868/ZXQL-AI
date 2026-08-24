/**
 * P0-2 WriteSchemaRegistry 单元测试
 *
 * 覆盖：
 * 1. 14 类写入 Schema 齐全且字段完整（必填/枚举/说明）
 * 2. 工具名 → docType 映射完整
 * 3. Schema → OpenAI JSON Schema 生成正确（required/enum/items）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  getWriteSchema,
  docTypeForTool,
  listWriteSchemas,
  schemaToExtractTool,
  schemaToJsonSchema,
} from './write-schema-registry';

const EXPECTED_DOC_TYPES = [
  'customer_create',
  'product_create',
  'price_update',
  'sales_order',
  'sales_return',
  'purchase_order',
  'purchase_return',
  'delivery',
  'receipt',
  'payment',
  'refund',
  'inventory_transfer',
  'inventory_check',
  'promotion',
];

describe('P0-2 WriteSchemaRegistry', () => {
  it('应注册齐全 14 类写入 Schema', () => {
    const docTypes = listWriteSchemas().map((s) => s.docType);
    for (const dt of EXPECTED_DOC_TYPES) {
      expect(docTypes).toContain(dt);
    }
    expect(listWriteSchemas()).toHaveLength(14);
  });

  it('每个 Schema 应包含 label/toolNames/risk/fields', () => {
    for (const schema of listWriteSchemas()) {
      expect(schema.label).toBeTruthy();
      expect(schema.toolNames.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(schema.risk);
      expect(Object.keys(schema.fields).length).toBeGreaterThan(0);
    }
  });

  it('必填字段应集中在关键写入要素', () => {
    const salesOrder = getWriteSchema('sales_order');
    expect(salesOrder?.fields.customerName.required).toBe(true);
    expect(salesOrder?.fields.items.required).toBe(true);
    expect(salesOrder?.fields.items.itemFields?.skuName.required).toBe(true);

    const refund = getWriteSchema('refund');
    expect(refund?.fields.returnNo.required).toBe(true);
    expect(refund?.fields.refundMethod.required).toBe(true);
    expect(refund?.fields.refundMethod.enum).toEqual([
      'CASH',
      'WECHAT',
      'BANK',
    ]);

    const priceUpdate = getWriteSchema('price_update');
    expect(priceUpdate?.risk).toBe('high');
    expect(priceUpdate?.fields.skuName.required).toBe(true);
    expect(priceUpdate?.fields.newPrice.required).toBe(true);
  });

  it('promotion Schema 应包含活动类型枚举与公共字段', () => {
    const promo = getWriteSchema('promotion');
    expect(promo?.fields.promotionType.required).toBe(true);
    expect(promo?.fields.promotionType.enum).toContain('flash_sale');
    expect(promo?.fields.promotionType.enum).toContain('coupon');
    expect(promo?.fields.promotionType.enum).toContain('group_buy');
    expect(promo?.fields.name.required).toBe(true);
  });

  it('工具名应映射到对应 docType', () => {
    expect(docTypeForTool('createSalesOrder')).toBe('sales_order');
    expect(docTypeForTool('createCustomer')).toBe('customer_create');
    expect(docTypeForTool('updateProductPrice')).toBe('price_update');
    expect(docTypeForTool('inventoryTransfer')).toBe('inventory_transfer');
    expect(docTypeForTool('stockCheck')).toBe('inventory_check');
    expect(docTypeForTool('createRefund')).toBe('refund');
    expect(docTypeForTool('api_create_flash_sale')).toBe('promotion');
    expect(docTypeForTool('queryInventory')).toBeUndefined();
  });

  it('schemaToJsonSchema 应生成 required/enum/items 结构', () => {
    const schema = getWriteSchema('sales_order')!;
    const json = schemaToJsonSchema(schema) as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(json.type).toBe('object');
    expect(json.required).toContain('customerName');
    expect(json.required).toContain('items');
    expect(json.properties.items).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        required: ['skuName'],
      },
    });
  });

  it('schemaToExtractTool 应生成 extract_{docType} 函数定义', () => {
    const schema = getWriteSchema('payment')!;
    const tool = schemaToExtractTool(schema);
    expect(tool.function.name).toBe('extract_payment');
    expect(tool.function.description).toContain('供应商付款');
    const params = tool.function.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required).toContain('supplierName');
    expect(params.required).toContain('amount');
    expect(
      (params.properties.paymentMethod as { enum: string[] }).enum,
    ).toEqual(['BANK', 'CASH', 'TRANSFER']);
  });
});
