import { Module } from '@nestjs/common';
import { DeepSeekProvider } from './deepseek.provider';
import { GlmProvider } from './glm.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderFactory } from './provider-factory';

/**
 * Provider 模块
 *
 * 注册所有 LLM Provider（GLM / DeepSeek / Ollama）+ ProviderFactory，
 * 导出 ProviderFactory 供其他模块（Brain / Gateway）注入使用。
 *
 * 后续新增 Provider（如 QwenProvider）时：
 * 1. 创建 src/providers/xxx.provider.ts，实现 IModelProvider 接口
 * 2. 在本模块 providers 数组中注册
 * 3. 在 ProviderFactory 构造函数中注入并 set 到 providers Map
 */
@Module({
  providers: [GlmProvider, DeepSeekProvider, OllamaProvider, ProviderFactory],
  exports: [ProviderFactory, GlmProvider, DeepSeekProvider, OllamaProvider],
})
export class ProvidersModule {}
