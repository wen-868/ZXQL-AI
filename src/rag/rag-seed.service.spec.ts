/**
 * RagSeedService 单元测试
 *
 * 覆盖：embedding 未启用跳过、知识库非空跳过、空库加载预置文档、
 *      无内容文档跳过不计数
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { RagSeedService } from './rag-seed.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';

describe('RagSeedService', () => {
  let service: RagSeedService;
  let loader: DocumentLoaderService;
  let splitter: TextSplitterService;
  let embedding: { isEnabled: jest.Mock; embed: jest.Mock };
  let vectorStore: { listKnowledge: jest.Mock; addChunks: jest.Mock };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rag-seed-'));
    loader = new DocumentLoaderService();
    splitter = new TextSplitterService();
    embedding = {
      isEnabled: jest.fn(() => true),
      embed: jest.fn((text: string) => Promise.resolve([text.length])),
    };
    vectorStore = {
      listKnowledge: jest.fn(() => []),
      addChunks: jest.fn((_t: string, _d: string, chunks: unknown[]) =>
        Promise.resolve(chunks.length),
      ),
    };
    service = new RagSeedService(
      loader,
      splitter,
      embedding as unknown as EmbeddingService,
      vectorStore as unknown as VectorStoreService,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('embedding 未启用时跳过加载（不检查知识库）', async () => {
    embedding.isEnabled.mockReturnValue(false);
    await service.onModuleInit();
    expect(vectorStore.listKnowledge).not.toHaveBeenCalled();
    expect(vectorStore.addChunks).not.toHaveBeenCalled();
  });

  it('知识库已有同名文档时跳过，新增文档仍加载（文档级幂等）', async () => {
    vectorStore.listKnowledge.mockReturnValue([
      { docName: '已有文档.md', chunkCount: 3 },
    ]);
    await writeFile(
      join(tempDir, '已有文档.md'),
      '已有内容。\n'.repeat(20),
      'utf8',
    );
    await writeFile(
      join(tempDir, '新增文档.md'),
      '新增规则：营销活动创建后需激活。\n'.repeat(20),
      'utf8',
    );
    const loaded = await service.seedFromDir(tempDir);
    // 已有文档跳过，仅加载新增文档
    expect(loaded).toBe(1);
    expect(vectorStore.addChunks).toHaveBeenCalledTimes(1);
    const calls = vectorStore.addChunks.mock.calls as unknown as Array<
      [string, string, unknown[]]
    >;
    const docName = calls[0][1];
    expect(docName).toBe('新增文档.md');
  });

  it('知识库为空时加载目录下全部 markdown 文档', async () => {
    await writeFile(
      join(tempDir, '规则A.md'),
      '单据编号规则：前缀+日期8位+5位序号。\n'.repeat(20),
      'utf8',
    );
    await writeFile(
      join(tempDir, '规则B.md'),
      '库存预警：低于安全线触发预警推送。\n'.repeat(20),
      'utf8',
    );

    const loaded = await service.seedFromDir(tempDir);

    expect(loaded).toBe(2);
    expect(vectorStore.addChunks).toHaveBeenCalledTimes(2);
    expect(vectorStore.addChunks).toHaveBeenNthCalledWith(
      1,
      'default',
      '规则A.md',
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.any(String) as string,
          embedding: expect.any(Array) as number[],
        }),
      ]),
    );
  });

  it('无有效内容的文档跳过且不计入加载数', async () => {
    await writeFile(join(tempDir, '空文档.md'), '   \n  \n', 'utf8');
    await writeFile(
      join(tempDir, '有效文档.md'),
      '系统功能说明：工作台/收银台/业务管理。\n'.repeat(20),
      'utf8',
    );

    const loaded = await service.seedFromDir(tempDir);

    expect(loaded).toBe(1);
    expect(vectorStore.addChunks).toHaveBeenCalledTimes(1);
  });
});
