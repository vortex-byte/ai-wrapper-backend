import { describe, expect, it } from 'vitest';
import {
  FakeProvider,
  InMemoryProviderRegistry,
  makeChatRequest,
} from '@/providers/index.ts';
import type { GenerationEvent, ProviderError } from '@/providers/index.ts';

async function collect(
  provider: FakeProvider,
  signal: AbortSignal = new AbortController().signal,
): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of provider.execute(makeChatRequest(), { signal, deadline: Date.now() + 5_000 })) {
    events.push(event);
  }
  return events;
}

function terminal(events: GenerationEvent[]): GenerationEvent {
  const last = events.at(-1);
  if (last === undefined) throw new Error('no events emitted');
  return last;
}

describe('FakeProvider', () => {
  it('streams text, usage and a stop finish for the success scenario', async () => {
    const provider = new FakeProvider({ chunks: ['a', 'b', 'c'] });
    const events = await collect(provider);

    expect(events[0]).toEqual({ type: 'started', providerRequestId: 'fake-request-1' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(terminal(events)).toEqual({ type: 'finished', reason: 'stop' });

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect(provider.expectedText()).toBe('abc');
  });

  it('emits exactly one terminal event per execution', async () => {
    const events = await collect(new FakeProvider());
    const terminals = events.filter((e) => e.type === 'finished' || e.type === 'error');
    expect(terminals).toHaveLength(1);
  });

  it('fails before any output for the error_before_output scenario', async () => {
    const events = await collect(new FakeProvider({ scenario: 'error_before_output' }));
    expect(events).toHaveLength(1);
    expect(terminal(events).type).toBe('error');
  });

  it('emits deltas then fails for the error_after_output scenario', async () => {
    const events = await collect(new FakeProvider({ scenario: 'error_after_output' }));
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(terminal(events).type).toBe('error');
  });

  it('surfaces a retryable provider_rate_limited error', async () => {
    const events = await collect(new FakeProvider({ scenario: 'provider_rate_limited' }));
    const last = terminal(events);
    expect(last.type).toBe('error');
    const error = (last as { type: 'error'; error: ProviderError }).error;
    expect(error.category).toBe('provider_rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1_000);
  });

  it('finishes with content_filter for the content_filtered scenario', async () => {
    const events = await collect(new FakeProvider({ scenario: 'content_filtered' }));
    expect(terminal(events)).toEqual({ type: 'finished', reason: 'content_filter' });
  });

  it('stops when the caller signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({ chunks: ['a', 'b', 'c'], chunkDelayMs: 5 });
    const events: GenerationEvent[] = [];
    for await (const event of provider.execute(makeChatRequest(), {
      signal: controller.signal,
      deadline: Date.now() + 5_000,
    })) {
      events.push(event);
      if (event.type === 'text_delta') controller.abort();
    }
    const last = terminal(events);
    expect(last.type).toBe('error');
    const error = (last as { type: 'error'; error: ProviderError }).error;
    expect(error.category).toBe('generation_cancelled');
  });

  it('estimates input tokens deterministically (offline)', async () => {
    const provider = new FakeProvider();
    const first = await provider.estimateInputTokens(makeChatRequest());
    const second = await provider.estimateInputTokens(makeChatRequest());
    expect(first).toEqual(second);
    expect(first.confidence).toBe('approx');
    expect(first.tokens).toBeGreaterThan(0);
  });

  it('toProviderRequest carries no provider-specific message shapes', () => {
    const request = new FakeProvider().toProviderRequest(makeChatRequest());
    expect(request).toMatchObject({ model: 'fake-model', messages: [{ role: 'user', parts: ['text'] }] });
  });

  it('reports unhealthy only for the provider_unavailable scenario', async () => {
    const ok = await new FakeProvider().healthCheck({ signal: new AbortController().signal });
    const down = await new FakeProvider({ scenario: 'provider_unavailable' }).healthCheck({
      signal: new AbortController().signal,
    });
    expect(ok.ok).toBe(true);
    expect(down.ok).toBe(false);
  });
});

describe('InMemoryProviderRegistry', () => {
  it('registers and resolves adapters by adapterKey', () => {
    const registry = new InMemoryProviderRegistry();
    const provider = new FakeProvider();
    registry.register(provider);

    expect(registry.has('fake')).toBe(true);
    expect(registry.get('fake')).toBe(provider);
    expect(registry.keys()).toEqual(['fake']);
  });

  it('returns null for an unregistered adapter', () => {
    expect(new InMemoryProviderRegistry().get('nope')).toBeNull();
  });
});
