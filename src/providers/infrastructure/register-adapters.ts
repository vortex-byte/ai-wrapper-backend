import { AnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { GeminiAdapter } from './adapters/gemini/adapter.ts';
import { OpenAIAdapter } from './adapters/openai/adapter.ts';
import { FakeProvider } from './fake/fake-provider.ts';
import { InMemoryProviderRegistry } from './registry.ts';

export function createDefaultProviderRegistry(options?: {
  readonly includeFake?: boolean;
}): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  const includeFake = options?.includeFake ?? process.env['NODE_ENV'] !== 'production';
  if (includeFake) {
    registry.register(new FakeProvider());
  }
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  registry.register(new GeminiAdapter());
  return registry;
}
