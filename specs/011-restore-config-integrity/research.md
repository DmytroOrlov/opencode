# Research and decisions

## Commit and publication

**Decision:** Use Config's existing JSONC editing and Effect filesystem/service boundaries, a unique same-directory temporary file and atomic rename, with a separate typed postcommit publication outcome and protected-reader degradation/reconciliation. **Rationale:** Current `config.ts` uses `writeWithDirs` directly and refreshes afterwards; replacement and publication are different irreversible states. Preserve mode and cleanup; no power-loss fsync guarantee. **Alternatives:** direct overwrite risks corruption; rollback after rename lies about the commit; a generic transaction framework duplicates the existing owner.

## Ordering and retry

**Decision:** Reserve owner entry order before validation, stage valid intent using that order, serialize sparse commits against latest committed state, and resolve effective fallback just before dispatch. **Rationale:** Current lock spans staging through cleanup (`config.ts`), preventing newer intent while B waits; `llm.ts` records fallback at request start, which can become stale after an intent clears. Admission and revision owners already exist. **Alternatives:** snapshot-based writes lose sparse changes; a second store splits authority; changing a dispatched attempt damages attribution and tool safety.

## Authorized PATCH evolution and historical evidence

**Decision:** Declare a PATCH-specific 500 capable of decoding both committed identities and ordinary generic errors; map typed outcomes according to actual state. Regenerate both clients and document actual error types. **Rationale:** The old plan correctly established that the handler uses `Effect.orDie`, generic defect middleware encodes `UnknownError`, PATCH declared no 500, and the Promise generated client's undeclared-status path cancels the body and throws `ClientError`/`UnexpectedStatus`; Effect delegates to the generated API and maps HTTP/schema errors. An additive raw wire field alone is insufficient. The user and reconciled FR-005 now explicitly authorize protocol/client type evolution, so that finding is design evidence, not a HOLD. **Alternatives:** relying on message parsing or an undeclared status loses the discriminator; changing global defect handling broadens scope; claiming exact prior error-shape compatibility is unsupported. Validate actual generated behavior, including generic 500, before accepting S3.

## Evidence approach

**Decision:** Deterministic injection and barriers at real production owners, positive and decisive negative checks, scoped test commands. **Rationale:** V1 assertions establish boundary safety, not merely test counts; 009 and 010 require admission, retry attribution, compensation and no uncertain side-effect replay. **Alternatives:** sleeps, fakes bypassing production paths, full sweeps or benchmarks do not establish these specific contracts. No clarification remains open.

## Publication and completion ownership evidence

The current `packages/core/src/config.ts` update synchronously calls `reload()` while holding the exclusive admission lease; the source explicitly says a debounced reload request alone is insufficient for freshly admitted readers. `reload()` discovers and loads, reconciles watches, assigns `sources` and `configs`, then publishes `Event.Updated`; the update then calls `requestReload`, releases the lease via `Effect.ensuring`, and clears its staged intent via `Effect.onExit`. This is current ordering evidence, not proof that every notification or cleanup is optional or mandatory. Reader refresh sufficient for coherent protected reads is required publication; lease release and safe revision cleanup are required lifecycle obligations.

Implementation must inspect the actual subscriber and watch/reload boundary to determine whether `Event.Updated` delivery and `requestReload` are required for coherent publication, a real mandatory completion obligation after publication, or optional housekeeping. Classify each temporary-file and watch cleanup by whether it is required for correctness/resource release or merely housekeeping, and verify actual failure and interruption behavior. Do not infer publication failure solely from an exception after reader assignment, assume event delivery is complete from enqueue alone, or invent a postpublication mandatory failure. If a role or enforceable boundary cannot be established, record the exact boundary as HOLD. Optional diagnostics must not strand required resources or leases.
