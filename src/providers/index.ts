// PAL (normalized types + error vocabulary)
export type {
  NormalizedPart,
  NormalizedMessage,
  ResolvedFile,
  GenerationEvent,
  TokenUsage,
} from './domain/pal.ts';
export type { AppErrorCategory, ProviderError } from './domain/errors.ts';
export { providerError } from './domain/errors.ts';
export type {
  DocumentCapabilities,
  ModelCapabilities,
  ModelRuntimeConfig,
  ProviderRuntimeConfig,
  NormalizedChatRequest,
} from './domain/capabilities.ts';

// Ports
export type {
  ProviderAdapter,
  EstimateResult,
  ExecuteContext,
  HealthCheckResult,
} from './ports/provider-adapter.ts';
export type { ProviderRegistry } from './ports/provider-registry.ts';

// Infrastructure
export { InMemoryProviderRegistry } from './infrastructure/registry.ts';
export {
  FakeProvider,
  makeChatRequest,
  type FakeProviderOptions,
  type FakeScenario,
} from './infrastructure/fake/fake-provider.ts';
