/**
 * R70-21 RagController 单元测试
 *
 * 覆盖：
 * 1. uploadDocument — 成功 / 空内容 / 超 10MB / embedding 未启用 / 解析无文本 / embed 异常传播
 * 2. search — query 为空 400 / 正常检索 / topK 解析（默认、非法、超上限、低于下限）
 * 3. listKnowledge — 默认租户 / 指定租户
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { BadRequestException } from '@nestjs/common';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { RetrieverService } from './retriever.service';
import { RagController } from './rag.controller';
import { UploadDocumentDto } from './dto/upload-document.dto';

// 阻止真实加载 pdf-parse（其依赖 pdfjs-dist 在 Node 测试环境无 DOMMatrix 全局对象）
jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));

/** 单文件最大字节数（与实现一致，用于构造超限测试） */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

describe('R70-21 RagController', () => {
  const loader = {
    loadFromBuffer: jest.fn(),
  };
  const splitter = {
    split: jest.fn(),
  };
  const embedding = {
    isEnabled: jest.fn(),
    embed: jest.fn(),
  };
  const vectorStore = {
    addChunks: jest.fn(),
    listKnowledge: jest.fn(),
  };
  const retriever = {
    search: jest.fn(),
  };

  let controller: RagController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new RagController(
      loader as unknown as DocumentLoaderService,
      splitter as unknown as TextSplitterService,
      embedding as unknown as EmbeddingService,
      vectorStore as unknown as VectorStoreService,
      retriever as unknown as RetrieverService,
    );
  });

  /** 构造上传 DTO */
  function buildDto(
    overrides: Partial<UploadDocumentDto> = {},
  ): UploadDocumentDto {
    return {
      filename: '手册.pdf',
      content: Buffer.from('文档内容', 'utf8').toString('base64'),
      ...overrides,
    };
  }

  describe('uploadDocument', () => {
    it('上传成功应返回索引结果（默认租户）', async () => {
      embedding.isEnabled.mockReturnValue(true);
      loader.loadFromBuffer.mockResolvedValue('文档内容');
      splitter.split.mockReturnValue(['块一', '块二']);
      embedding.embed
        .mockResolvedValueOnce([1, 0])
        .mockResolvedValueOnce([0, 1]);
      vectorStore.addChunks.mockResolvedValue(2);

      const result = await controller.uploadDocument(buildDto());

      expect(result).toEqual({
        success: true,
        docName: '手册.pdf',
        chunkCount: 2,
        tenantId: 'default',
      });
      expect(loader.loadFromBuffer).toHaveBeenCalled();
      expect(splitter.split).toHaveBeenCalledWith('文档内容');
      expect(vectorStore.addChunks).toHaveBeenCalledWith(
        'default',
        '手册.pdf',
        [
          { text: '块一', embedding: [1, 0] },
          { text: '块二', embedding: [0, 1] },
        ],
      );
    });

    it('指定 tenantId 应透传', async () => {
      embedding.isEnabled.mockReturnValue(true);
      loader.loadFromBuffer.mockResolvedValue('内容');
      splitter.split.mockReturnValue(['块一']);
      embedding.embed.mockResolvedValue([1]);
      vectorStore.addChunks.mockResolvedValue(1);

      const result = await controller.uploadDocument(
        buildDto({ tenantId: 'tenant-A' }),
      );
      expect(result.tenantId).toBe('tenant-A');
      expect(vectorStore.addChunks).toHaveBeenCalledWith(
        'tenant-A',
        '手册.pdf',
        expect.any(Array),
      );
    });

    it('base64 解码后为空应抛 400', async () => {
      await expect(
        controller.uploadDocument(buildDto({ content: '' })),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.uploadDocument(buildDto({ content: '' })),
      ).rejects.toThrow('文件内容为空');
    });

    it('超过 10MB 应抛 400', async () => {
      const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0).toString('base64');
      await expect(
        controller.uploadDocument(buildDto({ content: big })),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.uploadDocument(buildDto({ content: big })),
      ).rejects.toThrow('文件大小超过限制');
    });

    it('embedding 未启用应抛 400（RAG 前置条件）', async () => {
      embedding.isEnabled.mockReturnValue(false);
      await expect(controller.uploadDocument(buildDto())).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.uploadDocument(buildDto())).rejects.toThrow(
        'RAG 未启用',
      );
      expect(loader.loadFromBuffer).not.toHaveBeenCalled();
    });

    it('文档未解析出文本应抛 400', async () => {
      embedding.isEnabled.mockReturnValue(true);
      loader.loadFromBuffer.mockResolvedValue('');
      await expect(controller.uploadDocument(buildDto())).rejects.toThrow(
        '未解析出任何文本内容',
      );
    });

    it('embedding 调用失败应向上传播异常（不吞错）', async () => {
      embedding.isEnabled.mockReturnValue(true);
      loader.loadFromBuffer.mockResolvedValue('内容');
      splitter.split.mockReturnValue(['块一', '块二']);
      embedding.embed.mockRejectedValue(new Error('embedding 服务调用失败'));
      await expect(controller.uploadDocument(buildDto())).rejects.toThrow(
        'embedding 服务调用失败',
      );
    });

    it('分块为空时仍应正常入库（0 块）', async () => {
      embedding.isEnabled.mockReturnValue(true);
      loader.loadFromBuffer.mockResolvedValue('内容');
      splitter.split.mockReturnValue([]);
      vectorStore.addChunks.mockResolvedValue(0);
      const result = await controller.uploadDocument(buildDto());
      expect(result.chunkCount).toBe(0);
      expect(vectorStore.addChunks).toHaveBeenCalledWith(
        'default',
        '手册.pdf',
        [],
      );
    });
  });

  describe('search', () => {
    it('query 为空应抛 400', async () => {
      await expect(controller.search('', 'default')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.search('   ', 'default')).rejects.toThrow(
        'query 不能为空',
      );
      expect(retriever.search).not.toHaveBeenCalled();
    });

    it('正常检索应返回结果（默认 topK=3）', async () => {
      retriever.search.mockResolvedValue([
        {
          text: '五粮液 4900 元',
          score: 0.98,
          docName: '价目表.xlsx',
          chunkIndex: 0,
        },
      ]);
      const result = await controller.search('五粮液多少钱');
      expect(retriever.search).toHaveBeenCalledWith(
        '五粮液多少钱',
        'default',
        3,
      );
      expect(result).toEqual({
        query: '五粮液多少钱',
        results: [
          {
            text: '五粮液 4900 元',
            score: 0.98,
            docName: '价目表.xlsx',
            chunkIndex: 0,
          },
        ],
        tenantId: 'default',
      });
    });

    it('指定 tenantId 与合法 topK 应透传', async () => {
      retriever.search.mockResolvedValue([]);
      await controller.search('查询', 'tenant-A', '5');
      expect(retriever.search).toHaveBeenCalledWith('查询', 'tenant-A', 5);
    });

    it('非法 topK 应回退为 3', async () => {
      retriever.search.mockResolvedValue([]);
      await controller.search('查询', 'default', 'abc');
      expect(retriever.search).toHaveBeenCalledWith('查询', 'default', 3);
    });

    it('topK 超上限应收敛到 10', async () => {
      retriever.search.mockResolvedValue([]);
      await controller.search('查询', 'default', '100');
      expect(retriever.search).toHaveBeenCalledWith('查询', 'default', 10);
    });

    it('topK 低于下限应提升到 1', async () => {
      retriever.search.mockResolvedValue([]);
      await controller.search('查询', 'default', '0');
      expect(retriever.search).toHaveBeenCalledWith('查询', 'default', 1);
    });
  });

  describe('listKnowledge', () => {
    it('默认租户应返回知识库列表', () => {
      vectorStore.listKnowledge.mockReturnValue([
        { docName: '手册.pdf', chunkCount: 2, createdAt: new Date() },
      ]);
      const result = controller.listKnowledge();
      expect(vectorStore.listKnowledge).toHaveBeenCalledWith('default');
      expect(result.tenantId).toBe('default');
      expect(result.knowledge).toHaveLength(1);
    });

    it('指定租户应透传', () => {
      vectorStore.listKnowledge.mockReturnValue([]);
      const result = controller.listKnowledge('tenant-A');
      expect(vectorStore.listKnowledge).toHaveBeenCalledWith('tenant-A');
      expect(result.tenantId).toBe('tenant-A');
    });
  });
});
