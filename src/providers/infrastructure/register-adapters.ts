import { AnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { OpenAIAdapter } from './adapters/openai/adapter.ts';
import { FakeProvider } from './fake/fake-provider.ts';
import { InMemoryProviderRegistry } from './registry.ts';

/**
 * Registers built-in provider adapters on a fresh registry.
 */
export function createDefaultProviderRegistry(): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  registry.register(new FakeProvider());
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  return registry;
}
