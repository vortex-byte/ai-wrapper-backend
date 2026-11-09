# Anthropic Adapter Remediation & Modular Architecture Plan

> **Author:** Code Review & Architecture Team  
> **Status:** Proposed (Awaiting Approval)  
> **Target:** `src/providers/infrastructure/adapters/anthropic/`  
> **Compliance:** Official Claude API Specification (`anthropic-version: 2026-10-21`), `AGENTS.md` (Modular Monolith & Hexagonal Boundaries)

---

## 1. Executive Summary

During the recent refactor aligning the Anthropic adapter with the Claude platform specification, critical bugs and protocol edge cases were identified during code review. Additionally, the existing monolithic implementation (`src/providers/infrastructure/adapters/anthropic/adapter.ts`, ~1,500 lines) violates single-responsibility design and maintainability principles when compared to the modular architecture established in `src/providers/infrastructure/adapters/openai/`.

This document outlines:
1. **The Technical Remediation Plan:** Exact fixes for the 7 identified issues (`BUG-01`, `API-01`, `API-02`, `BUG-02`, `API-03`, `RACE-01`, and `MAINT-01`).
2. **The Modular Decomposition Plan:** A structured refactoring roadmap breaking the monolithic `adapter.ts` into single-responsibility, cohesive submodules following the `openai/` adapter precedent.
3. **Execution & Verification Plan:** Step-by-step phased execution ensuring zero regressions, complete unit test coverage, and strict compliance with `bun run verify`.

---

## 2. Issues & Targeted Remediation Plan

### Issue Register

| ID | Severity | Category | Description |
|---|---|---|---|
| **BUG-01** | **CRITICAL** | Quota / Token Accounting | Compaction iteration tokens are double-counted in streaming deltas and fail to reset across `pause_turn` turns. |
| **API-01** | **HIGH** | Protocol Incompatibility | `temperature` & `top_p` are serialized under API version `2026-10-21` for non-modern models (HTTP 400). |
| **API-02** | **HIGH** | Feature Incomplete | Thinking is inactive on Claude Opus 4.7/4.8 because `thinking: { type: 'adaptive' }` is omitted. |
| **BUG-02** | **HIGH** | Model Identification | `isModernEffortModel` regex fails on dot-notated model IDs (e.g. `claude-opus-4.7`). |
| **API-03** | **MEDIUM** | Beta Headers | Beta header `compact-2026-01-12` is omitted when replaying historical threshold compaction blocks. |
| **RACE-01** | **MEDIUM** | Compaction Signatures | `compaction` event is emitted prematurely in `content_block_delta` before `signature_delta` arrives. |
| **MAINT-01**| **LOW** | Header Consistency | Inconsistent default `anthropic-version` between SDK client (`2023-06-01`) and Files API (`2026-10-21`). |

---

### Detailed Remediation Specifications

#### Fix BUG-01: Correct Compaction & Iteration Token Accounting
* **Root Cause:** In `adapter.ts`, `accumulateInputUsage` (called on `message_start`) loops over `ev.message.usage.iterations` and adds input tokens to `runState.inputTokens` and output tokens to `runState.iterationOutputTokens`. Later, `message_delta` iterates over `ev.usage.iterations` again with identical logic, double-counting both values. Furthermore, `runState.iterationOutputTokens` is not cleared in `resetTurn()`, so output tokens leak into subsequent continuation turns after `pause_turn`.
* **Fix Action:**
  1. Process iterations once: accumulate iteration input tokens only during `message_start` (where the complete request-level prompt usage is reported). In `message_delta`, update `runState.outputTokens` using `runState.priorTurnsOutputTokens + ev.usage.output_tokens + runState.iterationOutputTokens`.
  2. In `resetTurn(runState)`: explicitly reset `runState.iterationOutputTokens = 0`.

#### Fix API-01: Guard Sampling Parameters Under API `2026-10-21`
* **Root Cause:** Version `2026-10-21` of the Anthropic Messages API strictly rejects `temperature`, `top_p`, and `top_k` with a 400 `invalid_request_error`. Currently, non-modern models (e.g. `claude-3-5-sonnet-20241022`) without extended thinking still emit `temperature` and `top_p`.
* **Fix Action:**
  1. Resolve the effective API version via `resolveAnthropicVersion(provider)`.
  2. If the active version is `2026-10-21` (the platform default), suppress `temperature` and `top_p` across all requests.
  3. Only allow `temperature` and `top_p` if a legacy version (e.g. `2023-06-01`) is explicitly configured in `provider.config['anthropicVersion']` and extended thinking is inactive.

#### Fix API-02: Enable Adaptive Thinking for Modern Effort Models (Opus 4.7 / 4.8)
* **Root Cause:** Modern Claude models (Claude Opus 4.7, 4.8, 5.x) require `thinking: { type: 'adaptive' }` to activate reasoning when `output_config.effort` is provided. The current implementation only populates `output_config: { effort }` while leaving `thinking: undefined`, which leaves thinking inactive on Opus 4.7/4.8.
* **Fix Action:**
  1. In the request builder, if `isModernEffortModel` is `true`:
     - If `req.reasoningEffort !== undefined`: set `thinking = { type: 'adaptive' }` and `output_config = { effort: req.reasoningEffort }`.
     - Do not pass legacy `budget_tokens`.
  2. If `isModernEffortModel` is `false`:
     - Retain `buildThinking(req)` which supplies `{ type: 'enabled', budget_tokens }`.

#### Fix BUG-02: Normalize Model ID Version Parsing
* **Root Cause:** `isModernEffortModel` checks for hyphenated versions (`claude-4-7`, `claude-4-8`), failing for dot-notated versions (`claude-opus-4.7`, `claude-sonnet-4.8`).
* **Fix Action:**
  1. In `isModernEffortModel(apiModelId: string)`: normalize dots to hyphens (`apiModelId.toLowerCase().replace(/(\d+)\.(\d+)/g, '$1-$2')`) before testing model family regexes and patterns.

#### Fix API-03: Include All Active Compaction Beta Headers on Replay
* **Root Cause:** `compactionEdit(req)` returns `undefined` when replaying a historical compaction block to prevent re-submitting trigger edits. Consequently, `requestHeaders(req)` fails to attach `compact-2026-01-12`, attaching only `compact-2026-09-04`. If the historical block was generated via threshold compaction, the upstream API may fail to recognize the block schema.
* **Fix Action:**
  1. If `hasCompactionMessage` is `true` or `req.model.capabilities.compaction !== undefined`, inject both `compact-2026-09-04` (on-demand) and `compact-2026-01-12` (threshold) into `anthropic-beta`.

#### Fix RACE-01: Defer Streaming Compaction Event Emission Until Block Completion
* **Root Cause:** In threshold compaction streaming, `compaction_delta` contains the summary text, while a subsequent `signature_delta` contains the cryptographic signature. Emitting the `compaction` event in `handleBlockDelta` creates a race condition where the event is emitted with `signature: undefined`, and `handleBlockStop` skips re-emitting it because the index was recorded in `compactionEmittedIndices`.
* **Fix Action:**
  1. In `handleBlockDelta`: accumulate `content` from `compaction_delta` into the turn block buffer, but do not yield the `compaction` event.
  2. In `handleBlockStop`: yield the `compaction` event containing the combined `content` and `signature` once the block is closed and finalized.
  3. In `handleBlockStart`: continue emitting immediately for whole blocks (on-demand compaction) where `content` is already present.

#### Fix MAINT-01: Centralize Consistent `anthropic-version` Header Resolution
* **Root Cause:** `filesHeaders` defaults to `2026-10-21`, while `buildClient` does not supply default headers, allowing the client SDK to default to `2023-06-01`.
* **Fix Action:**
  1. Create `resolveAnthropicVersion(provider: ProviderRuntimeConfig): string` returning `provider.config['anthropicVersion'] ?? '2026-10-21'`.
  2. Pass `defaultHeaders: { 'anthropic-version': resolveAnthropicVersion(provider) }` when constructing the Anthropic SDK client in `client.ts`.

---

## 3. Modular Architecture Plan for Anthropic Adapter

### Current State
`src/providers/infrastructure/adapters/anthropic/adapter.ts` currently houses:
- ProviderAdapter interface implementation
- Request formatting & prompt synthesis
- Compaction edit & replay calculation
- Thinking budget & effort mapping
- Stream handling, delta decoding, tool result extraction
- Container & Files API HTTP requests
- Media encoding & error translation

### Target Modular Architecture
The Anthropic adapter will be refactored into a cohesive module directory mirroring `src/providers/infrastructure/adapters/openai/`:

```
src/providers/infrastructure/adapters/anthropic/
├── adapter.ts          # Public AnthropicAdapter class (thin coordinator implementing ProviderAdapter)
├── client.ts           # SDK client factory, version resolution, default headers, apiBase
├── config.ts           # Model family detection, beta headers, thinking budgets, constants
├── errors.ts           # Anthropic error translation, secret scrubbing, status code mapping
├── estimate.ts         # Character-based input token estimation fallback
├── media.ts            # Base64 media block formatting (image and PDF document blocks)
├── types.ts            # Stream event shapes, RunState, OutgoingBlock, ReplayBlock types
├── request.ts          # toProviderRequest, buildMessages, buildSystem, buildContainer, compactionEdit
├── stream.ts           # Multi-turn pause_turn loop, block event dispatch (start, delta, stop)
├── usage.ts            # accumulateInputUsage, iteration token tracking, usage calculations
└── files.ts            # Files API: fetchArtifactStream (with metadata retrieval), uploadInputFile
```

### Module Responsibilities & Exports

| Module | Responsibilities | Key Functions / Types |
|---|---|---|
| `types.ts` | Pure TypeScript interfaces for stream parsing, run state, and block replay. No dependencies. | `RunState`, `RawAnthropicStreamEvent`, `ReplayBlock`, `OutgoingBlock`, `CompactionBlock` |
| `config.ts` | Version constants, model detection, beta header definitions, budget constants. | `isModernEffortModel`, `DEFAULT_ANTHROPIC_VERSION`, `ON_DEMAND_COMPACTION_BETA`, `THRESHOLD_COMPACTION_BETA` |
| `client.ts` | Anthropic SDK client instantiation and HTTP header builders. | `buildClient`, `resolveAnthropicVersion`, `requestHeaders`, `filesHeaders`, `apiBase` |
| `errors.ts` | Maps Anthropic API errors and HTTP status codes to internal `ProviderError`. | `translateError` |
| `estimate.ts` | Rough heuristic token estimation for quota checks before dispatch. | `estimateInputTokens` |
| `media.ts` | Transforms binary attachments into Anthropic image and PDF content blocks. | `resolveMediaBlocks` |
| `request.ts` | Assembles the complete Messages API request payload. | `toProviderRequest`, `buildMessages`, `buildSystem`, `buildContainer`, `buildThinking`, `compactionEdit` |
| `usage.ts` | Calculates token accounting, prompt cache hits, and iteration metrics. | `accumulateInputUsage`, `resetTurnUsage` |
| `stream.ts` | Coordinates streaming consumption, event translation to `GenerationEvent`, and `pause_turn` loops. | `executeStream`, `handleBlockStart`, `handleBlockDelta`, `handleBlockStop` |
| `files.ts` | Manages Files API integration (metadata lookup, streaming download, multipart upload). | `fetchArtifactStream`, `uploadInputFile`, `parseFilenameFromContentDisposition` |
| `adapter.ts` | Composition root implementing `ProviderAdapter`. Delegates to submodules. | `AnthropicAdapter` |

### Dependency Graph & Boundaries
Imports point strictly inward:
```
adapter.ts
  ├──> client.ts ──> config.ts
  ├──> request.ts ──> media.ts, config.ts, types.ts
  ├──> stream.ts ──> usage.ts, config.ts, errors.ts, types.ts
  ├──> files.ts ──> client.ts, errors.ts
  └──> estimate.ts
```
- No submodule imports outside `src/providers/` except standard library and platform utilities (`scrubSecrets`, ports).
- Strictly passes `depcruise src` with zero dependency violations.

---

## 4. Implementation Steps

```
[Phase 1: Remediation Fixes]
       │
       ▼
1.1 Correct token accumulation & reset in stream usage accounting (BUG-01)
1.2 Enforce 2026-10-21 sampling parameter suppression (API-01)
1.3 Configure adaptive thinking with output_config.effort for modern models (API-02)
1.4 Normalize model version detection for dot notation (BUG-02)
1.5 Retain both compaction betas on replayed transcripts (API-03)
1.6 Defer streaming compaction event emission to block stop (RACE-01)
1.7 Centralize anthropic-version resolution (MAINT-01)
       │
       ▼
[Phase 2: Modular Decomposition]
       │
       ▼
2.1 Extract types.ts and config.ts
2.2 Extract client.ts and errors.ts
2.3 Extract estimate.ts and media.ts
2.4 Extract usage.ts and files.ts
2.5 Extract request.ts and stream.ts
2.6 Rewire adapter.ts as composition coordinator
       │
       ▼
[Phase 3: Testing & Verification]
       │
       ▼
3.1 Update unit tests in tests/unit/providers/anthropic-adapter.test.ts
3.2 Update container tests in tests/unit/providers/anthropic-container.test.ts
3.3 Run bun run typecheck, bun run lint, bun run depcruise
3.4 Run vitest suite across all unit and integration tests
```

---

## 5. Test Plan & Acceptance Criteria

### Unit Tests to Add / Update
1. **Compaction Iteration Usage Test (`anthropic-adapter.test.ts`):**
   - Verify that iteration tokens appearing in both `message_start` and `message_delta` are accumulated only once.
   - Verify that a multi-turn `pause_turn` continuation clears iteration output tokens in `resetTurn` and does not inflate usage on turn 1.
2. **Sampling Parameter Rejection Test (`anthropic-adapter.test.ts`):**
   - Verify that requesting `temperature: 0.7` and `topP: 0.9` under `anthropic-version: 2026-10-21` omits both fields from `toProviderRequest` for both modern and non-modern models.
   - Verify that configuring `anthropicVersion: '2023-06-01'` permits sampling parameters for non-modern models without thinking.
3. **Adaptive Thinking Configuration Test (`anthropic-adapter.test.ts`):**
   - Verify that `claude-opus-4-7` and `claude-opus-4.7` with `reasoningEffort: 'high'` produce:
     ```json
     {
       "thinking": { "type": "adaptive" },
       "output_config": { "effort": "high" }
     }
     ```
4. **Dot-Notation Model Version Test (`anthropic-adapter.test.ts`):**
   - Test `isModernEffortModel` against:
     - `claude-opus-4.7`, `claude-sonnet-4.8`, `claude-haiku-5.5` (must return `true`)
     - `claude-sonnet-4-6`, `claude-3-5-sonnet-20241022` (must return `false`)
5. **Compaction Signature Streaming Test (`anthropic-adapter.test.ts`):**
   - Script a stream where `content_block_start` (compaction), `content_block_delta` (compaction_delta), `content_block_delta` (signature_delta), and `content_block_stop` arrive in sequence.
   - Assert that exactly one `compaction` event is emitted, and its payload includes the cryptographic `signature`.
6. **Files API Version Header Test (`anthropic-container.test.ts`):**
   - Verify that both the SDK client and the direct Files API fetch calls transmit `anthropic-version: 2026-10-21`.

### Quality Gates
- `bun run typecheck` passes with 0 errors.
- `bun run lint` passes with 0 warnings or errors.
- `bun run depcruise` passes with 0 violations.
- `bun --bun run vitest run tests/unit` passes 100%.
- Working tree remains dirty; no git commits or branch operations without explicit user confirmation.
