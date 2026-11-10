import type {
  SeedAttachment,
  SeedConversation,
  SeedMessage,
} from './types.ts';

export const FLAGSHIP_CONVERSATION_ID = '00000000-0000-7000-8003-000000000001';

export const SEED_ATTACHMENTS: readonly SeedAttachment[] = [
  {
    id: '00000000-0000-7000-8006-000000000001',
    ownerEmail: 'sarah.chen@corp.example',
    conversationId: '00000000-0000-7000-8003-000000000001',
    origin: 'input',
    kind: 'document',
    displayName: 'explain_analyze_streaming_trace.txt',
    declaredMime: 'text/plain',
    detectedMime: 'text/plain',
    sizeBytes: 14_250,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    storageProvider: 'local',
    storageKey: 'files/2026/10/00000000-0000-7000-8006-000000000001',
    status: 'ready',
    extractionText: `Execution Plan for UPDATE message_parts:\nUpdate on message_parts (cost=0.42..8.44 rows=1 width=382) (actual time=0.084..0.085 rows=0 loops=1)\n  Buffers: shared hit=4 dirtied=1\n  -> Index Scan using message_parts_pkey on message_parts (cost=0.42..8.44 rows=1 width=382) (actual time=0.041..0.042 rows=1 loops=1)\n        Index Cond: (id = '018f...-....')\n        Buffers: shared hit=3\nPlanning Time: 0.125 ms\nExecution Time: 0.112 ms`,
    charCount: 420,
    tokenEstimate: 110,
    createdAt: new Date('2026-10-15T09:00:00Z'),
  },
  {
    id: '00000000-0000-7000-8006-000000000002',
    ownerEmail: 'sarah.chen@corp.example',
    conversationId: '00000000-0000-7000-8003-000000000001',
    origin: 'input',
    kind: 'document',
    displayName: 'architecture_specification_v2.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    sizeBytes: 845_200,
    sha256: 'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e',
    storageProvider: 'local',
    storageKey: 'files/2026/10/00000000-0000-7000-8006-000000000002',
    status: 'ready',
    pageCount: 16,
    extractionText: 'High-Concurrency SSE Streaming Architecture Specification\n1. Overview\nThis document details the decoupled ring-buffer coalescer and database checkpointing mechanism.\n2. Invariants\nDB is never touched inside stream chunks. Checkpointer commits at 1s / 2KB boundaries.',
    charCount: 285,
    tokenEstimate: 75,
    createdAt: new Date('2026-10-15T09:05:00Z'),
  },
  {
    id: '00000000-0000-7000-8006-000000000003',
    ownerEmail: 'sarah.chen@corp.example',
    conversationId: '00000000-0000-7000-8003-000000000003',
    origin: 'input',
    kind: 'document',
    displayName: 'Dockerfile.optimized',
    declaredMime: 'text/plain',
    detectedMime: 'text/plain',
    sizeBytes: 2_150,
    sha256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    storageProvider: 'local',
    storageKey: 'files/2026/10/00000000-0000-7000-8006-000000000003',
    status: 'ready',
    extractionText: 'FROM oven/bun:1.2-slim AS builder\nWORKDIR /app\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\nCOPY src ./src\nRUN bun build src/server.ts --target bun --outdir dist',
    charCount: 198,
    tokenEstimate: 52,
    createdAt: new Date('2026-10-18T14:00:00Z'),
  },
  {
    id: '00000000-0000-7000-8006-000000000004',
    ownerEmail: 'sarah.chen@corp.example',
    conversationId: '00000000-0000-7000-8003-000000000004',
    origin: 'input',
    kind: 'document',
    displayName: 'benchmark_results.csv',
    declaredMime: 'text/csv',
    detectedMime: 'text/csv',
    sizeBytes: 38_400,
    sha256: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
    storageProvider: 'local',
    storageKey: 'files/2026/10/00000000-0000-7000-8006-000000000004',
    status: 'ready',
    extractionText: 'concurrency,rps,p50_latency,p99_latency,error_count\n10,1420,4.2ms,12.8ms,0\n50,4890,9.1ms,24.5ms,0\n100,8210,14.6ms,48.2ms,0\n150,11400,21.3ms,86.0ms,0',
    charCount: 160,
    tokenEstimate: 45,
    createdAt: new Date('2026-10-20T11:15:00Z'),
  },
  {
    id: '00000000-0000-7000-8006-000000000005',
    ownerEmail: 'sarah.chen@corp.example',
    conversationId: '00000000-0000-7000-8003-000000000006',
    origin: 'input',
    kind: 'image',
    displayName: 'database_flamegraph.png',
    declaredMime: 'image/png',
    detectedMime: 'image/png',
    sizeBytes: 420_800,
    sha256: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
    storageProvider: 'local',
    storageKey: 'files/2026/10/00000000-0000-7000-8006-000000000005',
    status: 'ready',
    width: 1920,
    height: 1080,
    createdAt: new Date('2026-10-22T16:45:00Z'),
  },
];

function padId(n: number): string {
  return n.toString().padStart(12, '0');
}

// 65 distinct conversation titles for Sarah Chen
const SARAH_CONVERSATION_TITLES: readonly { title: string; provider: string; model: string }[] = [
  {
    title: 'PostgreSQL query plan optimization: EXPLAIN ANALYZE on message_parts HOT updates',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Distributed transaction isolation: READ COMMITTED vs REPEATABLE READ anomaly analysis',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Docker multi-stage build optimization for Bun runtime container',
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    title: 'SSE stream buffer backpressure handling in high-throughput gateway',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
  },
  {
    title: 'TypeScript nominal typing and opaque types pattern comparison',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Redis cache-aside with mutex lock vs probabilistic early expiration',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'Kubernetes Horizontal Pod Autoscaler tuning with custom Prometheus metrics',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Database migration rollback strategy: Forward-only expand and contract',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Argon2id parameter calibration: Memory cost vs verification latency',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Zero-copy streaming pipeline architecture using Web Streams in Bun',
    provider: 'gemini',
    model: 'gemini-3-pro',
  },
  {
    title: 'Evaluating Vector Indexing: HNSW vs IVFFlat in pgvector',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Designing a dead-letter queue and retry backoff for PostgreSQL SKIP LOCKED jobs',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'RFC: Centralized error handling and RFC 7807 problem details implementation',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
  },
  {
    title: 'Vitest test suite optimization: Testcontainers pool recycling',
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    title: 'Security audit: CSRF double-submit cookies vs stateless HMAC tokens',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Benchmarking HTTP routing trees: Radix tree vs linear match in Hono',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'OpenTelemetry span propagation across asynchronous worker boundaries',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Memory leak diagnosis in long-running Node/Bun WebSocket servers',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'PostgreSQL partial indexes and index-only scan optimization',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Designing idempotency keys: Header semantics and 422 replay safety',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
  },
  {
    title: 'Architecting an append-only audit trail with cryptographic prev_hash chaining',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Evaluating Tokenizer implementations: js-tiktoken vs BPE wasm in edge runtimes',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'PostgreSQL connection pool sizing: Little’s Law and PgBouncer thread allocation',
    provider: 'gemini',
    model: 'gemini-3-pro',
  },
  {
    title: 'Safe zero-downtime column renaming in Drizzle ORM migrations',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Implementing adaptive rate limiters with sliding window counter in Redis',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Designing multi-tenant quota reservations: Two-phase commit vs conditional UPDATE',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Tuning Linux kernel TCP backlog and epoll parameters for 50k SSE streams',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Evaluating Claude 3.7 Sonnet reasoning tokens for complex compiler construction',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
  },
  {
    title: 'Mitigating N+1 queries in Drizzle relational query builder',
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    title: 'Disaster Recovery RPO and RTO validation: Automated PITR drills with WAL archiving',
    provider: 'gemini',
    model: 'gemini-3-pro',
  },
  {
    title: 'Designing resilient outbound HTTP retry policies: Jittered exponential backoff',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Database schema migration validation via shadow schemas in CI',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Optimizing Bun foreign function interface (FFI) for native SIMD operations',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Comparative analysis of structured logging formats: ECS vs OpenTelemetry log data model',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
  },
  {
    title: 'PostgreSQL autovacuum tuning for append-heavy audit log tables',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'Secure secret rotation workflow without restarting application containers',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Designing a streaming CSV parser with bounded memory footprint',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Evaluating HTTP/2 multiplexing vs HTTP/1.1 keep-alive for LLM proxy servers',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Building a robust dead-letter queue consumer with exponential backoff in Bun',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'PostgreSQL BRIN vs B-Tree indexes for massive append-only timeseries tables',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Graceful shutdown handling in Kubernetes: PreStop hook, SIGTERM and in-flight SSE streams',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Designing context window eviction algorithms: Sliding window vs summary compaction',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
  },
  {
    title: 'Preventing cache stampedes in distributed systems with XFetch probabilistic algorithm',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Comparative analysis of TypeScript runtime validation libraries: Zod vs TypeBox vs ArkType',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'Optimizing PDF text extraction pipeline: AnyDoc vs Poppler in serverless environments',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Hardening Content Security Policy (CSP) headers for enterprise AI chat portals',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Database index bloat detection and concurrent index rebuild recipes',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'Building a resilient fallback circuit breaker for multi-provider AI routing',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Understanding PostgreSQL MVCC tuple visibility and transaction ID wraparound',
    provider: 'gemini',
    model: 'gemini-3-pro',
  },
  {
    title: 'Memory profiling with heap snapshots in Bun: Identifying uncollected closures',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Designing an optimistic locking scheme for collaborative canvas documents',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'PostgreSQL partitioning by range: Monthly partitions for usage_events',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'API rate limiting headers: Comparing IETF draft RFC 9205 vs GitHub X-RateLimit',
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    title: 'Designing a tamper-evident audit trail with SHA-256 Merkle tree verification',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Evaluating Gemini 2.0 Flash function calling accuracy on nested JSON schemas',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'Database query timeout best practices: statement_timeout vs lock_timeout',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Designing an asynchronous notification engine with WebSocket and Server-Sent Events',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
  },
  {
    title: 'Securing multi-tenant S3 presigned URLs: IAM policy conditions and expiration',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Benchmarking Argon2id vs PBKDF2 vs Scrypt on modern ARM64 server architectures',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    title: 'PostgreSQL foreign key cascade locking behavior under concurrent deletions',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Designing high-availability Redis Sentinel clusters with automatic failover',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    title: 'TypeScript 5.8 const type parameters and decorator metadata usage',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Implementing adaptive exponential backoff for third-party webhook deliveries',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    title: 'Designing zero-trust network ingress for internal administrative dashboards',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    title: 'Comprehensive post-mortem analysis: Resolving socket exhaustion in gateway relay',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
];

const OTHER_USERS_CONVERSATIONS: readonly {
  userEmail: string;
  title: string;
  provider: string;
  model: string;
}[] = [
  {
    userEmail: 'david.kim@corp.example',
    title: 'Distributed consensus algorithms: Raft vs Paxos leader election under network partitions',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    userEmail: 'david.kim@corp.example',
    title: 'Evaluating CockroachDB serializable isolation vs Spanner TrueTime clock sync',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    userEmail: 'david.kim@corp.example',
    title: 'Vector database benchmarks: Milvus vs Qdrant vs pgvector latency comparison',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
  {
    userEmail: 'jordan.taylor@corp.example',
    title: 'Q4 Product Roadmap: Prioritizing multimodal document analysis features',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    userEmail: 'jordan.taylor@corp.example',
    title: 'PRD Review: Autonomous agent tool calling and artifact generation workspace',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    userEmail: 'jordan.taylor@corp.example',
    title: 'Enterprise AI user onboarding funnel metrics and retention analysis',
    provider: 'openai',
    model: 'gpt-4o-mini',
  },
  {
    userEmail: 'arjun.mehta@corp.example',
    title: 'Fine-tuning small language models vs prompt chaining for domain-specific taxonomy',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    userEmail: 'arjun.mehta@corp.example',
    title: 'Contextual retrieval chunking strategy with BM25 hybrid reranking',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    userEmail: 'arjun.mehta@corp.example',
    title: 'Quantization techniques: GGUF vs AWQ vs EXL2 throughput on NVIDIA H100',
    provider: 'gemini',
    model: 'gemini-3-pro',
  },
  {
    userEmail: 'elena.rostova@corp.example',
    title: 'Evaluation frameworks for LLM hallucinations in financial document extraction',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
  },
  {
    userEmail: 'elena.rostova@corp.example',
    title: 'Benchmarking deep reasoning trajectories across scientific mathematical proofs',
    provider: 'openai',
    model: 'o3-mini',
  },
  {
    userEmail: 'priya.patel@corp.example',
    title: 'React 19 Server Components and streaming SSR hydration optimization',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    userEmail: 'priya.patel@corp.example',
    title: 'Optimizing virtualized lists for 100,000 chat messages with dynamic row heights',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  {
    userEmail: 'lucas.silva@corp.example',
    title: 'Terraform modules for multi-region active-active PostgreSQL read replicas',
    provider: 'openai',
    model: 'gpt-4o',
  },
  {
    userEmail: 'lucas.silva@corp.example',
    title: 'Automating secret injection via HashiCorp Vault agent in Kubernetes pods',
    provider: 'gemini',
    model: 'gemini-3-flash',
  },
];

export function buildSeedConversations(): SeedConversation[] {
  const result: SeedConversation[] = [];

  SARAH_CONVERSATION_TITLES.forEach((item, idx) => {
    const num = idx + 1;
    const conversationId = `00000000-0000-7000-8003-${padId(num)}`;
    // Stagger dates: num 1 is latest (Nov 2, 2026), num 65 is ~60 days earlier (Sep 2026)
    const daysAgo = Math.floor((idx / SARAH_CONVERSATION_TITLES.length) * 55);
    const date = new Date('2026-11-02T10:00:00Z');
    date.setDate(date.getDate() - daysAgo);
    date.setMinutes(date.getMinutes() - (idx % 60));

    result.push({
      id: conversationId,
      userEmail: 'sarah.chen@corp.example',
      providerKey: item.provider,
      apiModelId: item.model,
      title: item.title,
      // Flagship conversation #1 has 62 messages; others have 2 to 6 messages
      messageCount: idx === 0 ? 62 : (idx % 3 === 0 ? 4 : 2),
      createdAt: date,
      lastMessageAt: date,
    });
  });

  OTHER_USERS_CONVERSATIONS.forEach((item, idx) => {
    const num = 100 + idx + 1;
    const conversationId = `00000000-0000-7000-8003-${padId(num)}`;
    const daysAgo = (idx % 20) + 1;
    const date = new Date('2026-11-02T09:00:00Z');
    date.setDate(date.getDate() - daysAgo);

    result.push({
      id: conversationId,
      userEmail: item.userEmail,
      providerKey: item.provider,
      apiModelId: item.model,
      title: item.title,
      messageCount: 2,
      createdAt: date,
      lastMessageAt: date,
    });
  });

  return result;
}

// 31 question/answer pairs for the 62-turn flagship thread on PostgreSQL HOT updates
const HOT_CONVERSATION_TURNS: readonly { user: string; assistant: string }[] = [
  {
    user: 'We are observing high write amplification and index bloat on the `message_parts` table during active SSE streaming checkpoints. Our checkpointer runs an UPDATE every 1 second or 2 KB per active stream. Here is our current schema and autovacuum configuration. Can you analyze the primary cause?',
    assistant:
      'The primary cause of your write amplification is non-HOT (Heap-Only Tuple) updates. In PostgreSQL, when an `UPDATE` executes, Postgres creates a new tuple on a heap page. With default `fillfactor = 100`, the current page is usually completely full, forcing Postgres to place the new tuple on a different page. When a tuple moves to another page, PostgreSQL must update EVERY index on the table (including your primary key and `(message_id, position)` index) to point to the new tuple TID. This creates severe index bloat and massive write amplification.',
  },
  {
    user: 'How exactly does Heap-Only Tuple (HOT) optimization mitigate this? If we configure `fillfactor = 80`, what does Postgres do differently during each 1-second checkpoint update?',
    assistant:
      'With `fillfactor = 80`, PostgreSQL leaves 20% of each 8KB heap page empty when new rows are inserted. When your checkpointer executes:\n```sql\nUPDATE message_parts SET text_content = text_content || $chunk, updated_at = now() WHERE id = $id;\n```\nBecause the updated columns (`text_content`, `updated_at`) are NOT part of any index, and because there is free space on the existing page, Postgres places the new tuple version directly on the SAME page. It links the old tuple to the new tuple via a HOT chain. The existing index entries continue pointing to the root tuple. No index modification takes place whatsoever!',
  },
  {
    user: 'That explains why our indexes were ballooning. Does `fillfactor = 80` apply retroactively to existing heap pages, or only newly inserted ones? How do we rewrite existing tables without incurring long exclusive table locks?',
    assistant:
      'Setting `ALTER TABLE message_parts SET (fillfactor = 80);` only alters the storage parameters for future page allocations. Existing pages remain packed at 100% until rewritten. To rewrite without an exclusive access lock, you should use `pg_repack` or create a zero-downtime shadow table: create `message_parts_new`, replicate writes via triggers, sync historic data in batches, and swap tables in an instantaneous DDL transaction.',
  },
  {
    user: 'Let us look at autovacuum parameters. Currently `autovacuum_vacuum_scale_factor` is set to the default `0.2` (20%) and `autovacuum_analyze_scale_factor` is `0.1`. On a table with 5,000,000 parts, that means 1,000,000 dead tuples before autovacuum wakes up! What values do you recommend for this workload?',
    assistant:
      'For high-frequency update tables like `message_parts`, relying on the default 20% scale factor causes huge spikes in table size before autovacuum triggers. You should set table-level autovacuum overrides:\n```sql\nALTER TABLE message_parts SET (\n  fillfactor = 80,\n  autovacuum_vacuum_scale_factor = 0.02,\n  autovacuum_vacuum_threshold = 5000,\n  autovacuum_vacuum_cost_limit = 1000,\n  autovacuum_vacuum_cost_delay = 2\n);\n```\nThis ensures vacuum runs smoothly and frequently in small bursts, pruning dead HOT chains before pages fill up.',
  },
  {
    user: 'What is the role of `autovacuum_vacuum_cost_limit` and `cost_delay`? How does PostgreSQL throttle vacuum I/O to avoid degrading live query latency?',
    assistant:
      'PostgreSQL uses an internal cost accumulator. Reading a page from shared buffers costs 1 point, reading from OS disk cache costs 10 points, and writing a dirtied page to disk costs 20 points. Once the accumulated cost reaches `autovacuum_vacuum_cost_limit` (default 200), the vacuum process sleeps for `autovacuum_vacuum_cost_delay` milliseconds. Raising `cost_limit` to 1000 or 2000 on fast NVMe storage allows vacuum to keep pace with high write rates without saturating disk queues.',
  },
  {
    user: 'How can we measure our HOT update efficiency in production? Is there a query against `pg_stat_user_tables` that reveals our exact HOT update percentage?',
    assistant:
      'Yes, you can query `pg_stat_user_tables`:\n```sql\nSELECT\n  relname,\n  n_tup_upd,\n  n_tup_hot_upd,\n  ROUND((n_tup_hot_upd::numeric / NULLIF(n_tup_upd, 0)) * 100, 2) AS hot_ratio_pct,\n  n_dead_tup,\n  last_vacuum,\n  last_autovacuum\nFROM pg_stat_user_tables\nWHERE relname = \'message_parts\';\n```\nIn a well-tuned system with `fillfactor = 80`, your `hot_ratio_pct` should consistently exceed 92-95%.',
  },
  {
    user: 'What happens to large text chunks that exceed a few kilobytes? Does PostgreSQL store them inline on the heap page, or do they move to the TOAST table? How does TOAST affect HOT updates?',
    assistant:
      'Postgres divides rows into 8 KB pages. If a row exceeds `TOAST_TUPLE_THRESHOLD` (around 2 KB), Postgres attempts inline compression (PGLZ or LZ4). If it still exceeds the threshold, the `text_content` is moved out-of-line into the companion TOAST table (`pg_toast_xxxx`). When `text_content` is TOASTed, appending chunks still updates the main row pointer, but only the modified toast chunks are written. Crucially, the main heap row remains small, which actually makes HOT updates on the main table easier to sustain!',
  },
  {
    user: 'Between PGLZ and LZ4 for TOAST compression, which one is better for our workload? We are on PostgreSQL 16 on Ubuntu 24.04.',
    assistant:
      'LZ4 is substantially superior to PGLZ for your workload. In benchmarks, LZ4 decompresses 3x to 4x faster with near-zero CPU penalty and achieves comparable compression ratios on JSON and Markdown text. You can enable LZ4 globally in `postgresql.conf`:\n```text\ndefault_toast_compression = \'lz4\'\n```\nOr per column:\n```sql\nALTER TABLE message_parts ALTER COLUMN text_content SET COMPRESSION lz4;\n```',
  },
  {
    user: 'Let us discuss indexing. Currently we have `message_parts_pkey` on `(id)`, a unique index on `(message_id, position)`, and an index on `(file_id) WHERE file_id IS NOT NULL`. None of these indexes include `text_content`. Does `updated_at` being modified prevent HOT updates?',
    assistant:
      'No! Modifying a column only breaks HOT optimization if that column is the target of an index. Because `updated_at` is not indexed, modifying `updated_at` and `text_content` does NOT prevent HOT updates. As long as `(id)` and `(message_id, position)` are not touched by the UPDATE statement, the HOT chain invariant is completely satisfied.',
  },
  {
    user: 'What if someone creates an index on `(message_id, updated_at)` in the future? What would happen to our HOT update ratio?',
    assistant:
      'It would immediately collapse to 0%! The moment an index references `updated_at`, any UPDATE that modifies `updated_at` requires a new index entry in that index. This breaks the HOT chain immediately and causes every single 1-second streaming checkpoint to perform non-HOT index updates. This is why you must strictly avoid indexing columns that receive high-frequency in-place mutations.',
  },
  {
    user: 'Can we enforce this rule in our linting or CI schema tests? How do you prevent developers from accidentally adding an index on `updated_at` or `text_content`?',
    assistant:
      'You can add a static CI test that inspects the Drizzle schema or queries `pg_indexes`:\n```ts\nconst FORBIDDEN_COLUMNS = [\'updated_at\', \'text_content\'];\nfor (const idx of tableIndexes) {\n  if (idx.columns.some(col => FORBIDDEN_COLUMNS.includes(col))) {\n    throw new Error(`Index ${idx.name} must not cover frequently mutated columns!`);\n  }\n}\n```\nThis completely prevents regressions in pull requests.',
  },
  {
    user: 'Let us check WAL (Write-Ahead Logging) generation. During a 150-concurrency load test, our WAL production was nearly 400 MB per minute. Why was WAL volume so large for small text appends?',
    assistant:
      'When an update is non-HOT and crosses page boundaries, Postgres logs the full tuple update plus the index updates. Furthermore, if `full_page_writes = on` (which is critical for crash recovery), the first modification to an 8KB page after a checkpoint writes the ENTIRE 8KB page image to WAL! When 150 streams dirtied hundreds of heap and index pages across multiple tables, full-page writes dominated your WAL volume. With HOT updates, the same page is modified repeatedly without touching index pages, reducing WAL volume by 70-80%.',
  },
  {
    user: 'How does `checkpoint_completion_target` affect this? Currently our `checkpoint_timeout` is 15 minutes, and `checkpoint_completion_target` is 0.9. Is that optimal?',
    assistant:
      'Yes, `checkpoint_timeout = 15min` and `checkpoint_completion_target = 0.9` is the modern standard best practice. Setting `completion_target = 0.9` spreads checkpoint writes smoothly over 13.5 minutes (90% of the interval) using the kernel buffer cache, eliminating sharp I/O spikes. If your WAL generation increases, raise `max_wal_size` to 16GB or 32GB so checkpoints occur based on time rather than WAL volume.',
  },
  {
    user: 'Let us check lock contention. When the checkpointer runs `UPDATE message_parts ... WHERE id = $id`, what lock mode does PostgreSQL acquire?',
    assistant:
      'PostgreSQL acquires an `ExclusiveLock` on the target row tuple and a `RowExclusiveLock` on the `message_parts` table. A `RowExclusiveLock` only conflicts with exclusive table-level locks (`SHARE`, `SHARE ROW EXCLUSIVE`, `ACCESS EXCLUSIVE`). It does NOT conflict with concurrent `SELECT`, `INSERT`, or updates on other rows. Since each stream checkpointer only updates its own active part ID, row-level lock contention is practically zero.',
  },
  {
    user: 'What if a user requests `GET /api/conversations/:id/messages` while the checkpointer is updating a part? Does the read block on the update?',
    assistant:
      'In PostgreSQL under `READ COMMITTED` isolation, readers never block writers, and writers never block readers! When `GET /messages` queries the part, Postgres reads the latest committed MVCC snapshot of the tuple. If an UPDATE transaction is currently in flight, the SELECT simply reads the previous committed version. It never waits on the row lock.',
  },
  {
    user: 'That explains why reads are so fast even during active generation. What about transaction duration? Does our checkpointer hold the transaction open across network chunks?',
    assistant:
      'No, and that is a critical architectural requirement. The checkpointer runs in its own discrete transaction that opens, executes the single `UPDATE`, and immediately commits. Network streaming happens entirely in userland over HTTP. A stream must NEVER hold a database connection or transaction open while awaiting network I/O from an AI provider.',
  },
  {
    user: 'Let us look at the connection pool. We are using `pg.Pool` in Bun with `DB_POOL_MAX = 20`. Under 150 concurrent streams, will 20 connections be sufficient for checkpointing?',
    assistant:
      'Yes, easily! Because each checkpoint UPDATE takes approximately 0.1ms to 0.5ms of execution time, a single pool connection can handle over 2,000 checkpoint transactions per second. With 150 streams each checkpointing once per second, the total database load is only 150 transactions per second. 20 connections provide more than 10x headroom.',
  },
  {
    user: 'Can we optimize the checkpointer update query further? Currently we do:\n```sql\nUPDATE message_parts\n   SET text_content = text_content || $chunk,\n       updated_at = now()\n WHERE id = $id;\n```\nIs string concatenation `text_content || $chunk` efficient in PostgreSQL?',
    assistant:
      'Yes, string concatenation in PostgreSQL C-internals allocates a single contiguous memory buffer for the new `text` datum. However, to minimize network bandwidth between Bun and Postgres, ensure that `$chunk` contains only the delta bytes (e.g. 50-200 bytes) rather than transmitting the full accumulated string on every checkpoint.',
  },
  {
    user: 'We also update `heartbeat_at` on `generation_jobs`. Should that update be combined into the same transaction, or kept separate?',
    assistant:
      'You can combine them into a single round-trip using a CTE or multiple statements in the same transaction:\n```sql\nWITH u1 AS (\n  UPDATE message_parts SET text_content = text_content || $chunk, updated_at = now() WHERE id = $part_id\n)\nUPDATE generation_jobs SET heartbeat_at = now() WHERE id = $job_id;\n```\nThis cuts your round-trip latency in half and guarantees that the heartbeat advances atomically with the persisted text.',
  },
  {
    user: 'What if the server crashes mid-stream? How does the generation reaper identify abandoned generations, and what happens to the partially checkpointed message part?',
    assistant:
      'The reaper runs every 30 seconds and queries:\n```sql\nSELECT id FROM generation_jobs\n WHERE status = \'generating\'\n   AND heartbeat_at < now() - interval \'60 seconds\';\n```\nWhen found, the reaper marks `generation_jobs.status = \'failed\'` with `error_category = \'detached\'` and settles the quota reservation. The message part already contains all chunks checkpointed up to the last second, so the user retains everything generated before the crash!',
  },
  {
    user: 'Let us talk about memory usage in Bun. How should we buffer streaming tokens in memory before flushing to the database checkpointer?',
    assistant:
      'Use a ring-buffer or coalescer that accumulates chunks in a simple string buffer or array of Uint8Arrays. Set dual flush thresholds: flush whenever the accumulated buffer reaches 2 KB, or whenever 1,000 ms has elapsed since the last flush. This bounds memory consumption to under 2 KB per active connection while providing real-time persistence.',
  },
  {
    user: 'How does client backpressure interact with this? If a slow mobile client is reading the SSE stream at only 10 KB/s, does our server buffer grow indefinitely?',
    assistant:
      'You must enforce backpressure at the HTTP transport layer. When `response.write()` returns false or the internal queue exceeds a safety cap (e.g. 64 KB), pause reading from the upstream AI provider. Upstream provider SDKs respect TCP backpressure, which suspends incoming tokens until the downstream client catches up.',
  },
  {
    user: 'Let us discuss database vacuuming and `pg_stat_activity`. How can we monitor if autovacuum is actively running on `message_parts`?',
    assistant:
      'You can query `pg_stat_progress_vacuum`:\n```sql\nSELECT\n  p.pid,\n  c.relname,\n  p.phase,\n  p.heap_blks_total,\n  p.heap_blks_scanned,\n  p.heap_blks_vacuumed\nFROM pg_stat_progress_vacuum p\nJOIN pg_class c ON c.oid = p.relid\nWHERE c.relname = \'message_parts\';\n```\nThis shows the exact phase (scanning heap, vacuuming indexes, truncating heap) and percentage completed in real time.',
  },
  {
    user: 'What if autovacuum causes disk I/O latency spikes that affect our p99 query times? How do we configure storage priorities?',
    assistant:
      'Set `autovacuum_vacuum_cost_delay = 2ms` and ensure PostgreSQL data files are on an NVMe SSD with high IOPS. On modern cloud block storage (such as AWS EBS gp3 or Hetzner NVMe), configure at least 3,000 IOPS and 250 MB/s throughput. This ensures autovacuum operates quietly in the background without stealing I/O slots from foreground queries.',
  },
  {
    user: 'Let us check table statistics. When we update rows frequently, do column statistics for `text_content` become stale? Does `ANALYZE` need to run as frequently as `VACUUM`?',
    assistant:
      'No. Column statistics (`pg_statistic`) are used by the query planner to estimate selectivity for WHERE clauses (such as equality or range searches). Because your queries look up parts by `id` or `(message_id, position)` — both of which have static distributions — query plans do not change based on text length. Set `autovacuum_analyze_scale_factor = 0.05` to avoid unnecessary analyze runs.',
  },
  {
    user: 'Can we use `shared_buffers` effectively for this? Our server has 32 GB of RAM. What should `shared_buffers`, `effective_cache_size`, and `work_mem` be set to?',
    assistant:
      'For a 32 GB dedicated database server, recommended production settings are:\n- `shared_buffers = 8GB` (25% of total RAM)\n- `effective_cache_size = 24GB` (75% of total RAM)\n- `work_mem = 32MB`\n- `maintenance_work_mem = 1GB`\n- `wal_buffers = 64MB`\n- `random_page_cost = 1.1` (optimized for NVMe SSD)',
  },
  {
    user: 'Why `random_page_cost = 1.1` instead of the default `4.0`? How does that change the planner’s behavior?',
    assistant:
      'The default `4.0` was established in the 1990s when random disk reads required physical drive heads to seek spinning magnetic platters. On modern NVMe SSDs, random reads have virtually identical latency to sequential reads. Lowering `random_page_cost` to 1.1 instructs the planner that index scans are cheap, encouraging optimal index lookups over full table scans.',
  },
  {
    user: 'Let us test our findings. If we run a 15-minute load test with 150 concurrent streams after applying `fillfactor = 80`, what metrics should we look for to verify success?',
    assistant:
      'Monitor four core metrics:\n1. `n_tup_hot_upd / n_tup_upd` in `pg_stat_user_tables`: Should exceed 90%.\n2. Total disk size of `message_parts` and its indexes via `pg_relation_size()`: Should remain stable rather than climbing linearly.\n3. WAL generation rate via `pg_current_wal_lsn()`: Should drop from 400 MB/min to under 80 MB/min.\n4. Checkpoint latency in `pg_stat_statements`: Mean execution time for the update query should remain below 0.3 ms.',
  },
  {
    user: 'We ran the test and our HOT update ratio jumped from 12% to 94.8%! WAL generation decreased by 78%, and our p99 streaming checkpoint latency is down to 0.18ms. Here is the verified verification summary.',
    assistant:
      'Outstanding results! A 94.8% HOT update ratio confirms that virtually all of your 1-second streaming appends are now occurring completely within free space on the existing 8KB heap pages. Your index write amplification is effectively eliminated, index bloat is halted, and your background autovacuum can effortlessly prune dead tuples in-place. Your persistence tier is fully hardened for 150+ concurrent active generations.',
  },
  {
    user: 'Thank you! Can you write down a final production checklist that our SRE team can add to our runbook for ongoing database health monitoring?',
    assistant:
      'Here is your SRE Production Runbook Checklist for Streaming Chat Persistence:\n\n1. **Storage Parameters**:\n   - Verify `fillfactor = 80` on `message_parts` and `quota_accounts`.\n   - Ensure LZ4 compression is enabled on `message_parts.text_content`.\n\n2. **Autovacuum Health**:\n   - Check `n_dead_tup` stays under 50,000 on `message_parts`.\n   - Verify `hot_ratio_pct > 90%` weekly.\n\n3. **Index Hygiene**:\n   - Confirm no new indexes reference `updated_at` or `text_content`.\n   - Review index bloat monthly with `pgstattuple`.\n\n4. **Reaper Alerts**:\n   - Alert if active generating jobs with stale heartbeat > 2 minutes exceeds 5.\n\n5. **WAL and I/O**:\n   - Maintain WAL disk headroom at > 3x `max_wal_size`.\n   - Ensure checkpoint completion target stays at 0.9.',
  },
  {
    user: 'Everything is clear, verified, and added to our operational documentation. We are ready to roll this out to staging and production.',
    assistant:
      'You are in excellent shape. The architecture is robust, predictable, and resilient under high concurrency. Reach out anytime if you need further performance tuning or query plan reviews!',
  },
];

export function buildSeedMessages(): SeedMessage[] {
  const result: SeedMessage[] = [];
  const baseDate = new Date('2026-10-15T09:00:00Z');

  HOT_CONVERSATION_TURNS.forEach((turn, idx) => {
    const userSeq = idx * 2 + 1;
    const assistantSeq = idx * 2 + 2;

    const userTime = new Date(baseDate.getTime() + idx * 90_000);
    const assistantTime = new Date(userTime.getTime() + 45_000);

    const userMessageId = `00000000-0000-7000-8004-${padId(userSeq)}`;
    const assistantMessageId = `00000000-0000-7000-8004-${padId(assistantSeq)}`;

    // Turn 1 attaches the explain analyze trace
    result.push({
      id: userMessageId,
      conversationId: '00000000-0000-7000-8003-000000000001',
      seq: userSeq,
      role: 'user',
      status: 'complete',
      textContent: turn.user,
      fileId: idx === 0 ? '00000000-0000-7000-8006-000000000001' : undefined,
      createdAt: userTime,
      completedAt: userTime,
    });

    result.push({
      id: assistantMessageId,
      conversationId: '00000000-0000-7000-8003-000000000001',
      seq: assistantSeq,
      role: 'assistant',
      status: 'complete',
      finishReason: 'stop',
      textContent: turn.assistant,
      createdAt: userTime,
      completedAt: assistantTime,
      estInputTokens: 850 + idx * 45,
      estOutputTokens: 320 + (idx % 5) * 80,
      durationMs: 1450 + (idx % 7) * 220,
    });
  });

  // Generate 2 messages for every other conversation
  const allConversations = buildSeedConversations();
  allConversations.slice(1).forEach((conv, idx) => {
    const offset = idx + 200;
    const userSeq = 1;
    const assistantSeq = 2;
    const userMessageId = `00000000-0000-7000-8004-${padId(offset * 2 + 1)}`;
    const assistantMessageId = `00000000-0000-7000-8004-${padId(offset * 2 + 2)}`;

    const userTime = new Date(conv.createdAt.getTime());
    const assistantTime = new Date(userTime.getTime() + 35_000);

    result.push({
      id: userMessageId,
      conversationId: conv.id,
      seq: userSeq,
      role: 'user',
      status: 'complete',
      textContent: `Can you provide a comprehensive technical overview and implementation best practices for "${conv.title}"?`,
      createdAt: userTime,
      completedAt: userTime,
    });

    result.push({
      id: assistantMessageId,
      conversationId: conv.id,
      seq: assistantSeq,
      role: 'assistant',
      status: 'complete',
      finishReason: 'stop',
      textContent: `Here is a structured engineering guide for **${conv.title}**:\n\n### 1. Architectural Principles\nWhen implementing this pattern in production, reliability and bounded resource consumption are the core tenets. Ensure that state transitions are verified at domain boundaries before persisting.\n\n### 2. Implementation Strategy\n- Validate inputs with strict schemas.\n- Maintain idempotent retry semantics.\n- Isolate long-lived state from short database transactions.\n\n### 3. Monitoring & Verification\nAlways observe p95 latency and track error classifications across service boundaries.`,
      createdAt: userTime,
      completedAt: assistantTime,
      estInputTokens: 420,
      estOutputTokens: 380,
      durationMs: 1250,
    });
  });

  return result;
}
