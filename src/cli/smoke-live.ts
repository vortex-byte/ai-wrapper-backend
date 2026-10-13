import { createDefaultProviderRegistry } from '../providers/infrastructure/register-adapters.ts';
import { makeChatRequest } from '../providers/infrastructure/fake/fake-provider.ts';

function providerKey(args: readonly string[]): string | undefined {
  const index = args.indexOf('--provider');
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runLiveSmoke(args: readonly string[]): Promise<number> {
  const key = providerKey(args);
  if (key !== 'openai' && key !== 'anthropic') {
    console.error('Usage: bun run cli smoke-live --provider <openai|anthropic>');
    return 2;
  }

  const secret = key === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (secret === undefined || secret === '') {
    console.error(`Missing ${key === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}.`);
    return 2;
  }

  const adapter = createDefaultProviderRegistry().get(key);
  if (adapter === null) {
    console.error(`Provider adapter is not registered: ${key}`);
    return 1;
  }

  const request = makeChatRequest({
    requestId: `smoke-${Date.now()}`,
    generationId: `smoke-${Date.now()}`,
    provider: {
      ...makeChatRequest().provider,
      key,
      adapter: key,
      secrets: { apiKey: secret },
    },
  });
  const controller = new AbortController();
  let text = '';
  let hasUsage = false;
  let terminal = false;
  try {
    for await (const event of adapter.execute(request, {
      signal: controller.signal,
      deadline: Date.now() + 120_000,
    })) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'usage') hasUsage = true;
      if (event.type === 'finished') terminal = true;
      if (event.type === 'error') {
        console.error(`${key} smoke failed: ${event.error.category}`);
        return 1;
      }
    }
  } finally {
    controller.abort();
  }

  if (!terminal || text.length === 0 || !hasUsage) {
    console.error(`${key} smoke failed: incomplete stream or missing usage.`);
    return 1;
  }
  console.log(`${key} smoke passed.`);
  return 0;
}
