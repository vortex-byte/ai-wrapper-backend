import { AnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { OpenAIAdapter } from './adapters/openai/adapter.ts';
import { FakeProvider } from './fake/fake-provider.ts';
import { InMemoryProviderRegistry } from './registry.ts';

/**
 * Registers every built-in adapter on a fresh registry. Lives inside `providers/` so the
 * SDK imports stay confined here; the composition root calls this instead of
 * importing adapters directly.
 *
 * Phase 1 registers `fake`, `openai` and `anthropic`. Gemini is deliberately **not**
 * registered until Phase 4, where adding it must require zero core changes.
 */
export function createDefaultProviderRegistry(): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  registry.register(new FakeProvider());
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  return registry;
}
