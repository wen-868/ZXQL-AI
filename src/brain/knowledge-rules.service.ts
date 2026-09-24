/**
 * KnowledgeRulesService — knowledge/ 运营规则运行时注入（2026-09-05 智能达标审计 G1）
 *
 * 问题：knowledge/ 下 9 份业务规则文档此前只在 RAG 开启时经 rag-seed 进向量库
 * （默认 ENABLE_RAG=false + 需配 embedding）——默认生产姿态下 AI 根本读不到
 * 这些运营规则。
 *
 * 方案：启动后首次使用时加载 knowledge/*.md 到内存（文件名 → 业务域映射），
 * 按意图分诊结果注入相关域规则到系统提示词（无 embedding 依赖、零外部服务）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolCategory } from '../tools/tool.interface';

/** 规则文件名 → 业务域映射（文件名包含 match 即命中） */
const FILE_CATEGORY_MAP: Array<{
  match: string;
  categories: ToolCategory[];
}> = [
  { match: '库存管理规则', categories: ['inventory'] },
  { match: '客户信用与关怀规则', categories: ['customer'] },
  { match: '客户类型与等级', categories: ['customer'] },
  { match: '财务与费用规则', categories: ['finance'] },
  { match: '采购与供应商规则', categories: ['purchase'] },
  { match: '营销活动规则', categories: ['marketing'] },
  { match: '单据编号规则', categories: ['order'] },
  { match: '审批与总台规则', categories: ['system', 'platform'] },
  {
    match: '系统功能说明',
    categories: [
      'order',
      'inventory',
      'product',
      'customer',
      'purchase',
      'delivery',
      'finance',
      'report',
      'marketing',
    ],
  },
];

/** 注入提示词的单文档与总量上限（防规则全文撑爆提示词） */
const PER_DOC_CAP = 900;
const TOTAL_CAP = 1800;

interface RuleDoc {
  file: string;
  categories: ToolCategory[];
  content: string;
}

@Injectable()
export class KnowledgeRulesService {
  private readonly logger = new Logger(KnowledgeRulesService.name);
  /** knowledge 目录（可用 KNOWLEDGE_DIR 环境变量覆盖；测试可 setDir 注入） */
  private dir = join(process.cwd(), process.env.KNOWLEDGE_DIR ?? 'knowledge');
  private cache: RuleDoc[] | null = null;
  /** 规则缓存加载时间（配合 10 分钟 TTL：knowledge/*.md 编辑后免重启生效） */
  private loadedAt = 0;
  private static readonly RULES_TTL_MS = 10 * 60 * 1000;

  /** 测试注入目录用（生产勿调） */
  setDirForTests(dir: string): void {
    this.dir = dir;
    this.cache = null;
    this.loadedAt = 0;
  }

  /** 惰性加载 knowledge/*.md（目录缺失/读取失败 → 空数组，不阻断对话；10 分钟 TTL，规则编辑免重启生效） */
  private load(): RuleDoc[] {
    if (
      this.cache &&
      Date.now() - this.loadedAt < KnowledgeRulesService.RULES_TTL_MS
    ) {
      return this.cache;
    }
    const docs: RuleDoc[] = [];
    try {
      if (!existsSync(this.dir)) {
        this.logger.warn(`知识规则目录不存在：${this.dir}（规则注入降级为空）`);
        this.cache = docs;
        this.loadedAt = Date.now();
        return docs;
      }
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith('.md')) continue;
        const mapping = FILE_CATEGORY_MAP.find((m) => file.includes(m.match));
        if (!mapping) continue;
        const raw = readFileSync(join(this.dir, file), 'utf8');
        docs.push({
          file,
          categories: mapping.categories,
          content: raw.slice(0, PER_DOC_CAP),
        });
      }
      this.logger.log(`知识规则已加载：${docs.length} 份（${this.dir}）`);
    } catch (err) {
      this.logger.warn(
        `知识规则加载失败（规则注入降级为空）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.cache = docs;
    this.loadedAt = Date.now();
    return docs;
  }

  /**
   * 按意图分类取相关业务规则上下文
   *
   * @param categories 意图分诊结果；undefined（全量回退）时只注入「系统功能说明」
   * @returns 规则文本（多文档拼接，总量截断）；无匹配返回 undefined
   */
  getRulesContext(categories?: ToolCategory[]): string | undefined {
    const docs = this.load();
    if (docs.length === 0) return undefined;

    const picked =
      categories && categories.length > 0
        ? docs.filter((d) => d.categories.some((c) => categories.includes(c)))
        : docs.filter((d) => d.file.includes('系统功能说明'));

    if (picked.length === 0) return undefined;

    let out = '';
    for (const d of picked) {
      const chunk = `【${d.file.replace(/\.md$/, '')}】\n${d.content}`;
      if (out.length + chunk.length > TOTAL_CAP) break;
      out += (out ? '\n\n' : '') + chunk;
    }
    return out.trim().length > 0 ? out : undefined;
  }
}
