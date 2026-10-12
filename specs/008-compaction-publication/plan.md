# Implementation Plan: Crash-Safe Compaction Publication

**Branch**: `dev` (existing checkout; feature selector `specs/008-compaction-publication`)  
**Date**: 2026-10-09  
**Spec**: `specs/008-compaction-publication/spec.md`  
**Source snapshot**: `818bb2953e` plus existing staged compaction/fallback fixes, as supplied in `opencode-008-plan-review-20261009-003647.zip`

## Summary

Make new compaction results authoritative only at a single durable, pair-bound publication transition. Preserve existing completed legacy compactions, including full summaries with no `tail_start_id`. Treat persistence of a summary and visibility of that summary as distinct operations. Separate model-history selection, pending ordinary compaction scheduling, and current-answer selection. No generation-fallback or multi-pass summarization work belongs to feature 008.

## Technical Context

**Language/Version**: TypeScript, Bun, Effect, repository's existing Schema/SQL infrastructure  
**Primary Dependencies**: `packages/schema`, `packages/core` event projector, `packages/opencode` Session and MessageV2  
**Storage**: Existing event-sourced `MessageTable` and `PartTable`, per-event `MessageUpdated` and `PartUpdated`; no new DB table  
**Testing**: Bun deterministic session/effect fixtures, package typecheck  
**Target Platform**: Current OpenCode-supported runtimes  
**Project Type**: Existing monorepo session subsystem  
**Performance Goals**: No model call, extra provider round trip, scan beyond existing full-history hydration, or per-token publication update  
**Constraints**: Legacy no-tail compatibility, one-event publication, durable identity before summary, preserved pending task scheduling; do not alter staged code or feature 007  
**Scale/Scope**: Pure interpretation + small writer ordering changes; no broad persistence redesign

## Constitution Check

- Reuse the repository's existing `Session.updatePart` / event projector and `SessionCompaction` rather than introducing another persistence engine.
- Preserve dispatch source of truth, replay-safe tool behavior, provider integrations, UI and ordinary compaction workflow.
- Use deterministic tests of actual reader/scheduler entrypoints, not only a predicate; explicitly exercise negative controls.
- New state is session/projection metadata, not attempt telemetry; no polling, performance inference, or extra provider work.
- Do not mutate existing source or index during planning. Re-run this gate after implementation design is finalized.

## Project Structure

```text
specs/008-compaction-publication/
├── spec.md                     # existing authoritative requirements
├── plan.md                     # this plan
├── research.md                 # source-backed reasoning and trade-offs
├── data-model.md               # durable state/transition rules
├── quickstart.md               # deterministic validation strategy
├── contracts/
│   └── publication.md          # reader/writer/queue boundary
└── tasks.md                    # intentionally not created at plan stage
```

Targeted source files:

```text
packages/schema/src/v1/session.ts                  # optional User origin + CompactionPart publication
packages/core/src/session/projector.ts             # monotonic part publication guard, only if required
packages/opencode/src/session/message-v2.ts        # pair interpreter, projection, current-state selection
packages/opencode/src/session/compaction.ts        # pending/running lifecycle and final publish
packages/opencode/src/session/prompt.ts            # distinct task and visible-history inputs
packages/opencode/src/session/session.ts           # Session.fork two-pass ID mapping + explicit deletion/revert behavior; no global API changes
packages/opencode/src/session/revert.ts            # intentional revert/delete interaction with published pairs
packages/opencode/test/session/message-v2.test.ts  # legacy, new projection, scheduling
packages/opencode/test/session/compaction.test.ts  # write ordering, cancellation, no-tail
packages/opencode/test/session/prompt.test.ts      # actual loop and response selection
```

## Architecture and ownership

### 1. Durable identity (before any completed summary)

Use **two complementary, backward-compatible optional annotations**:

1. `User.origin?: string` on synthetic user messages, written in the FIRST `MessageUpdated`. `"compaction"` identifies ordinary compaction; `"recovery-preparation"` is reserved for future preparation. The durable synthetic operation/publication owner is the U message ID. Omission retains genuine ordinary-user semantics; any present, including unknown future, origin is synthetic and must not be treated as a normal user prompt. Legacy compaction users continue to be recognized by their parts.
2. `CompactionPart.publication?: { state: "queued" | "preparing" | "published" | "abandoned"; summaryID?: MessageID }` persisted with the FIRST compaction `PartUpdated`. `published` MUST carry the exact successful summary ID; other states MUST NOT. Absence means legacy, not `unpublished`. `tail_start_id` remains solely the optional recent-tail boundary.

The schema may use a discriminated union to enforce the summary ID constraint. `publication` is not optional *for new writes*; it is optional only to decode legacy records. Classify a pair as legacy only when **both** U has no `origin` and P has no `publication`; preserve that legacy pair's historic finished-relative scheduling rule. A new ordinary pair is schedulable only when U has `origin:"compaction"` and P has `publication:{state:"queued"}`. `preparing`, `abandoned`, and completed-but-unpublished new pairs never execute automatically. Any explicit synthetic origin paired with missing publication metadata is malformed new-format state, never legacy; recovery-preparation and unknown origins never enter ordinary compaction scheduling or generation. A synthetic U without a compaction part cannot initiate generation. Future recovery preparation uses the same exact-pair publication contract, but its writer, fallback, and attempt state are outside 008. An eligible legacy pending part MUST be upgraded to `preparing` before writing a new summary; legacy scheduling behavior remains unchanged until that transition. Never upgrade already completed valid legacy pairs merely to reclassify them.

### 2. Publication linearization point

`CompactionPart`'s **single final `PartUpdated`** atomically changes its publication state from `preparing` to `{state:"published",summaryID:S.id}` and, if one exists, carries the finalized `tail_start_id` in the same event. This event is emitted only after persisted summary parts and a successful summary `MessageUpdated` (`finish` truthy and `error` absent), and after read-back or equivalent durable verification of readable summary content. Never publish on a `"stop"`, `"compact"`, failed fallback, or interrupted processor result.

A reader activates a new pair only if the part is `published`, it points to the exact S, and S is a matching successful completed summary. `published` with missing/incomplete/mismatched S is non-authoritative (not interpreted as legacy). Any incomplete `queued`/`preparing`/`abandoned` pair remains non-authoritative regardless of S.finish. The prior valid projection remains selected.

Publication is a one-way transition **for ordinary updates**. A compaction-specific guard in the durable `PartUpdated` projector must reject (rolling back the whole durable event transaction) a stale state downgrade, conflicting `summaryID`, or changed published tail boundary; the identical committed publication is idempotent. The event log, sequence, and all projectors for each durable event already commit in one `db.transaction(..., {behavior:"immediate"})` (`packages/core/src/event.ts`). This establishes per-event linearization, **not** a multi-event transaction; an older writer publishing stale in-memory data at a *new sequence* remains possible and requires the guard.

**The summary is a second mutable object, and must be protected too.** Once U's part publishes S, stale `MessageUpdated(S)` must not remove `finish`, set `error`, change `summary`/`parentID`, or otherwise invalidate the referenced successful summary. A narrow guard in the message projector (only for attempted post-completion demotions of a compaction summary) must check publication binding inside the same transaction; likewise prevent stale `PartUpdated` from mutating published S content/provenance. Ensure this does not scan every compaction part on every streaming token update. Test each invalid update is **rejected before event-log insertion** and the published projection survives. Never treat a surviving `{state:"published",summaryID}` as proof that a missing or malformed S is readable: pair-validity checks remain required.

**Explicit user revert/delete is different from a stale finalizer.** `revert.cleanup` and the existing remove APIs can intentionally remove S, its text parts, or U/P. Do not silently block supported user-initiated history operations; a deliberately removed published S makes the pair non-authoritative and re-exposes the preceding valid projection. Specify and test such deletion as an explicit history-changing operation, not a stale publication update or an implicit compaction failure. Avoid leaving a synthetic orphan as the current user after revert. Treat `MessageRemoved`/`PartRemoved` as explicit deletion events under the current API; do not infer a stale *update* from them. Check any newly discovered asynchronous deletion writer separately rather than blocking supported revert behavior.

### 3. Read model (three separate decisions)

Implement one shared pure pair-interpreter (or similarly narrow helpers), reused by `filterCompacted` and `completedCompactions`:

- Legacy pair: part has no `publication` and a valid completed successful associated summary; published, **with or without** `tail_start_id`.
- New pair: `publication.state === "published"`, exact `summaryID`, valid completed successful summary; published with optional tail.
- Every other new pair: not published. An incomplete/failed newer pair never supersedes an older published pair.

Compute from a single chronological raw session snapshot (currently `MessageV2.stream` returns newest-first) but expose distinct outputs:

- **Model history**: last valid published boundary + selected retained tail + later *genuine* turns, excluding new provisional U/S. Preserve the current valid-pair reordering and no-tail full-summary semantics. Do not merely change `break` to `continue` in the existing reverse scan; both reverse scan and final reorder require a coordinated rewrite/test.
- **Work selection**: pending ordinary compaction U is discoverable from raw/task history, even though it is absent from model history. Legacy pairs (absent U origin and absent P publication) use the historical finished-relative `MessageV2.latest` rule, including unfinished S without `finish` remaining discoverable and `finish:"error"` suppressing U. New ordinary work starts only for `origin:"compaction"` plus `publication.state:"queued"`; `preparing`, `abandoned`, complete-unpublished, recovery-preparation, and unknown-origin records do NOT execute automatically. Explicit synthetic U with missing publication metadata is not legacy. Preserve the distinction between normal work and future recovery preparation.
- **Current response/turn**: provisional/unfinished/new complete-unpublished summary cannot be the current completed assistant answer to an unrelated user. Ordinary **published** summary/auto-continue semantics remain intact. `SessionPrompt.lastAssistant` currently reads raw newest-first via `sessions.findMessage`; use an appropriate publication-aware selection for its user-facing return where necessary, without globally changing generic `findMessage` semantics.

**Specify the concrete `runLoop` wiring, not just three abstract selectors:**

1. Compute `modelHistory(raw)` for LLM messages and `pendingWork(raw)` independently. `pendingWork` keeps each part's owner `messageID` and ordering; classify strict legacy pairs separately from new ordinary queued pairs, preserving legacy finished-relative behavior. Before the finished-turn early-exit guard, check runnable ordinary work (or move task selection above that guard). Otherwise X→completed B followed by pending U returns early before executing U.
2. For a compaction task, pass **`parentID: task.messageID`**, not `lastUser.id`. Load the matching U and its part by ID, and build its compaction-work input from the applicable previously published projection through U (preserving genuine later turns separately); a newer real user Y must not redirect the task to Y. Do not use synthetic U to derive the logical real-user intent for ordinary generation.
3. Any synthetic-origin U with no matching compaction part (crash between first message and part, or cleanup), and any synthetic origin other than `"compaction"`, is **neither** an ordinary runnable task **nor** a normal generation prompt. Explicit `origin:"compaction"` with missing publication metadata is malformed and cannot fall back to legacy recognition. Guard before agent/model/provider dispatch. Normal new queued U remains runnable even if excluded from model-visible history; origin-absent/publication-absent legacy pairs retain historical scheduling.
4. Choose the latest **real** user as generation owner; task owners are resolved by task ID; current-answer selection skips new provisional/unpublished S. `SessionPrompt.lastAssistant` currently searches raw newest-first and must be updated only for user-facing/loop-result selection, preserving legitimate published-summary behavior and generic `Session.findMessage` semantics. Define deterministic priority when U is pending and a genuine Y is newer; never silently discard either the work or Y's request.

**Legacy scheduling compatibility:** the historic `MessageV2.latest` rule is *relative to the newest finished assistant*. A legacy interrupted S **without `finish`** can leave U discoverable, whereas a capacity-failed S with `finish:"error"` advances `finished` and suppresses U. Preserve both observable cases, including chronological cutoff/part ordering, rather than treating every legacy pair without successful S as schedulable. New `publication.state === "queued"` is the runnable new-format state; `preparing`, `abandoned`, and completed-but-unpublished are not implicitly runnable. This change in new-format retry behavior is intentional per spec edge case 8; it must not silently change legacy behavior.

`SessionCompaction.process` must receive a compaction-input history containing the selected prior published projection **plus its actual pending U**, not arbitrary raw history (which would reintroduce previously compacted head material). `SessionPrompt.runLoop` currently combines task discovery with `latest(filterCompacted(...))`; explicitly split these readers without changing primary/fallback recovery decisions.

### 4. Writer transitions and cancellation

`create`: emit new U with `origin:"compaction"`, then its part with `publication:{state:"queued"}`. If crash lands between the two writes, orphan U is identifiable and not treated as a genuine prompt.

`process`: mark new queued or historically runnable legacy U as `preparing` **before** S is created or updated; process the model as before; only after success verify S and publish the one final part event; only **after publication**, follow existing ordinary autocontinue/replay behavior and `Event.Compacted`. An origin-absent/publication-absent legacy pair follows its historic scheduling rule until this explicit upgrade; upgrading an eligible legacy pending part to `preparing` is the boundary after which it is not automatically re-run. If the process fails, try to mark `abandoned`; if this cleanup is interrupted, persisted `preparing` stays unpublished and is not automatically rescheduled. No destructive deletion of prior messages/parts.

Avoid attempting to make publication plus autocontinue one transaction. A crash after publish but before synthetic continuation keeps a valid published projection; it must not invent a replay of a user request. Legacy ordinary auto-continue remains unchanged during normal execution.

### 5. Restart behavior

No background reconciliation is implemented by this plan. A completed S with state `preparing` stays unpublished after restart, including when its content and successful finish are durable. Deterministically prove this state remains inactive, and prove missing, contradictory, failed, or cancelled evidence neither publishes nor resummarizes it. Do not re-run S merely to publish. FR-020 permits an optional future reconciler with exact pair-bound evidence and no failure/cancellation; tests of actual reconciliation apply only if that capability is implemented. Ordinary publication and event replay remain idempotent. `context:0` remains untouched.

**Session forks are a required reader/writer consumer.** `Session.fork` copies messages with *new IDs*. Its current `idMap` is populated while cloning messages oldest-first: at U, its later summary S has no clone ID yet. Allocate IDs for **all messages included in the fork first**, then clone messages/parts using that full map. Remap every included `publication.summaryID` and `tail_start_id`; validate that the referenced S actually belongs to the forked subset. For a cutoff between U and S, retain U's synthetic origin but make its incomplete candidate explicitly `abandoned`; never carry a `published` reference to the source session, fabricate a completed pair, or reinterpret it as legacy pending work. Preserve earlier valid published context. Add fork-full-pair, fork-with-tail, and fork-partial-pair tests.

## Incremental implementation sequence

**A — representation and negative controls.** Update Schema types and pure pair interpreter; tests for strict legacy identity (both origin and publication absent), explicit synthetic origin with absent publication (not legacy), absent-metadata legacy (tailed/full), mismatched new S, no-tail published pair, and old valid pair with newer inactive pair. Negative controls demonstrate that `tail_start_id` and S.finish alone cannot signify publication. This must be landed without enabling writers of new pairs until readers understand them.

**B — coordinated readers.** Refactor `filterCompacted` both stages and `completedCompactions` through shared interpretation; separate pending task discovery/current response from model history. In the same reviewable stage, explicitly wire `task.messageID` as compaction parent; check pending work before the finished-turn exit; skip orphan/unknown-origin synthetic U as a generation prompt; exclude new unpublished S from current response; preserve strict legacy pair classification and its unfinished/error scheduling boundary, and reject explicit synthetic origin with missing publication metadata as legacy. Tests via `latest()`, `filterCompactedEffect`, and actual `SessionPrompt.runLoop` must kill each broken branch, including a genuine newer Y. Assert raw history remains byte-identical. This stage must preserve legacy fixtures.

**C — writer/commit protocol.** Make `create` tag U and part, `process` transition queued→preparing before S, validate successful completion/content, publish exactly once with optional tail, then perform autocontinue/replay. On failures leave inactive, mark abandoned when possible. Guard against stale competing part writes **and** stale summary demotion/content updates in the per-event projectors; test transaction rollback on rejection, intentional revert/removal, stage-by-stage crash windows and duplicate/stale publication. Explicitly test upgrade of a legacy pending U.

**D — integration/regression.** Full matrix of 18 cases; independent event writes/read snapshots; process restart simulation; multiple chained summaries; pending task with newer real user; both legacy failed-S shapes; ongoing ordinary task; cancellation; both tail shapes; synthetic orphan U; `Session.fork` with complete/partial published pairs and preallocated ID remapping; intentional `revert.cleanup` and user deletion; stale S demotion/content mutation after publication; existing staged fallback-aware compaction tests and SSE/replay focused suites. Negative controls must fail assertions on deliberately invalid pre-fix interpreter/ordering but not mutate the repository baseline.

**E — safety verification and signoff.** Focused tests, `bun run typecheck` in `packages/opencode` (or equivalent package script), existing repository typecheck as affordable, `git diff --check`, `git diff --cached --check`. Do not run live inference, modify 007, run broad tests without cause, stage/commit automatically, or claim automatic restart reconciliation.

## Safety gates / no-go conditions

Do NOT proceed to generation fallback if any of these remains unproven: (1) published full-summary without tail; (2) summary completed but not published leaves old projection; (3) stale part/summary updates cannot revoke a publication; (4) ordinary pending task executes while hidden from model history and uses `task.messageID`; (5) orphan compaction user cannot initiate generation; (6) newest assistant / return value is not provisional; (7) no resummarization after process crash; (8) legacy pending records are upgraded before new summary persistence, without altering legacy failed-S scheduling; (9) fork remaps future summary IDs using a preallocated map and handles cutoffs; (10) explicit revert/delete leaves a valid prior projection.

## Complexity Tracking

No new table, generic transaction service, global async reconciler or inference-based context fitting is proposed. Narrow optional user-origin metadata is justified by the independent `MessageUpdated`→`PartUpdated` orphan-user crash window. Narrow monotonicity enforcement for published parts **and referenced successful summary content** is justified by existing unconditional upserts. Explicit user-initiated deletion/revert is a separate, intentionally invalidating history operation, covered by tests rather than silently blocked.
