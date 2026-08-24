/**
 * NL Parser — 自然语言数量/实体解析（精准度优化）
 *
 * 1. parseQuantity：口语数量 → 结构化数量
 *    - "10箱" → { qty: 10, unit: 'box' }
 *    - "一箱半" → { qty: 1.5, unit: 'box' }
 *    - "两三瓶" → { qty: 3, unit: 'bottle' }
 *    - "五粮液" 不匹配 → null
 * 2. normalizeProductKeyword：从商品搜索词中剥离动作/数量前缀
 *    - "给我来10箱五粮液" → "五粮液"
 *    - "查询一下五粮液52度的库存" → "五粮液52度"
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */

/** 中文数字 → 阿拉伯数字 */
const CN_NUM: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** 单位映射：关键词 → 单位类型 */
const UNIT_MAP: Array<{ key: string; unit: 'box' | 'bottle' | 'piece' }> = [
  { key: '箱', unit: 'box' },
  { key: '瓶', unit: 'bottle' },
  { key: '件', unit: 'piece' },
  { key: '提', unit: 'piece' },
  { key: '扎', unit: 'piece' },
];

/** 数量解析结果 */
export interface ParsedQuantity {
  qty: number;
  unit: 'box' | 'bottle' | 'piece';
  /** 是否含"半"（如 一箱半 → qty 1.5） */
  raw: string;
}

/** 解析中文数字片段（支持 一~十九、十~九十、组合） */
function parseCnNumber(text: string): number | null {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === '半') return 0.5;
  if (text in CN_NUM) return CN_NUM[text];
  // 十几/二十几 等组合
  const m = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? CN_NUM[m[1]] : 1;
    const ones = m[2] ? CN_NUM[m[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

/**
 * 从文本开头解析数量（如 "10箱"、"一箱半"、"两三瓶"）
 *
 * @param text 原始文本（如 "10箱五粮液"）
 * @returns 解析结果；无数量开头返回 null
 */
export function parseQuantity(text: string): ParsedQuantity | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 数字 + 单位（支持小数/半，如 "1箱半"、"半箱"）
  const digit = trimmed.match(/^(\d+(?:\.\d+)?|半)([箱瓶件提扎])(半)?/);
  if (digit) {
    const qty = digit[1] === '半' ? 0.5 : Number(digit[1]);
    const unit = UNIT_MAP.find((u) => u.key === digit[2])?.unit ?? 'bottle';
    const half = digit[3] === '半' ? 0.5 : 0;
    return { qty: qty + half, unit, raw: digit[0] };
  }

  // 中文数字 + 单位（一两三…十九、十几、二十几，支持 "一箱半"）
  const cn = trimmed.match(/^([零一二两三四五六七八九十]+)([箱瓶件提扎])(半)?/);
  if (cn) {
    const qty = parseCnNumber(cn[1]);
    if (qty !== null) {
      const unit = UNIT_MAP.find((u) => u.key === cn[2])?.unit ?? 'bottle';
      const half = cn[3] === '半' ? 0.5 : 0;
      return { qty: qty + half, unit, raw: cn[0] };
    }
  }

  // "一两箱"/"两三瓶" 模糊量词 → 取大
  const fuzzy = trimmed.match(/^[一二两三四五六七八九十]{2}([箱瓶件提扎])/);
  if (fuzzy) {
    // 取最后一个字符的数字（两三瓶 → 三 → 3）
    const max = parseCnNumber(fuzzy[0].slice(-2, -1));
    if (max !== null) {
      const unit = UNIT_MAP.find((u) => u.key === fuzzy[1])?.unit ?? 'bottle';
      return { qty: max, unit, raw: fuzzy[0] };
    }
  }

  return null;
}

/** 商品搜索词清洗：剥离动作词/数量/问句前缀，保留商品名 */
export function normalizeProductKeyword(text: string): string {
  let t = text.trim();

  // 剥离常见动作/引导词前缀
  const PREFIXES = [
    '给我',
    '帮我',
    '来点',
    '来',
    '查询',
    '查一下',
    '一下',
    '看看',
    '看一下',
    '有没有',
    '还有',
    '要',
    '订',
    '买',
    '送',
    '进',
    '库存',
    '请问',
    '问一下',
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      if (t.startsWith(p)) {
        t = t.slice(p.length).trim();
        changed = true;
        break;
      }
    }
  }

  // 剥离数量（如 "10箱五粮液"、"一箱半五粮液"，须在动作词剥离后进行）
  const qty = parseQuantity(t);
  if (qty) t = t.slice(qty.raw.length).trim();

  // 循环剥离结尾问句助词（"五粮液吗？" → "五粮液"）
  let cleaned = true;
  while (cleaned) {
    cleaned = false;
    if (/[吗呢吧？?。，,]$/.test(t)) {
      t = t.slice(0, -1).trim();
      cleaned = true;
    } else if (t.endsWith('的库存') || t.endsWith('库存')) {
      t = t.replace(/(的)?库存$/, '').trim();
      cleaned = true;
    }
  }
  return t;
}
