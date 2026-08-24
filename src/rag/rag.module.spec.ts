/**
 * R70-21 RagModule 单元测试
 *
 * 验证模块元数据配置正确（不实例化 Nest 容器，避免 TypeOrmModule 触发真实数据库连接）：
 * - imports（DatabaseModule）
 * - controllers（RagController）
 * - providers（loader/splitter/embedding/vector-store/retriever/rag-seed 6 个服务）
 * - exports（RetrieverService / EmbeddingService / VectorStoreService）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
// 阻止真实加载 pdf-parse（其依赖 pdfjs-dist 在 Node 测试环境无 DOMMatrix 全局对象）
jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));

import { RagModule } from './rag.module';
import { DatabaseModule } from '../database/database.module';
import { RagController } from './rag.controller';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { RetrieverService } from './retriever.service';
import { RagSeedService } from './rag-seed.service';

/** 读取 Nest 模块元数据（类型安全） */
function getModuleMetadata(
  key: 'imports' | 'providers' | 'controllers' | 'exports',
): unknown[] {
  return (Reflect.getMetadata(key, RagModule) ?? []) as unknown[];
}

describe('R70-21 RagModule', () => {
  it('导入 DatabaseModule（可选 MySQL 落盘依赖）', () => {
    const imports = getModuleMetadata('imports');
    expect(imports).toEqual(expect.arrayContaining([DatabaseModule]));
  });

  it('注册 RagController 与 6 个核心服务', () => {
    const controllers = getModuleMetadata('controllers');
    const providers = getModuleMetadata('providers');
    expect(controllers).toEqual([RagController]);
    expect(providers).toEqual([
      DocumentLoaderService,
      TextSplitterService,
      EmbeddingService,
      VectorStoreService,
      RetrieverService,
      RagSeedService,
    ]);
  });

  it('导出 RetrieverService / EmbeddingService / VectorStoreService 供外部模块复用', () => {
    const exportsList = getModuleMetadata('exports');
    expect(exportsList).toEqual([
      RetrieverService,
      EmbeddingService,
      VectorStoreService,
    ]);
  });
});
