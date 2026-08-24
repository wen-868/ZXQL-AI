/**
 * WriteSchemaRegistry — 写入文档 Schema 注册表（P0-2）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 23 章
 * 原则：所有写入类型统一结构化抽取，**写入字段抽取禁用正则**（字段由 LLM
 * 结构化抽取产出，nl-parser/param-coercer 仅作数量/价格语义的校验辅助）。
 *
 * 14 类写入 Schema（docType → 字段/类型/必填/枚举/说明）：
 * customer_create / product_create / price_update / sales_order / sales_return /
 * purchase_order / purchase_return / delivery / receipt / payment / refund /
 * inventory_transfer / inventory_check / promotion
 *
 * 字段定义对齐现有写工具参数（工具内部负责实体解析：customerName→memberId、
 * skuName→skuId），本层聚焦"用户自然语言意图层"的结构化抽取。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { ToolRisk } from '../../tools/tool.interface';
import type { ToolDefinition } from '../../providers/provider.interface';

/** 写入字段类型（抽取校验用） */
export type WriteFieldType =
  'string' | 'number' | 'boolean' | 'date' | 'quantity' | 'money' | 'items';

/** 写入字段定义 */
export interface WriteFieldSchema {
  /** 字段类型 */
  type: WriteFieldType;
  /** 是否必填（缺失时触发反问澄清） */
  required?: boolean;
  /** 枚举约束（非法值触发澄清） */
  enum?: string[];
  /** 字段说明（供 LLM 抽取与澄清问题生成） */
  description: string;
  /** 数量语义辅助：box→箱 / bottle→瓶 / piece→件 */
  unitKind?: 'box' | 'bottle' | 'piece';
  /** items 类型的子项字段 */
  itemFields?: Record<string, WriteFieldSchema>;
}

/** 写入文档 Schema */
export interface WriteDocSchema {
  /** 文档类型（如 sales_order） */
  docType: string;
  /** 操作名称（如"创建销售单"，供澄清与预览） */
  label: string;
  /** 关联的现有工具名（抽取后映射到工具执行） */
  toolNames: string[];
  /** 默认风险分级（WriteGuard 用） */
  risk: ToolRisk;
  /** 字段定义 */
  fields: Record<string, WriteFieldSchema>;
}

/** 14 类写入 Schema */
const WRITE_SCHEMAS: WriteDocSchema[] = [
  {
    docType: 'customer_create',
    label: '创建客户',
    toolNames: ['createCustomer'],
    risk: 'medium',
    fields: {
      name: { type: 'string', required: true, description: '客户名称' },
      phone: {
        type: 'string',
        required: true,
        description: '联系电话/手机号',
      },
      customerType: {
        type: 'string',
        enum: ['CASH', 'WHOLESALE', 'VIP'],
        description: '客户类型：CASH=散客/WHOLESALE=批发/VIP=VIP客户',
      },
      creditLimit: {
        type: 'money',
        description: '信用额度（元）',
      },
    },
  },
  {
    docType: 'product_create',
    label: '创建商品',
    toolNames: ['createProduct'],
    risk: 'medium',
    fields: {
      name: {
        type: 'string',
        required: true,
        description: '商品名称（如"红星二锅头 56度 500ml"）',
      },
      categoryName: { type: 'string', description: '商品分类名称' },
      retailPrice: { type: 'money', description: '零售价（元/瓶）' },
      wholesalePrice: { type: 'money', description: '批发价（元/瓶）' },
      boxRatio: {
        type: 'number',
        description: '箱瓶比（1箱=N瓶，默认1）',
      },
      baseUnit: { type: 'string', description: '基础单位（默认"瓶"）' },
      boxUnit: { type: 'string', description: '包装单位（默认"箱"）' },
      remark: { type: 'string', description: '备注/描述' },
    },
  },
  {
    docType: 'price_update',
    label: '调整商品价格',
    toolNames: ['updateProductPrice'],
    risk: 'high',
    fields: {
      skuName: {
        type: 'string',
        required: true,
        description: '商品名称/SKU（用户口语中的商品名）',
      },
      newPrice: {
        type: 'money',
        required: true,
        description: '新价格（必须大于0，元/瓶）',
      },
    },
  },
  {
    docType: 'sales_order',
    label: '创建销售单',
    toolNames: ['createSalesOrder'],
    risk: 'medium',
    fields: {
      customerName: {
        type: 'string',
        required: true,
        description: '客户名称（不存在时工具自动创建）',
      },
      items: {
        type: 'items',
        required: true,
        description: '商品明细列表（至少一项）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          boxQty: {
            type: 'quantity',
            unitKind: 'box',
            description: '箱数（与瓶数二选一或组合）',
          },
          bottleQty: {
            type: 'quantity',
            unitKind: 'bottle',
            description: '瓶数（与箱数二选一或组合）',
          },
          unitPrice: {
            type: 'money',
            description: '用户指定单价（不传则自动匹配客户类型价格）',
          },
        },
      },
      saleType: {
        type: 'string',
        enum: ['CASH', 'CREDIT'],
        description: '销售类型：CASH=现结/CREDIT=赊销',
      },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'sales_return',
    label: '创建销售退货',
    toolNames: ['createSalesReturn'],
    risk: 'medium',
    fields: {
      customerName: { type: 'string', description: '客户名称' },
      sourceBillNo: {
        type: 'string',
        description: '关联原销售单号',
      },
      items: {
        type: 'items',
        required: true,
        description: '退货商品明细（至少一项）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          boxQty: {
            type: 'quantity',
            unitKind: 'box',
            description: '退货箱数',
          },
          bottleQty: {
            type: 'quantity',
            unitKind: 'bottle',
            description: '退货瓶数',
          },
          unitPrice: {
            type: 'money',
            description: '退货单价（不传则按原价）',
          },
          reason: { type: 'string', description: '退货原因' },
        },
      },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'purchase_order',
    label: '创建采购单',
    toolNames: ['createPurchaseOrder'],
    risk: 'medium',
    fields: {
      supplierName: {
        type: 'string',
        required: true,
        description: '供应商名称',
      },
      items: {
        type: 'items',
        required: true,
        description: '采购商品明细（至少一项）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          boxQty: { type: 'quantity', unitKind: 'box', description: '箱数' },
          bottleQty: {
            type: 'quantity',
            unitKind: 'bottle',
            description: '瓶数',
          },
          unitPrice: {
            type: 'money',
            description: '单价（不传则用系统默认进价）',
          },
        },
      },
      expectedDate: {
        type: 'date',
        description: '期望到货日期（YYYY-MM-DD）',
      },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'purchase_return',
    label: '创建采购退货',
    toolNames: ['api_create_purchase_return'],
    risk: 'medium',
    fields: {
      supplierName: {
        type: 'string',
        required: true,
        description: '供应商名称',
      },
      orderNo: { type: 'string', description: '原采购单号' },
      items: {
        type: 'items',
        required: true,
        description: '退货商品明细（至少一项）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          boxQty: { type: 'quantity', unitKind: 'box', description: '箱数' },
          bottleQty: {
            type: 'quantity',
            unitKind: 'bottle',
            description: '瓶数',
          },
          unitPrice: { type: 'money', description: '单价' },
          reason: { type: 'string', description: '退货原因' },
        },
      },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'delivery',
    label: '创建配送单',
    toolNames: ['createDelivery'],
    risk: 'medium',
    fields: {
      orderNo: {
        type: 'string',
        required: true,
        description: '订单号（须为待配送状态）',
      },
    },
  },
  {
    docType: 'receipt',
    label: '客户收款/对账',
    toolNames: ['createPaymentReconciliation'],
    risk: 'high',
    fields: {
      customerName: {
        type: 'string',
        required: true,
        description: '收款客户名称',
      },
    },
  },
  {
    docType: 'payment',
    label: '供应商付款',
    toolNames: ['api_create_purchase_payment'],
    risk: 'high',
    fields: {
      supplierName: {
        type: 'string',
        required: true,
        description: '供应商名称',
      },
      amount: {
        type: 'money',
        required: true,
        description: '付款金额（元，>0）',
      },
      paymentDate: {
        type: 'date',
        description: '付款日期（YYYY-MM-DD）',
      },
      paymentMethod: {
        type: 'string',
        enum: ['BANK', 'CASH', 'TRANSFER'],
        description: '付款方式：BANK=银行/CASH=现金/TRANSFER=转账',
      },
      sourceNo: { type: 'string', description: '关联采购单号' },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'refund',
    label: '退款',
    toolNames: ['createRefund'],
    risk: 'high',
    fields: {
      returnNo: {
        type: 'string',
        required: true,
        description: '退货单号',
      },
      refundMethod: {
        type: 'string',
        required: true,
        enum: ['CASH', 'WECHAT', 'BANK'],
        description: '退款方式：CASH=现金/WECHAT=微信/BANK=银行转账',
      },
    },
  },
  {
    docType: 'inventory_transfer',
    label: '库存调拨',
    toolNames: ['inventoryTransfer'],
    risk: 'medium',
    fields: {
      fromStoreName: {
        type: 'string',
        required: true,
        description: '调出门店名称',
      },
      toStoreName: {
        type: 'string',
        required: true,
        description: '调入门店名称（不能与调出门店相同）',
      },
      items: {
        type: 'items',
        required: true,
        description: '调拨商品明细（至少一项）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          quantity: {
            type: 'quantity',
            description: '调拨数量（>0）',
          },
          unitPrice: {
            type: 'money',
            description: '单价（不传则用成本价）',
          },
        },
      },
      expectedDate: {
        type: 'date',
        description: '期望到货日期（YYYY-MM-DD）',
      },
      remark: { type: 'string', description: '备注' },
    },
  },
  {
    docType: 'inventory_check',
    label: '库存盘点',
    toolNames: ['stockCheck'],
    risk: 'medium',
    fields: {
      storeName: {
        type: 'string',
        required: true,
        description: '盘点门店名称',
      },
      items: {
        type: 'items',
        description: '盘点商品明细（可选，不传则全店盘点）',
        itemFields: {
          skuName: {
            type: 'string',
            required: true,
            description: '商品名称/SKU',
          },
          bookQty: {
            type: 'quantity',
            description: '账面数量',
          },
        },
      },
      remark: { type: 'string', description: '盘点备注（如"月度盘点"）' },
    },
  },
  {
    docType: 'promotion',
    label: '创建营销活动',
    toolNames: [
      'api_create_flash_sale',
      'createCouponTemplate',
      'createFullReduction',
      'createGroupBuy',
      'createGiftRule',
      'createLimitedDiscount',
    ],
    risk: 'medium',
    fields: {
      promotionType: {
        type: 'string',
        required: true,
        enum: [
          'flash_sale',
          'coupon',
          'full_reduction',
          'group_buy',
          'gift_rule',
          'limited_discount',
        ],
        description:
          '活动类型：flash_sale=秒杀/coupon=优惠券/full_reduction=满减/group_buy=拼团/gift_rule=赠品/limited_discount=限量折扣',
      },
      name: {
        type: 'string',
        required: true,
        description: '活动名称',
      },
      productName: {
        type: 'string',
        description: '活动商品名称（秒杀/拼团/限量折扣必填）',
      },
      price: {
        type: 'money',
        description: '活动价（秒杀价/拼团价/折扣价）',
      },
      originalPrice: { type: 'money', description: '原价' },
      totalStock: {
        type: 'number',
        description: '活动库存',
      },
      limitPerUser: {
        type: 'number',
        description: '每人限购数量',
      },
      couponAmount: { type: 'money', description: '优惠券面额（元）' },
      couponThreshold: {
        type: 'money',
        description: '优惠券满 X 元可用',
      },
      fullReductionThreshold: {
        type: 'money',
        description: '满减门槛（满 X 元）',
      },
      fullReductionAmount: {
        type: 'money',
        description: '满减金额（减 X 元）',
      },
      groupSize: {
        type: 'number',
        description: '成团人数',
      },
      giftDescription: {
        type: 'string',
        description: '赠品说明',
      },
      startTime: {
        type: 'date',
        description: '开始时间（YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'date',
        description: '结束时间（YYYY-MM-DD HH:mm:ss）',
      },
      remark: { type: 'string', description: '备注' },
    },
  },
];

/** docType → Schema 索引 */
const SCHEMA_INDEX = new Map<string, WriteDocSchema>(
  WRITE_SCHEMAS.map((s) => [s.docType, s]),
);

/** 工具名 → docType 索引（供 Orchestrator 写分支映射） */
const TOOL_DOCTYPE_INDEX = new Map<string, string>();
for (const schema of WRITE_SCHEMAS) {
  for (const toolName of schema.toolNames) {
    TOOL_DOCTYPE_INDEX.set(toolName, schema.docType);
  }
}

/**
 * 按 docType 获取写入 Schema
 */
export function getWriteSchema(docType: string): WriteDocSchema | undefined {
  return SCHEMA_INDEX.get(docType);
}

/**
 * 按工具名映射 docType（写工具 → 写入文档类型）
 */
export function docTypeForTool(toolName: string): string | undefined {
  return TOOL_DOCTYPE_INDEX.get(toolName);
}

/**
 * 列出全部写入 Schema（管理/测试用）
 */
export function listWriteSchemas(): WriteDocSchema[] {
  return [...WRITE_SCHEMAS];
}

/**
 * 将写入 Schema 转换为 OpenAI Function Calling 工具定义
 *
 * 抽取函数名：extract_{docType}，参数为 Schema 的 JSON Schema 表示。
 */
export function schemaToExtractTool(schema: WriteDocSchema): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: `extract_${schema.docType}`,
      description: `从用户话语中抽取「${schema.label}」的结构化参数。只抽取用户明确提到的字段；缺失的可选字段不填。`,
      parameters: schemaToJsonSchema(schema),
    },
  };
}

/**
 * 将写入 Schema 转换为 OpenAI JSON Schema（properties/required/enum）
 */
export function schemaToJsonSchema(schema: WriteDocSchema): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(schema.fields)) {
    properties[name] = fieldToJsonSchema(field);
    if (field.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/** 字段 DSL → JSON Schema 片段 */
function fieldToJsonSchema(field: WriteFieldSchema): object {
  const base: Record<string, unknown> = {
    type: jsonSchemaType(field.type),
    description: field.description,
  };
  if (field.enum) {
    base.enum = field.enum;
  }
  if (field.type === 'items' && field.itemFields) {
    const itemProperties: Record<string, unknown> = {};
    const itemRequired: string[] = [];
    for (const [name, sub] of Object.entries(field.itemFields)) {
      itemProperties[name] = fieldToJsonSchema(sub);
      if (sub.required) {
        itemRequired.push(name);
      }
    }
    base.items = {
      type: 'object',
      properties: itemProperties,
      required: itemRequired,
    };
  }
  return base;
}

/** DSL 类型 → JSON Schema type */
function jsonSchemaType(type: WriteFieldType): string {
  switch (type) {
    case 'number':
    case 'quantity':
    case 'money':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'string';
    case 'items':
      return 'array';
    case 'string':
    default:
      return 'string';
  }
}
