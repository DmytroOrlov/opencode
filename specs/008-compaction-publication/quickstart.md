# Implementation/validation quickstart — Feature 008

All testing is local and deterministic. Do not launch model inference or alter feature 007.

## Incremental regression gates

1. **Legacy reads:** legacy completed summary with and without tail; multiple summaries and previousSummary chaining; failed legacy summary; exact observable context parity.
2. **New inactive reads:** queued, preparing, failed, abandoned, completed-unpublished; prior published pair remains active; no provisional U/S reaches model payload, `latest` or final answer.
3. **Scheduling:** ordinary `origin:"compaction"` queued U remains runnable (even when the preceding real turn is finished); task's owner `messageID`, not latest real user's ID, is passed to compaction; synthetic U without part and unknown/future origins cannot dispatch as normal prompts; recovery-preparation origin is reserved and never ordinary queued work; preparing U after crash cannot regenerate S; explicit legacy-pending upgrade; parity for legacy S without `finish` vs with `finish:"error"`; a later genuine user Y remains a genuine request.
4. **Publication:** successful tailed and full summary; exact S ID; missing/mismatched S rejected; duplicate publication/idempotency; late stale part updates do not unpublish/rebind/replace tail; late S error/finish/parent demotions and S-content mutations are rejected inside one durable transaction; explicit user revert/delete intentionally falls back to prior valid context.
5. **Crash windows:** inject interruption after each N0–N7 event of `data-model.md`; reopen and verify model history/task/answer independently. A successful-content complete-but-unpublished pair remains inactive and is not resummarized; actual reconciliation tests apply only if the optional reconciler is implemented. Missing/contradictory/failed/cancelled evidence never publishes or resummarizes.
6. **Existing workflows:** ordinary `autocontinue` enabled/disabled, prior-summary chaining, staged fallback-aware compaction regression, `context:0` preflight, SSE→fallback test unaffected.
7. **Fork:** complete legacy/new published pair with and without a tail, preallocated summary ID forward-reference remap, fork cutoff between U and S, retained synthetic identity with abandoned non-runnable candidate and no dangling source-session IDs; reopening fork preserves its valid model projection.

## Negative controls

For each, run an assertion against a controlled deliberately incorrect interpretation or existing baseline in a disposable fixture; ensure it fails without modifying production source:

- `tail_start_id` means published → breaks valid no-tail summary.
- S.finish means published → prematurely hides history between S finish and publication event.
- Hide all unpublished U → loses queued compaction task.
- Single `break → continue` reverse-scan change → still lets provisional U/S contaminate the model/answer.
- Treat separate write events as an atomic pair → fails crash snapshot.
- Treat new U with no part as an ordinary user → falsely launches generation.
- Accept stale `PartUpdated(preparing)` after `published` → revokes durable publication.
- Update published S with a late `error`/missing finish (or mutate its required text) → pair becomes invalid despite a published part.
- Remap `publication.summaryID` with a one-pass, oldest-first `idMap` → misses the forward referenced S.
- Drop pending U when prior X→B is finished → task never runs; pass `lastUser.id` with later Y → wrong compaction parent.
- Mark every incomplete legacy summary as runnable → changes historical `finish:"error"` behavior.

## Suggested commands (run from checkout, not from this exported file)

```zsh
(
  cd /Users/do/git/opencode/packages/opencode
  bun test test/session/message-v2.test.ts test/session/compaction.test.ts --timeout 30000
  bun test test/session/prompt.test.ts --timeout 30000
  bun run typecheck
)
(
  cd /Users/do/git/opencode
  git diff --check
  git diff --cached --check
)
```

These are proposed verification commands, NOT test results. Avoid test runs until implementation.
