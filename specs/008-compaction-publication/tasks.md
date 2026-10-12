---
description: "Dependency-ordered implementation tasks for crash-safe compaction publication"
---

# Tasks: Crash-Safe Compaction Publication

**Input**: Design documents in `/specs/008-compaction-publication/`  
**Prerequisites**: `spec.md`, corrected `plan.md`, `research.md`, `data-model.md`, `contracts/publication.md`, `quickstart.md`

## User-story coverage and independent test criteria

- **US1 — Keep the previous conversation until publication (P1)**: Inject interruption before and after the publication event. Read model history and prove the prior published projection stays selected until a valid exact pair is published; stale updates and explicit deletion have their separately specified outcomes.
- **US2 — Continue using existing and legacy sessions (P1)**: Load legacy summaries with and without tails, chained summaries, and both legacy failed-summary shapes. Compare the selected context and pending-task behavior with the specified historical behavior.
- **US3 — Keep task scheduling and user-visible state correct (P1)**: In one session fixture, independently inspect model history, runnable tasks, generation dispatch, and the current answer for queued, orphaned, preparing, completed-unpublished, and newer-real-user cases.
- **US4 — Publish either a tailed or full summary (P1)**: Publish exact successful pairs with and without `tail_start_id`; verify both are visible only after the publication event.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The existing monorepo, schema, event projector, Bun test harness, and package typecheck are already present. No project initialization task is needed.

## Phase 2: Foundational — Phase A: Durable representation and pure recognition

**Purpose**: Make readers understand the complete new representation and legacy records before any writer emits new-format state.

- [X] T001 Extend `User` and `CompactionPart` schemas with optional extensible synthetic `origin` (known values `"compaction"` and reserved `"recovery-preparation"`) and the tagged `queued`, `preparing`, `published(summaryID)`, and `abandoned` publication states in `packages/schema/src/v1/session.ts`; U's durable message ID is the operation/publication owner. Keep absent metadata valid for legacy records and require `summaryID` only for `published`; unknown present origins remain synthetic (FR-001, FR-014, FR-015).
- [X] T002 Add one shared pure pair interpreter for legacy and new records in `packages/opencode/src/session/message-v2.ts`; classify as legacy only when both U.origin and P.publication are absent, classify new ordinary pairs only with `origin:"compaction"`, and reject explicit synthetic origins with missing publication metadata instead of falling through to legacy. Require exact U/P/S identity and successful readable summary; accept valid legacy and published new pairs with or without `tail_start_id` (FR-001–FR-003, FR-007, FR-008, FR-014, FR-015).
- [X] T003 [P] Add backward-decoding fixtures for genuine ordinary users without origin, known and unknown synthetic origins, legacy compaction parts without publication metadata, and each new publication state in `packages/opencode/test/session/schema-decoding.test.ts`; verify no migration is needed and malformed published identity is rejected (FR-001, FR-014, FR-015, FR-017).
- [X] T004 Add deterministic pair-interpreter boundary tests in `packages/opencode/test/session/message-v2.test.ts` for strict legacy identity (both fields absent), explicit `origin:"compaction"` or another synthetic origin with absent publication (not legacy, even when S looks successful), legacy tailed/full summaries, exact new `summaryID` binding, mismatched/missing S, failed S, and a newer inactive candidate over an older valid pair (FR-001–FR-003, FR-005, FR-007, FR-008, FR-014, FR-015; EC-1, EC-2, EC-11, EC-12, EC-14).
- [X] T005 Add mutation-free negative controls in `packages/opencode/test/session/message-v2.test.ts`: show that interpreting `tail_start_id` alone as publication rejects a valid full summary and that treating `S.finish` alone as publication hides prior context before commit; keep the defective interpretations in test fixtures, not production source (FR-022; EC-2, EC-4, EC-6).
- [X] T006 Route `SessionCompaction.completedCompactions` and prior-summary chaining through the shared pair interpreter in `packages/opencode/src/session/compaction.ts`; a valid legacy full summary remains complete and multiple published summaries retain their established chain (FR-007, FR-008, FR-010, FR-015; EC-1, EC-2, EC-14).
- [X] T007 Add legacy and new pair-chain regressions for `completedCompactions` in `packages/opencode/test/session/compaction.test.ts`; verify a newer incomplete, failed, or abandoned candidate never replaces the prior valid summary (FR-005, FR-010, FR-016; EC-11, EC-12, EC-14).

**Gate**: Do not enable any new-format writer until Phase A and the reader/scheduling work in Phase B are complete. Publication guards in Phase C are also a prerequisite to writer activation.

## Phase 3: Phase B — Coordinated readers and scheduling behavior

**Purpose**: Keep model projection, pending work, and user-facing response selection separate while preserving legacy behavior.

### US1 — Keep the previous conversation until publication

- [X] T008 [US1] Refactor both reverse scanning and final reordering in `MessageV2.filterCompacted` in `packages/opencode/src/session/message-v2.ts` to use the shared pair interpreter; exclude provisional U/S while retaining the previous published projection, later genuine turns, established ordering, and no-tail full-summary behavior (FR-005, FR-007–FR-010; EC-2–EC-6, EC-11, EC-12, EC-14, EC-17).
- [X] T009 [US1] Add projection regressions and a test-only negative control in `packages/opencode/test/session/message-v2.test.ts`; prove that changing only the reverse-scan `break` to `continue` still permits provisional U/S contamination, while the coordinated scan and reorder preserve the prior projection (FR-009, FR-022; EC-5, EC-6, EC-11).
- [X] T010 [US1] Verify model-visible history excludes new unpublished U/S without hiding the prior published pair or later genuine turns in `packages/opencode/test/session/message-v2.test.ts`; assert raw persisted history remains unchanged (FR-007, FR-009, FR-018; EC-5, EC-6, EC-11, EC-16).

### US2 — Continue using existing and legacy sessions

- [X] T011 [US2] Preserve legacy scheduling only for strict legacy pairs (U.origin absent and P.publication absent) in `MessageV2.latest` in `packages/opencode/src/session/message-v2.ts`; keep unfinished legacy S without terminal `finish` discoverable while `finish: "error"` continues to suppress that legacy task, using the historical latest-finished-relative cutoff (FR-014–FR-016, FR-024; EC-8, EC-12).
- [X] T012 [US2] Add paired compatibility tests in `packages/opencode/test/session/message-v2.test.ts` and `packages/opencode/test/session/prompt.test.ts` for strict legacy pending U/P with S lacking `finish` versus S with `finish: "error"`; assert the two observable scheduling outcomes remain distinct and do not leak to explicit synthetic-origin records (FR-014–FR-016, FR-024; EC-8, EC-12).

### US3 — Keep task scheduling and user-visible state correct

- [X] T013 [US3] Separate ordinary `pendingWork(raw)` discovery from model-history filtering in `packages/opencode/src/session/message-v2.ts`; retain ordinary `origin:"compaction"` + `publication.state:"queued"` U and its owning `messageID`, plus strict legacy pairs using the historical finished-relative rule, even when absent from model-visible history. Never schedule recovery-preparation/unknown origins, explicit synthetic-origin records missing publication metadata, completed-unpublished, preparing, or abandoned new-format work (FR-011–FR-016; EC-5, EC-6, EC-8, EC-9, EC-13).
- [X] T014 [US3] Wire compaction processing to `task.messageID` in `packages/opencode/src/session/prompt.ts`; build the work input from the active published projection through that exact U, excluding historically compacted head material and keeping a newer genuine Y distinct; add owner/head-history regressions in `packages/opencode/test/session/prompt.test.ts` (FR-011, FR-012, FR-018; EC-13, EC-16; negative control 7).
- [X] T015 [US3] In `SessionPrompt.runLoop` in `packages/opencode/src/session/prompt.ts`, evaluate runnable pending work before the completed-turn early exit; add a finished X→B turn followed by queued U test in `packages/opencode/test/session/prompt.test.ts` and verify U runs rather than exiting early (FR-011, FR-012; EC-13).
- [X] T016 [US3] Guard ordinary prompt dispatch in `packages/opencode/src/session/prompt.ts` so any synthetic-origin U without a matching part, any origin other than ordinary `"compaction"`, and any explicit synthetic origin with missing publication metadata is neither runnable ordinary work nor a real user prompt; add run-loop negative controls in `packages/opencode/test/session/prompt.test.ts` proving orphan/recovery-preparation/unknown-origin U cannot start model generation or be misclassified as legacy (FR-011–FR-016; EC-16; negative control 6).
- [X] T017 [US3] Update `MessageV2.latest` and current-user selection in `packages/opencode/src/session/message-v2.ts` to distinguish synthetic compaction U from a genuine current request; add a newer real Y regression in `packages/opencode/test/session/prompt.test.ts` proving compaction ownership remains U while ordinary generation remains attributed to Y (FR-011, FR-012; EC-13, EC-16; negative control 7).
- [X] T018 [US3] Make `SessionPrompt.lastAssistant` use publication-aware current-response selection in `packages/opencode/src/session/prompt.ts`; add a completed-but-unpublished S negative control in `packages/opencode/test/session/prompt.test.ts` proving it cannot be returned as the unrelated user's final answer, while a published summary and generic `Session.findMessage` retain their existing semantics (FR-011, FR-013; EC-6, EC-11; negative control 11).
- [X] T019 [US3] Add a queued-U regression in `packages/opencode/test/session/message-v2.test.ts` proving that suppressing every unpublished U loses legitimate pending work; keep the fixture independent from model-history assertions (FR-011, FR-012, FR-022; EC-5, EC-13; negative control 3).

### US4 — Publish either a tailed or full summary

- [X] T020 [US4] Add consumer-level regressions in `packages/opencode/test/session/message-v2.test.ts` for published summaries with and without `tail_start_id`; verify full summaries hide the compacted head and retain later real turns without requiring a tail (FR-008, FR-010; EC-1–EC-4, EC-17).

## Phase 4: Phase C — Publication guards and writer lifecycle

**Purpose**: Establish monotonicity guards before new-format writer activation, then add the one-event publication protocol.

### Publication guard prerequisite — complete before writer tasks T024–T029

- [X] T021 [US1] Add a narrowly scoped `PartUpdated` projector guard in `packages/core/src/session/projector.ts`; after publication reject downgrade to `queued`, `preparing`, or `abandoned`, a different `summaryID`, or a changed published tail boundary, while identical publication remains idempotent (FR-003, FR-004; EC-15; negative control 8).
- [X] T022 [US1] Add a narrow published-summary guard in `packages/core/src/session/projector.ts`; reject stale `MessageUpdated(S)` demotion/error/parent/summary changes and stale S-content part mutations that invalidate readable published content, without scanning all compaction pairs on each streaming delta (FR-002–FR-004; EC-15; negative control 9).
- [X] T023 [US1] Add projector/event tests in `packages/core/test/session-projector.test.ts` and `packages/core/test/event.test.ts` proving conflicting live writes and replayed stale writes, including a late error/cancellation finalizer, are rejected before event-log insertion, with the per-event projection, log, and sequence rolled back together; verify supported `MessageRemoved`/`PartRemoved` events remain explicit deletion operations (FR-003, FR-004, FR-018; EC-15; no generic multi-event transaction).

### US3 — Queue and begin ordinary compaction safely

- [X] T024 [US3] Update `SessionCompaction.create` in `packages/opencode/src/session/compaction.ts` to persist `origin: "compaction"` in the first durable U `MessageUpdated`, followed by the initial part with `publication: { state: "queued" }`; add creation-boundary regressions in `packages/opencode/test/session/compaction.test.ts` proving queued metadata exists before summary work can begin (FR-001, FR-012; EC-13, EC-16).
- [X] T025 [US3] Update `SessionCompaction.process` in `packages/opencode/src/session/compaction.ts` to transition new queued U to `preparing` before creating or updating S, and safely upgrade an eligible strict legacy pending U before generating its new summary; add upgrade/order tests in `packages/opencode/test/session/compaction.test.ts` proving legacy scheduling retains its historical result until the upgrade boundary, then stops automatic retry, without changing valid completed legacy pairs or unfinished-S versus `finish:"error"` behavior (FR-001, FR-014–FR-016; EC-5, EC-8, EC-9).

### US1 — Publish only a complete exact pair

- [X] T026 [US1] Keep incomplete, failed, stopped, compacted, cancelled, and interrupted summaries non-authoritative in `packages/opencode/src/session/compaction.ts`; add failure/cancellation cases in `packages/opencode/test/session/compaction.test.ts` and best-effort transition to `abandoned`, with correctness preserved if cleanup itself is interrupted (FR-002, FR-005, FR-006; EC-5, EC-8, EC-9, EC-12).
- [X] T027 [US1] Before publication, verify persisted S in `packages/opencode/src/session/compaction.ts` has the exact U parent, summary identity, successful finish, no error, and readable durable content; add missing, mismatched, and incomplete-content cases in `packages/opencode/test/session/compaction.test.ts` (FR-002, FR-003; EC-3, EC-4, EC-7).
- [X] T028 [US4] Emit exactly one final `PartUpdated` from `packages/opencode/src/session/compaction.ts` with `publication: { state: "published", summaryID: S.id }` and `tail_start_id` only when present; add tailed and full-summary tests in `packages/opencode/test/session/compaction.test.ts` and assert no publication occurs before this event (FR-003, FR-004, FR-008; EC-3, EC-4, EC-7, EC-17).
- [X] T029 [US3] Keep existing ordinary autocontinue, replay, and `Event.Compacted` behavior after successful publication in `packages/opencode/src/session/compaction.ts`; test enabled and disabled autocontinue plus a crash after publication in `packages/opencode/test/session/compaction.test.ts` and `packages/opencode/test/session/prompt.test.ts`, proving the original user request is not replayed (FR-004, FR-024; EC-3, EC-7, EC-15).

## Phase 5: Phase D — Monotonicity, deletion, and session fork

**Purpose**: Finish event invariants and make intentional deletion and cloned forward references preserve valid history semantics.

### US1 — Intentional deletion and fallback projection

- [X] T030 [US1] Preserve explicit revert/delete behavior through `packages/opencode/src/session/session.ts` and `packages/opencode/src/session/revert.ts`; when an authorized operation removes a published S, required S content, or U/P, select the preceding remaining valid projection and avoid leaving a synthetic orphan as the current user (FR-005, FR-018; EC-11, EC-14).
- [X] T031 [US1] Add focused regressions in `packages/opencode/test/session/revert-compact.test.ts` and `packages/opencode/test/session/message-v2.test.ts` for deleting a published summary or required content, reverting a published compaction, and falling back to the preceding valid pair; also prove stale finalizer updates are rejected rather than treated as deletion (FR-004–FR-006, FR-018; EC-11, EC-15).

### US2 — Preserve published compactions in forked sessions

- [X] T032 [US2] Change `Session.fork` in `packages/opencode/src/session/session.ts` to allocate destination message IDs for the entire selected subset before cloning messages or dependent parts; remap every included `tail_start_id` and forward-referenced `publication.summaryID`. If U is included but its published S is outside the subset, retain synthetic identity and set the incomplete candidate to `abandoned`, with no dangling source IDs; it must remain non-authoritative/non-runnable and must not be reinterpreted as legacy pending work. Preserve complete published pairs unchanged apart from ID remapping (FR-003, FR-010, FR-015, FR-018; EC-14, EC-16; negative control 10).
- [X] T033 [US2] Add focused fork regressions in `packages/opencode/test/session/session.test.ts` for multiple chained published summaries, tailed and full pairs, and a cutoff between U and S; reopen the fork and verify valid pairs project unchanged, partial candidates retain synthetic identity as abandoned/non-runnable, no source-session ID references remain, and no summary is fabricated (FR-003, FR-010, FR-014, FR-015; EC-14, EC-16).

## Phase 6: Phase E — Crash windows and regression verification

**Purpose**: Validate every independent durable boundary against all applicable readers and preserve the supplied staged fallback work.

- [X] T034 Add deterministic interruption tests before U creation, after U but before its part, after queued, after preparing, and during S streaming in `packages/opencode/test/session/compaction.test.ts` and `packages/opencode/test/session/prompt.test.ts`; after each reopen assert model projection, pending work, current answer, publication state, and unchanged historical records (FR-001, FR-006, FR-020, FR-021; EC-5, EC-9, EC-13, EC-16).
- [X] T035 Add deterministic interruption tests after S completion but before publication, during the final publication event, after publication, and during failure/cancellation cleanup in `packages/opencode/test/session/compaction.test.ts`; at each reopened state verify applicable model projection, pending work, current answer, publication state, and durable historical preservation, plus no implicit retry or replay (FR-002–FR-006, FR-020, FR-021; EC-3, EC-6–EC-10, EC-15).
- [X] T036 Add a mutation-free negative control in `packages/core/test/event.test.ts`: persist `MessageUpdated(U)`, interrupt before `PartUpdated(P)`, and assert reopen observes the tagged orphan U with no runnable task or prompt; compare with a test-only atomic-pair assumption that predicts no durable U or a complete pair and fails those assertions (FR-003, FR-021, FR-022; EC-16; negative control 5).
- [X] T037 Complete the case-indexed regression matrix across `packages/opencode/test/session/message-v2.test.ts`, `packages/opencode/test/session/compaction.test.ts`, `packages/opencode/test/session/prompt.test.ts`, `packages/opencode/test/session/revert-compact.test.ts`, `packages/opencode/test/session/session.test.ts`, and `packages/core/test/session-projector.test.ts`; cover normative EC-1 through EC-18, including `context: 0` as an unknown ceiling, and map each case to model projection, scheduling, current response, publication status, and durable-history assertions. EC-10 MUST prove successful-content complete-but-unpublished inactivity after crash/reopen; actual reconciliation and repeated-reconciliation assertions are conditional on implementing that optional capability. Prove missing/contradictory/failed/cancelled evidence never publishes or automatically resummarizes; prove ordinary publication and event replay idempotence; cover reserved recovery-preparation identity only at schema/dispatch/scheduling distinction, with no recovery writer or fallback (FR-014, FR-020–FR-023).
- [X] T038 Run focused tests from `packages/opencode/` with `bun test test/session/message-v2.test.ts test/session/compaction.test.ts test/session/prompt.test.ts test/session/session.test.ts test/session/revert-compact.test.ts test/session/schema-decoding.test.ts test/session/processor-effect.test.ts --timeout 30000`, and persistence tests from `packages/core/` with `bun test test/session-projector.test.ts test/event.test.ts --timeout 30000`; retain the staged fallback-aware summary, per-model budget preflight, oversized-known-context, `context: 0`, SSE-to-fallback, and replay-safety regressions, preserve staged baseline files, and leave feature 007 untouched (FR-019, FR-024).
- [X] T039 Run `bun run typecheck` from `packages/opencode/` and the relevant repository typecheck if affordable; record results without running live inference or large-context experiments (`packages/opencode/package.json`; FR-023, FR-024).
- [X] T040 Run `git diff --check` and `git diff --cached --check` from `/Users/do/git/opencode`; confirm implementation changes preserve the staged fallback work and do not modify feature 007 (`specs/008-compaction-publication/tasks.md`; FR-024).

## Dependencies and execution order

- **Setup**: Existing infrastructure; no setup task.
- **Phase A / foundational (T001–T007)**: Schema and shared pair recognition precede every reader and writer change. T003 and T004 can run in parallel after T002; T006 follows T002, and T007 follows T006.
- **Phase B / readers (T008–T020)**: Depends on Phase A. Complete all model-history, pending-work, owner, synthetic-origin, response-selection, and legacy-compatibility work before enabling new-format writers. Tasks touching the same source or test file remain serial.
- **Phase C / safety gate (T021–T023)**: Depends on Phase B and MUST finish before T024–T029 can activate new-format writes. Use the existing per-event transaction in `packages/core/src/event.ts`; do not add a generic transaction or assume the separate U/P/S events are atomic together.
- **Phase C / writer (T024–T029)**: Depends on T021–T023. T024 precedes T025–T029; `preparing` and exact persisted summary verification precede the single publication event; autocontinue follows publication.
- **Phase D (T030–T033)**: Depends on guards and writer semantics. Deletion and fork behavior are reviewed with the same shared pair interpreter and event guards.
- **Phase E (T034–T040)**: Depends on Phases A–D. Restart reconciliation remains optional under FR-020; this plan implements no reconciler and T037 verifies inactive successful-content candidates after reopen. If the optional capability is later implemented, its positive and repeated-reconciliation tests become applicable.

## Negative-control index

| Defective behavior | Task |
|---|---|
| `tail_start_id` treated as publication; completion alone treated as publication | T005 |
| Only reverse-scan `break` fixed | T009 |
| All unpublished U messages suppressed from scheduling | T019 |
| Pending task checked after completed-turn exit | T015 |
| `lastUser.id` used instead of `task.messageID` | T014, T017 |
| Synthetic orphan U dispatched as real prompt | T016 |
| Complete-unpublished S returned as current answer | T018 |
| Stale part update revokes/rebinds publication | T021, T023 |
| Stale summary update corrupts published pair | T022, T023 |
| Fork omits forward `summaryID` remapping | T032, T033 |
| Independent event writes assumed atomic together | T036 |

## Delivery checkpoints

- **Reviewable Phase A**: Additive durable schema and legacy/new pure recognition; no new writer enabled.
- **Reviewable Phase B**: Model projection, scheduling, generation ownership, and answer selection work through existing legacy and new read shapes; no new writer enabled.
- **Reviewable Phase C gate**: Both part and referenced-summary guards pass actual event/projector tests before writer activation. Then publish through one final `PartUpdated` only after verified summary success.
- **Reviewable Phase D**: Explicit deletion falls back to a valid prior projection; complete and partial forks contain no dangling source IDs.
- **Reviewable Phase E**: Deterministic crash and regression suite plus verification commands, including EC-10's inactive-after-reopen proof; reconciliation tests are conditional on implementing that optional capability.

## MVP scope

The minimum independently reviewable increment is Phase A plus the US1 read-projection subset of Phase B: legacy and new exact-pair recognition, including valid no-tail summaries, with provisional U/S excluded and the prior valid projection retained. Writer activation is not a safe MVP until all Phase B scheduling/response consumers and Phase C publication guards are complete.

## Task and parallel-work summary

- **US1**: 10 tasks; independent test criterion is prior-projection stability through interruption, publication, stale writes, and explicit deletion.
- **US2**: 4 tasks; independent test criterion is legacy context and scheduling parity, including chained summaries and fork remapping.
- **US3**: 10 tasks; independent test criterion is separate model, pending-work, dispatch-owner, and current-answer results for the same fixture.
- **US4**: 2 tasks; independent test criterion is successful exact-pair publication both with and without a retained tail.
- **Shared foundational and cross-cutting tasks**: 14 tasks (7 foundational, 7 final verification).
- **Parallel opportunity**: T003 schema-decoding tests and T004 pair-recognition tests can run in parallel after T002 because they touch separate test files. Other tasks are ordered or share implementation/test files and are intentionally unmarked `[P]`.
