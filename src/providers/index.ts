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
export {
  ModelCapabilitiesSchema,
  parseCapabilities,
  parseConfig,
  toCapabilitiesJson,
  CAPABILITIES_SCHEMA_VERSION,
} from './domain/capabilities-schema.ts';
export type { ModelRecord, ModelStatus, ProviderRecord, ProviderStatus } from './domain/registry.ts';
export {
  providerEnabled,
  sendableInExistingConversation,
  usableForNewConversation,
  visibleInModelPicker,
} from './domain/registry.ts';
export { validatePartsForModel, violationMessage } from './domain/capability-validation.ts';

export type {
  CreateModelInput,
  CreateProviderInput,
  ProviderHealth,
  RegistryAdminService,
  SetPriceInput,
  UpdateModelInput,
  UpdateProviderInput,
} from './application/registry-admin-service.ts';
export { createRegistryAdminService } from './application/registry-admin-service.ts';

export type {
  ProviderAdapter,
  EstimateResult,
  ExecuteContext,
  HealthCheckContext,
  HealthCheckResult,
} from './ports/provider-adapter.ts';
export type { ProviderRegistry } from './ports/provider-registry.ts';
export type { ModelRegistry, ResolvedModel } from './ports/model-registry.ts';
export type {
  CreateModelInput as RepoCreateModelInput,
  ModelPrice,
  RegistryRepository,
  UpsertPriceInput,
} from './ports/registry-repository.ts';
export type { SecretResolver } from './ports/secret-resolver.ts';

export { InMemoryProviderRegistry } from './infrastructure/registry.ts';
export { createDefaultProviderRegistry } from './infrastructure/register-adapters.ts';
export { DrizzleRegistryRepository } from './infrastructure/drizzle-registry-repository.ts';
export { CachedModelRegistry } from './infrastructure/cached-registry.ts';
export { EnvSecretResolver } from './ports/secret-resolver.ts';
export { OpenAIAdapter } from './infrastructure/adapters/openai/adapter.ts';
export { AnthropicAdapter } from './infrastructure/adapters/anthropic/adapter.ts';
export { GeminiAdapter } from './infrastructure/adapters/gemini/adapter.ts';
export {
  FakeProvider,
  makeChatRequest,
  type FakeProviderOptions,
  type FakeScenario,
} from './infrastructure/fake/fake-provider.ts';
