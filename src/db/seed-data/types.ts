export interface SeedProvider {
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly secretRef: string;
  readonly status: 'active' | 'disabled';
  readonly config: Record<string, unknown>;
}

export interface SeedModel {
  readonly providerKey: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly description: string;
  readonly status: 'active' | 'disabled';
  readonly capabilities: Record<string, unknown>;
  readonly config?: Record<string, unknown> | undefined;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly quotaWeight: string;
  readonly sortOrder: number;
}

export interface SeedModelPrice {
  readonly providerKey: string;
  readonly apiModelId: string;
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cachedInputMicrosPerMtok: number;
}

export interface SeedDivision {
  readonly id: string;
  readonly name: string;
  readonly externalRef: string;
  readonly createdAt: Date;
}

export interface SeedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'user' | 'admin' | 'super_admin';
  readonly status: 'active' | 'disabled';
  readonly divisionName: string | null;
  readonly mustChangePassword: boolean;
  readonly failedLoginAttempts: number;
  readonly createdAt: Date;
  readonly lastLoginAt: Date;
}

export interface SeedQuotaPolicy {
  readonly id: string;
  readonly scope: 'global' | 'division' | 'user';
  readonly divisionName?: string | undefined;
  readonly userEmail?: string | undefined;
  readonly monthlyTokens: number;
  readonly maxInputTokensPerRequest: number;
  readonly maxOutputTokensPerRequest: number;
  readonly maxConcurrentGenerations: number;
}

export interface SeedAttachment {
  readonly id: string;
  readonly ownerEmail: string;
  readonly conversationId: string;
  readonly messageId?: string | undefined;
  readonly origin: 'input' | 'generated';
  readonly kind: 'image' | 'document' | 'other';
  readonly displayName: string;
  readonly declaredMime: string;
  readonly detectedMime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageProvider: string;
  readonly storageKey: string;
  readonly status: 'ready';
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly pageCount?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly extractionText?: string | undefined;
  readonly charCount?: number | undefined;
  readonly tokenEstimate?: number | undefined;
  readonly createdAt: Date;
}

export interface SeedConversation {
  readonly id: string;
  readonly userEmail: string;
  readonly providerKey: string;
  readonly apiModelId: string;
  readonly title: string;
  readonly messageCount: number;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
}

export interface SeedMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly status: 'complete';
  readonly finishReason?: 'stop' | undefined;
  readonly textContent: string;
  readonly fileId?: string | undefined;
  readonly createdAt: Date;
  readonly completedAt: Date;
  readonly estInputTokens?: number | undefined;
  readonly estOutputTokens?: number | undefined;
  readonly durationMs?: number | undefined;
}

export interface SeedAuditLog {
  readonly action: string;
  readonly actorEmail: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip: string;
  readonly requestId: string;
  readonly createdAt: Date;
}

export interface SeedErrorEvent {
  readonly component: string;
  readonly category: string;
  readonly message: string;
  readonly context: Record<string, unknown>;
  readonly providerKey?: string | undefined;
  readonly apiModelId?: string | undefined;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface SeedDailyUsage {
  readonly day: string;
  readonly userEmail: string;
  readonly divisionName: string;
  readonly providerKey: string;
  readonly apiModelId: string;
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly quotaTokens: number;
  readonly estCostMicros: number;
}
