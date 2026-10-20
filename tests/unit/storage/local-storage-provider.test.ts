import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageProvider } from '@/storage/infrastructure/local-storage-provider.ts';

const roots: string[] = [];

async function makeProvider(): Promise<{ provider: LocalStorageProvider; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  roots.push(root);
  return { provider: new LocalStorageProvider(root), root };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('LocalStorageProvider', () => {
  it('round-trips a blob and reports its hash and size', async () => {
    const { provider } = await makeProvider();
    const bytes = new TextEncoder().encode('hello storage');

    const stored = await provider.putStream('files/2026-10/a', bytes, {
      contentType: 'text/plain',
      maxBytes: 1024,
    });

    expect(stored.key).toBe('files/2026-10/a');
    expect(stored.sizeBytes).toBe(bytes.byteLength);

    const got = await provider.getStream('files/2026-10/a');
    expect(new TextDecoder().decode(await new Response(got.stream).arrayBuffer())).toBe(
      'hello storage',
    );
  });

  it('serves an empty body for a range request over a zero-byte blob', async () => {
    const { provider } = await makeProvider();
    await provider.putStream('files/2026-10/empty', new Uint8Array(), {
      contentType: 'text/plain',
      maxBytes: 1024,
    });

    const result = await provider.getStream('files/2026-10/empty', { start: 0 });

    expect(result.sizeBytes).toBe(0);
    expect((await new Response(result.stream).arrayBuffer()).byteLength).toBe(0);
  });

  it('ranges a non-empty blob', async () => {
    const { provider } = await makeProvider();
    await provider.putStream('files/2026-10/r', new TextEncoder().encode('0123456789'), {
      contentType: 'text/plain',
      maxBytes: 1024,
    });

    const result = await provider.getStream('files/2026-10/r', { start: 2, end: 4 });

    expect(result.sizeBytes).toBe(3);
    expect(await new Response(result.stream).text()).toBe('234');
  });

  it('replaces an existing blob and leaves no temp file behind', async () => {
    const { provider, root } = await makeProvider();
    const options = { contentType: 'text/plain', maxBytes: 1024 };

    await provider.putStream('files/2026-10/same', new TextEncoder().encode('first'), options);
    await provider.putStream('files/2026-10/same', new TextEncoder().encode('second'), options);

    const got = await new Response((await provider.getStream('files/2026-10/same')).stream).text();
    expect(got).toBe('second');

    // Each write stages under a unique `<key>.<pid>.<uuid>.tmp` and renames it into place.
    const entries = await fs.readdir(path.join(root, 'files', '2026-10'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('never lists in-flight temp files as stored keys', async () => {
    const { provider, root } = await makeProvider();
    await fs.mkdir(path.join(root, 'files', '2026-10'), { recursive: true });
    await fs.writeFile(path.join(root, 'files', '2026-10', 'live'), 'live');
    await fs.writeFile(path.join(root, 'files', '2026-10', 'live.1234.uuid.tmp'), 'partial');

    expect(await provider.listKeys('files/')).toEqual(['files/2026-10/live']);
  });

  it('refuses a key that escapes the root', async () => {
    const { provider } = await makeProvider();
    await expect(provider.exists('../../etc/passwd')).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
  });
});
