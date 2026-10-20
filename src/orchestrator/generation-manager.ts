import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { Config } from '@/config/index.ts';
import { getLogger } from '@/observability/logger.ts';
import type { ProviderRegistry } from '@/providers/ports/provider-registry.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type {
  GenerationRecord,
  GenerationRepository,
} from '@/generations/ports/generation-repository.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { Finalizer } from '@/generations/application/finalizer.ts';
import { Checkpointer } from '@/generations/application/checkpointer.ts';
import { AppError } from '@/errors.ts';
import { GenerationRun, type GenerationRunHooks } from './generation-run.ts';
import type { Subscriber } from './subscriber.ts';
import type { ArtifactSink } from '@/artifactsink/artifact-sink.ts';
import { ARTIFACT_FETCH_TIMEOUT_MS } from '@/artifactsink/artifact-sink.ts';
import type { PartType } from '@/conversations/domain/conversation.ts';

export interface EnqueueInput {
  readonly generation: GenerationRecord;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly chatRequest: NormalizedChatRequest;
  readonly contextInfo: {
    readonly truncated: boolean;
    readonly droppedMessageCount?: number | undefined;
  };
  readonly hooks?: GenerationRunHooks | undefined;
}

export interface SubscribeResult {
  readonly found: boolean;
  readonly canReplay: boolean;
  readonly subscriber?: Subscriber | undefined;
}

export interface GenerationManagerDeps {
  readonly providerRegistry: ProviderRegistry;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly config: Config;
  readonly finalizer?: Finalizer | undefined;
  readonly generationRepo?: GenerationRepository | undefined;
  readonly conversationRepo?: ConversationRepository | undefined;
  /** Hydrates provider-generated binaries (cloud containers). Absent ⇒ file parts fail. */
  readonly artifactSink?: ArtifactSink | undefined;
}

export class GenerationManager {
  private readonly runs = new Map<string, GenerationRun>();
  private readonly providerRegistry: ProviderRegistry;
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly config: Config;
  private readonly finalizer?: Finalizer | undefined;
  private readonly generationRepo?: GenerationRepository | undefined;
  private readonly conversationRepo?: ConversationRepository | undefined;
  private readonly artifactSink?: ArtifactSink | undefined;
  isDraining = false;

  constructor(deps: GenerationManagerDeps) {
    this.providerRegistry = deps.providerRegistry;
    this.clock = deps.clock;
    this.idGen = deps.idGen;
    this.config = deps.config;
    this.finalizer = deps.finalizer;
    this.generationRepo = deps.generationRepo;
    this.conversationRepo = deps.conversationRepo;
    this.artifactSink = deps.artifactSink;
  }

  get activeCount(): number {
    return this.runs.size;
  }

  getRun(generationId: string): GenerationRun | undefined {
    return this.runs.get(generationId);
  }

  enqueue(input: EnqueueInput): GenerationRun {
    if (this.isDraining) {
      throw new AppError('service_busy', 'Server is shutting down', {
        details: { retryAfterSeconds: 5 },
      });
    }

    if (this.runs.size >= this.config.MAX_ACTIVE_GENERATIONS) {
      throw new AppError('service_busy', 'Max active generations reached', {
        details: { retryAfterSeconds: 5 },
      });
    }

    const adapter = this.providerRegistry.get(input.chatRequest.provider.adapter);
    if (adapter === null) {
      throw new AppError(
        'internal_error',
        `No adapter registered for '${input.chatRequest.provider.adapter}'`,
      );
    }

    const checkpointer =
      this.generationRepo !== undefined
        ? new Checkpointer({
            generationId: input.generation.id,
            generationRepo: this.generationRepo,
            clock: this.clock,
          })
        : undefined;

    const run = new GenerationRun({
      generation: input.generation,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      chatRequest: input.chatRequest,
      adapter,
      contextInfo: input.contextInfo,
      clock: this.clock,
      idGen: this.idGen,
      config: {
        detachTimeoutSeconds: this.config.GENERATION_DETACH_TIMEOUT_SECONDS,
      },
      hooks: {
        onStart: async (genId) => {
          if (this.generationRepo !== undefined) {
            await this.generationRepo.markGenerating(genId, this.clock.now());
          }
          if (input.hooks?.onStart !== undefined) {
            await input.hooks.onStart(genId);
          }
        },
        onPartStarted: async (part) => {
          if (this.conversationRepo !== undefined) {
            const partType: PartType =
              part.type === 'text' ? 'text' : part.type === 'image' ? 'image' : 'generated_file';
            const data: Record<string, unknown> = {};
            if (part.name !== undefined) data['name'] = part.name;
            if (part.mimeType !== undefined) data['mimeType'] = part.mimeType;
            await this.conversationRepo.insertParts([
              {
                id: part.partId,
                messageId: input.assistantMessageId,
                position: part.position,
                type: partType,
                // `generated_file`/`image` parts stay `streaming` until the ArtifactSink links
                // the stored bytes — the DB CHECK forbids `complete` without a `file_id`.
                status: 'streaming',
                textContent: part.type === 'text' ? '' : null,
                data,
                fileId: null,
                createdAt: this.clock.now(),
                updatedAt: this.clock.now(),
              },
            ]);
          }
          if (input.hooks?.onPartStarted !== undefined) {
            await input.hooks.onPartStarted(part);
          }
        },
        onArtifact: async (artifact) => {
          if (this.artifactSink === undefined) return null;
          const fetchArtifactStream = adapter.fetchArtifactStream?.bind(adapter);
          if (fetchArtifactStream === undefined && artifact.bytes === undefined) return null;
          const provider = input.chatRequest.provider;
          return await this.artifactSink.hydrate(
            {
              partId: artifact.partId,
              userId: input.generation.userId,
              conversationId: input.generation.conversationId,
              messageId: input.assistantMessageId,
              providerFileId: artifact.providerFileId,
              filename: artifact.filename,
              ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
              ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
              ...(artifact.bytes !== undefined ? { bytes: artifact.bytes } : {}),
            },
            async (providerFileId) => {
              if (fetchArtifactStream === undefined) {
                throw new Error('adapter cannot download artifacts');
              }
              return await fetchArtifactStream(providerFileId, {
                provider,
                signal: AbortSignal.timeout(ARTIFACT_FETCH_TIMEOUT_MS),
              });
            },
          );
        },
        onTextChunk: (partId, chunk, lastEventSeq) => {
          checkpointer?.append(partId, chunk, lastEventSeq);
          input.hooks?.onTextChunk?.(partId, chunk, lastEventSeq);
        },
        onHeartbeat: async (genId) => {
          if (checkpointer !== undefined) {
            await checkpointer.flush();
          }
          if (input.hooks?.onHeartbeat !== undefined) {
            await input.hooks.onHeartbeat(genId);
          }
        },
        onFinalize: async (outcome) => {
          if (checkpointer !== undefined) {
            await checkpointer.dispose();
          }

          if (this.finalizer !== undefined) {
            await this.finalizer.finalize({
              generationId: run.generationId,
              status: outcome.status,
              finishReason: outcome.finishReason,
              error: outcome.error,
              accumulatedText: outcome.accumulatedText,
              usage: outcome.usage,
              ...(outcome.cancelReason !== undefined ? { cancelReason: outcome.cancelReason } : {}),
              ...(outcome.fallbackPartId !== undefined
                ? { fallbackPartId: outcome.fallbackPartId }
                : {}),
            });
          }

          this.runs.delete(run.generationId);

          const providerKey = input.chatRequest.provider.key;
          const modelKey = input.chatRequest.model.apiModelId;

          const durationSeconds = run.durationSeconds(this.clock.now());
          const ttftSeconds = run.timeToFirstTokenSeconds;
          getLogger().info(
            {
              generationId: run.generationId,
              provider: providerKey,
              model: modelKey,
              status: outcome.status,
              finishReason: outcome.finishReason,
              durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
              ttftMs: ttftSeconds === null ? null : Math.round(ttftSeconds * 1000),
              errorCategory: outcome.error?.code ?? null,
            },
            'generation run finished',
          );

          if (input.hooks?.onFinalize !== undefined) {
            await input.hooks.onFinalize(outcome);
          }
        },
      },
    });

    this.runs.set(run.generationId, run);

    getLogger().info(
      {
        generationId: run.generationId,
        provider: input.chatRequest.provider.key,
        model: input.chatRequest.model.apiModelId,
        activeGenerations: this.runs.size,
      },
      'generation run started',
    );

    void run.start();

    return run;
  }

  subscribe(generationId: string, lastEventSeq?: number): SubscribeResult {
    const run = this.runs.get(generationId);
    if (run === undefined) {
      return { found: false, canReplay: false };
    }

    const subId = this.idGen.uuidv7();
    const result = run.subscribe(subId, lastEventSeq);

    return {
      found: true,
      canReplay: result.canReplay,
      subscriber: result.subscriber,
    };
  }

  cancel(generationId: string, reason = 'user_cancel'): boolean {
    const run = this.runs.get(generationId);
    if (run === undefined) return false;
    run.abort(reason);
    return true;
  }

  /**
   * Initiates graceful shutdown: rejects new admissions, allows runs to finish naturally
   * within the drain window, and then aborts any remaining active runs with reason 'shutdown'.
   */
  async shutdown(drainTimeoutSeconds?: number): Promise<void> {
    this.isDraining = true;
    const timeout = (drainTimeoutSeconds ?? this.config.SHUTDOWN_DRAIN_SECONDS) * 1000;
    const deadline = this.clock.now().getTime() + timeout;

    while (this.runs.size > 0 && this.clock.now().getTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.runs.size > 0) {
      for (const run of this.runs.values()) {
        run.abort('shutdown');
      }

      const graceDeadline = this.clock.now().getTime() + 2000;
      while (this.runs.size > 0 && this.clock.now().getTime() < graceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
