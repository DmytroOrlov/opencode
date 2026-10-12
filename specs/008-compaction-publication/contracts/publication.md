# Compaction publication contract — Feature 008

## Producer

1. Persist synthetic U identity and initial publication metadata before successful summary persistence. Ordinary compaction uses `origin:"compaction"`; reserve `origin:"recovery-preparation"` for future preparation. U's durable message ID is the operation/publication owner.
2. Change `queued` to `preparing` before starting the summarization assistant.
3. Only when summarization returns successful continuation and persisted S is complete/readable, emit one `PartUpdated` containing `published`, exact S ID and optional tail marker.
4. Do not publish `compact`/`stop`/error/abort results. Do not require `tail_start_id`.
5. Leave history physically intact. Do not regenerate completed-but-unpublished summaries automatically after restart.

## Consumer

1. Legacy classification requires both U.origin and P.publication to be absent; accept historically valid completed successful pairs in that shape, including no-tail.
2. A legacy pair requires both absent `U.origin` and absent `P.publication`; only this strict legacy shape receives legacy recognition and scheduling compatibility. An explicit synthetic origin with absent publication metadata is malformed new-format state, not a legacy pair, even if S appears successful.
3. New published pairs are valid only with exact referenced successful S. New ordinary pending work is schedulable only for `origin:"compaction"` and `publication.state:"queued"`; `preparing`, `abandoned`, and completed-unpublished work never execute automatically. Recovery-preparation and unknown synthetic origins never enter ordinary scheduling or generation.
4. A synthetic U without a compaction part is non-runnable and cannot become a real user prompt. A new ordinary U with its queued part is schedulable; legacy pending pairs preserve the old finished-relative rule, including unfinished S without `finish` versus `finish:"error"`.
5. A newer non-authoritative candidate never supersedes an older authoritative one.
6. Task discovery and final-response selection must not infer their state from model-history truncation alone.
7. Replayed or duplicated publish is idempotent; a later stale `PartUpdated` cannot revoke/rebind the published pair or alter its published tail. Conflicts are rejected within the same durable event transaction.
8. Stale `MessageUpdated(S)` and S-content part updates after publication may not demote the success or corrupt readable summary data. Test this protection separately from compaction-part monotonicity.
9. Explicit user revert/delete may intentionally remove published summary content, making that pair non-authoritative and restoring the last remaining valid context. This is an explicit history operation, not an allowed stale finalizer.
10. Pending compaction work is keyed by the owner's `task.messageID`; runnable work takes precedence over a completed-turn early exit. Preserve distinct legacy unfinished-S and `finish:"error"` scheduling outcomes. Task and final-response selection must remain separate from model-history filtering.
11. Forking a session preallocates all destination message IDs before cloning dependent parts, then remaps every included `publication.summaryID` and `tail_start_id`. If the referenced published summary is outside the fork subset, retain synthetic identity, mark the incomplete candidate `abandoned`, and remove source-session references; it must remain non-authoritative/non-runnable and must not become legacy pending work. Preserve complete published pairs.

## Non-goals

No publication reconciler in the plan (restart reconciliation remains optional under FR-020), no agent fallback changes, no new context-summary algorithm, no multi-event transaction, no silent migration, no recovery-preparation writer or attempt state.
