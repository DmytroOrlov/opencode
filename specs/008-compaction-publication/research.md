# Source-backed research — Feature 008

## Source snapshot

Verified ZIP `opencode-008-plan-review-20261009-003647.zip`, `dev` HEAD `818bb2953e`, staged compaction/fallback changes. Only supplied files were inspected. No model inference, tests, edits of the real repository, or event-replay execution were performed.

## Confirmed implementation facts

1. `CompactionPart` has `auto`, `overflow?` and `tail_start_id?`; it has no publication state (`packages/schema/src/v1/session.ts:195-201`). `User` has no durable synthetic-origin field (`:332-354`).
2. `Session.updateMessage` and `Session.updatePart` each publish **separate** events (`packages/opencode/src/session/session.ts:630-644`). Each durable event is itself atomic: `packages/core/src/event.ts` runs its projector(s), event-sequence update, and event-log insertion inside one `db.transaction(..., { behavior: "immediate" })`. Identical replay no-ops; divergent replay is rejected. Their projectors perform row-by-row upserts (`packages/core/src/session/projector.ts:260-272,310-327`). There is **no atomic two-event compaction publication**, but the final single `PartUpdated` can be a valid linearization point. A stale *new* writer event at a later sequence can still overwrite an older state without a projector guard.
3. The projector currently overwrites part data unconditionally on a conflicting part ID (`projector.ts:316-322`). A monotonically absorbing `published` state therefore needs an explicit guard or source-validated single-writer guarantee; replaying a stale `preparing` after published cannot be assumed harmless.
4. `SessionCompaction.create` persists a synthetic user first and its compaction part second (`packages/opencode/src/session/compaction.ts:692-715`). An interruption between these events leaves an identifiable gap only if the first message itself carries origin metadata.
5. `SessionCompaction.process` creates and streams summary S through `SessionProcessor`; it currently updates `tail_start_id` (when present) after successful process-result classification, then runs auto-continue/replay and only later emits `Event.Compacted` (`compaction.ts:590-689`). S can be completed durably before a tail update; a no-tail compaction has no tail update at all.
6. `select` intentionally leaves `tail_start_id` undefined when no tail can be preserved (`compaction.ts:232,235,267`). Old no-tail successful compactions are a real legacy contract.
7. `completedCompactions` currently classifies S by `summary && finish && !error` and parent U only, with no publication check (`compaction.ts:99-115`).
8. `filterCompacted` pushes a message before evaluating a completed pair; missing tail currently `break`s, and its later reorder selects any compaction with a tail, potentially without verifying successful summary status (`message-v2.ts:534-585`). A naïve `break → continue` is insufficient.
9. `MessageV2.latest` chooses user/assistant/finished by creation time and picks task parts newer than latest completed assistant (`message-v2.ts:595-617`); `SessionPrompt.runLoop` currently derives both model context and scheduling from the same filtered list (`prompt.ts:1153-1253`).
10. `SessionPrompt.lastAssistant` uses `sessions.findMessage` for newest raw assistant (`prompt.ts:1132-1137`). If a complete-unpublished summary is newest, a projection-only change will not prevent it from being returned as the current answer.
11. The processor persists text completion and assistant finish in independent events (`processor.ts:550-566,479-492`) and may finalize after failure; a summary content read must use persisted parts, not only a `finish` flag.
12. `prompt.ts:1183-1188` tests completed turns **before** `tasks.pop()` at `:1228`; removing queued synthetic U from `lastUser` without a separate pending-work guard can silently bypass compaction. At `:1238`, the compaction task is invoked with `parentID: lastUser.id` rather than the task's own `messageID`, so a newer genuine Y can redirect it. An origin-tagged U without its part can reach normal generation unless specifically excluded.
13. `Session.fork` (`session.ts:707-727`) creates new message IDs incrementally while copying and currently remaps only `tail_start_id`. A new `publication.summaryID` points **forward** to a later S, so remapping it requires preallocating IDs for the entire selected fork subset before copying U's part. A cutoff before S cannot preserve a published binding.
14. `MessageUpdated(S)` projects as an unconditional upsert and can demote published S's success even if the compaction part stays published. `MessageRemoved`/`PartRemoved` are separate durable deletion events, used intentionally by `revert.cleanup`; explicit user history removal must be distinguished from stale finalizer mutation.
15. Legacy task discovery is anchored to the latest finished assistant: S with no `finish` can leave U schedulable, while S with `finish:"error"` suppresses it. New-format `preparing` must not inherit that incidental retry behavior.

## Decisions and rejected shortcuts

**Decision:** a durable optional new-format compaction state, tagged on initial part, with final `published+summaryID` in ONE PartUpdated. Strict legacy identity requires both U.origin and P.publication absent; only a valid pair in this shape, with or without tail, receives legacy recognition and scheduling. Explicit synthetic origin or publication metadata declares new-format identity; an explicit synthetic origin with absent publication is malformed new-format state and can never fall through to legacy merely because S looks successful.

**Additional decision:** a durable extensible synthetic origin on U. Ordinary compaction uses `"compaction"`; `"recovery-preparation"` is reserved for future recovery preparation, and unknown future origins remain synthetic. U's durable message ID is the operation/publication owner. The first create event predates the part and can survive alone, so any synthetic U without a part must not be read as a real prompt. Ordinary scheduling accepts only ordinary queued compaction.

**Status distinction:** new ordinary `origin:"compaction"` plus `queued` (safe to schedule), `preparing` (in progress / crash abandoned for automatic scheduling), `published` (authoritative only with matching valid S), `abandoned` (terminal). Legacy pairs (origin and publication both absent) preserve historical finished-relative scheduling: unfinished S without `finish` may leave U pending, while `finish:"error"` suppresses U. An eligible legacy pending U may be upgraded to `preparing` before summary generation; its old scheduling behavior remains in effect until that transition. A completed but unpublished new summary is identified by `preparing` plus persisted S evidence; it is not rescheduled or auto-published. Recovery-preparation and unknown synthetic origins are never ordinary compaction work.

**Reject:** use `tail_start_id` as published. Full summaries have no tail.

**Reject:** successful `S.finish` as published. S finishes before the explicit publication transition.

**Reject:** one global `filterCompacted` result for model history, work queue and current answer. Their requirements conflict for pending synthetic U and provisional S.

**Reject:** use separate event updates as an implicit transaction. Each write is independently durable and visible.

**Plan decision:** do not implement a restart reconciler in 008. FR-020 keeps reconciliation optional; deterministic tests prove a successful-content complete-but-unpublished candidate stays inactive after crash/reopen. If a future implementation adds reconciliation, it requires exact pair-bound evidence and no failure/cancellation, and its tests become applicable. Missing/contradictory/failed/cancelled evidence never publishes or triggers resummarization.

**Reject:** add a generic event transaction, new table, or multi-pass recovery engine to feature 008.

## Risks to settle during implementation

- **Schema encoding:** choose a tagged union accepted by the repository's Effect Schema and ensure historical records lacking fields still decode. No migration.
- **Published immutability:** prove narrow projector guards reject stale part downgrades/conflicting summary bindings and late summary/summary-content mutations after commit, rolling back event + projection together; intentional revert/delete remains supported as an explicit history change.
- **Task snapshot:** ordinary `compaction.process` must receive active projected history plus *the part owner* U (scoped through U), not every hidden historical message nor an unrelated newer user Y. Pending work must be considered before completed-turn early exit. Verify the strict legacy/new boundary, legacy unfinished-S versus `finish:"error"` scheduling parity, and non-legacy classification of explicit synthetic origin with missing publication metadata.
- **User response:** prove that `runLoop` and any user-facing final-response consumer ignore complete-but-unpublished S; do not globally change generic raw lookup API.
- **Interruption:** `preparing` after crash is not `queued`, so no duplicate model call. Cancellation cleanup can mark `abandoned`, but correctness cannot depend on completing cleanup.
- **Step finish:** ensure summary parts and successful message finish are persisted and readable before emitting final published part update.
- **No-tail:** both legacy and new no-tail published summaries must hide the head and show full summary.
- **Fork:** preallocate IDs and remap new summary bindings; a partial pair without its summary retains synthetic identity as abandoned and non-runnable, with no source-session references and no legacy reinterpretation.
- **Deletion:** `revert.cleanup` or explicit user deletion can intentionally invalidate a published pair; readers fall back to the previous valid projection, and orphan synthetic U must not cause generation.

## Explicit out of scope

1M→256K ordinary generation recovery; SessionRetry, SessionRecovery, SSE/Splash, GenerationGate, tool replay logic; hierarchical compaction; UI redesign; automatic background reconciliation.
