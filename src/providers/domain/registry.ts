import type { ModelCapabilities } from './capabilities.ts';

/**
 * Registry records as the rest of the app sees them.
 */

export type ProviderStatus = 'active' | 'disabled';
export type ModelStatus = 'active' | 'disabled';

export interface ProviderRecord {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly baseUrl: string | null;
  readonly secretRef: string;
  readonly status: ProviderStatus;
  readonly config: Readonly<Record<string, unknown>>;
  readonly configVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerDisplayName: string;
  readonly providerStatus: ProviderStatus;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: ModelStatus;
  readonly capabilities: ModelCapabilities;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly quotaWeight: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function usableForNewConversation(model: Pick<ModelRecord, 'status'>): boolean {
  return model.status === 'active';
}

/** Only active models can accept new messages in existing conversations. */
export function sendableInExistingConversation(model: Pick<ModelRecord, 'status'>): boolean {
  return model.status === 'active';
}

/** Visible in `GET /models` for a new conversation: active models only (disabled hidden). */
export function visibleInModelPicker(model: Pick<ModelRecord, 'status'>): boolean {
  return model.status === 'active';
}

/** A provider must be enabled for its models to be used at all. */
export function providerEnabled(provider: Pick<ProviderRecord, 'status'>): boolean {
  return provider.status === 'active';
}
