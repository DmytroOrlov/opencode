# Feature Specification: Crash-Safe Compaction Publication

**Feature Branch**: `[008-compaction-publication]`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "Specify crash-safe, backward-compatible compaction publication semantics without implementing generation fallback."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep the previous conversation until publication (Priority: P1)

A user starts a normal or automatic compaction. While its summary is being prepared, or if that work fails, is cancelled, or is interrupted, the user can continue from the last valid model-visible conversation. A new summary takes over only after an explicit successful publication transition.

**Why this priority**: A partial or failed summary must never silently hide the conversation that the model and user relied on.

**Independent Test**: Construct a session with prior history and inject interruption at each persistence boundary. Before the publication commit point, verify the prior projection remains selected; after it, verify the complete new compaction pair is selected.

**Acceptance Scenarios**:

1. **Given** a valid prior projection and a summary that is still streaming, **When** model history is read, **Then** the prior projection remains authoritative and the partial summary is excluded.
2. **Given** a complete summary with no publication transition, **When** the process restarts, **Then** the prior projection remains authoritative.
3. **Given** a valid complete summary and a successful publication transition, **When** model history is read after that transition, **Then** the full pair is authoritative as one indivisible result.
4. **Given** a published compaction followed by a newer unfinished or failed compaction, **When** model history is read, **Then** the earlier published compaction remains authoritative.

### User Story 2 - Continue using existing and legacy sessions (Priority: P1)

A user opens an existing session whose completed compaction predates explicit publication. The session retains its prior behavior whether the summary preserved a recent tail or summarized the full history.

**Why this priority**: Users must be able to reopen existing history without migration or a change to what the model sees.

**Independent Test**: Load legacy records with and without `tail_start_id`, including chained summaries, and compare their model-visible history with the established behavior.

**Acceptance Scenarios**:

1. **Given** a valid legacy summary paired with a compaction request and a recent-tail marker, **When** the session is read, **Then** the summary and the marked recent tail remain visible according to existing ordering rules.
2. **Given** a valid legacy full summary with no `tail_start_id`, **When** the session is read, **Then** the summary remains authoritative and the absence of a tail is not interpreted as failure or incompletion.
3. **Given** multiple valid legacy summaries, **When** the session is read or compacted again, **Then** existing prior-summary chaining and history selection are preserved.
4. **Given** a legacy failed or interrupted record, **When** the session is read, **Then** that record does not replace a prior valid summary or conversation.

### User Story 3 - Keep task scheduling and user-visible state correct (Priority: P1)

An ordinary compaction can remain pending and executable without being sent as model context or displayed as the final answer to an unrelated user request. A provisional preparation summary also cannot be mistaken for ordinary pending compaction work.

**Why this priority**: Model history, background work, and the current user-facing response have different meanings and must not be inferred from one shared message list.

**Independent Test**: Build sessions containing pending compaction work, completed-but-unpublished summaries, and newer real user requests. Check model projection, pending task discovery, and current response selection separately.

**Acceptance Scenarios**:

1. **Given** an ordinary compaction request with its pending-work identity but no completed summary, **When** the session is reopened, **Then** the previous model context remains visible and the pending task remains discoverable and executable.
2. **Given** a completed but unpublished preparation summary, **When** task and response state are read, **Then** it is neither authoritative model context nor an ordinary compaction task nor the final answer to an unrelated user request.
3. **Given** a compaction message interleaved with a newer real user request, **When** current session state is selected, **Then** the real request and its response retain their existing meaning.

### User Story 4 - Publish either a tailed or full summary (Priority: P1)

A user compacts history that either fits a preserved recent tail or is too large to preserve any tail. Both completed forms can be published successfully.

**Why this priority**: Recent-tail preservation is an optimization of compaction content, not evidence that publication succeeded.

**Independent Test**: Publish one complete summary with a valid tail marker and one complete full summary without one; verify each resulting model-visible history independently.

**Acceptance Scenarios**:

1. **Given** a complete summary and a valid `tail_start_id`, **When** it is published, **Then** the summary and intended recent tail are visible in the established order.
2. **Given** a recent turn too large to preserve within the existing budget, **When** its complete full summary is published without `tail_start_id`, **Then** the full summary is authoritative and no nonexistent tail is required.
3. **Given** model metadata `context: 0`, **When** compaction behavior is evaluated, **Then** zero continues to mean an unknown ceiling, not zero usable input.

### Edge Cases

The following matrix is normative. “Prior projection” means the last valid model-visible conversation before the candidate compaction. Scheduling is about ordinary compaction task discovery, not model-context visibility.

| # | Case | Model-visible history | Publication status | Scheduling consequence |
|---|---|---|---|---|
| 1 | Valid legacy summary with a recent tail | Existing legacy summary plus its marked tail, under established ordering | Legacy interpreted as published | No new task; preserve existing continuation behavior |
| 2 | Valid legacy full summary without `tail_start_id` | Existing legacy full summary and any later genuine turns | Legacy interpreted as published | No new task; absence of a tail does not schedule or fail work |
| 3 | New successful summary with a recent tail | Prior projection before commit; summary plus intended tail after commit | Unpublished, then published at the commit point | No extra task after completion; normal continuation remains unchanged |
| 4 | New successful full summary without `tail_start_id` | Prior projection before commit; full summary plus later genuine turns after commit | Unpublished, then published at the commit point | No extra task after completion; no tail is required |
| 5 | Summary still streaming | Prior projection; no streamed summary content is authoritative | In progress, unpublished | Ordinary compaction may remain schedulable; provisional preparation is not ordinary work |
| 6 | Summary completed but not published | Prior projection | Complete, unpublished | Do not regenerate completed ordinary work solely to publish it; publication reconciliation is distinct from generation scheduling |
| 7 | Publication requested after successful summary completion | Prior projection until commit; complete new pair afterward | Complete, then published at the commit point | Resolve the publication action once; do not enqueue duplicate ordinary work |
| 8 | Summary failed before publication | Prior projection | Failed, unpublished | Failed work is not schedulable as pending work unless an existing explicit retry is initiated |
| 9 | User cancellation before publication | Prior projection | Abandoned, unpublished | Do not resume as pending ordinary work without a new explicit request |
| 10 | Process crash between summary completion and publication | Prior projection after restart, including when the candidate contains successful summary content | Complete but unpublished remains inactive after reopen when no reconciler is implemented; if the optional reconciler is implemented, only exact pair-bound successful/readable evidence with no failure or cancellation may be reconciled idempotently | Never publish or automatically resummarize on missing, contradictory, failed, or cancelled evidence; do not regenerate successful completed content merely because publication was interrupted |
| 11 | Old published summary followed by a newer unpublished summary | Old published projection remains authoritative | Older published; newer unpublished | Newer work is schedulable only if it is independently identified as ordinary pending compaction |
| 12 | Old published summary followed by a newer failed summary | Old published projection remains authoritative | Older published; newer failed | No pending task from the terminal failed record |
| 13 | Pending ordinary compaction that must remain schedulable | Prior projection; pending compaction messages do not replace it | Not yet published | Pending ordinary task remains discoverable and executable |
| 14 | Multiple successive published compactions | Latest valid published compaction and its intended tail, with prior-summary chaining preserved | Each valid publication remains historical; latest applicable one is authoritative | No completed task is re-enqueued |
| 15 | Repeated publication or event replay | Same projection as the first successful publication | Idempotently published; no contradictory state | No duplicate task or duplicate effective publication |
| 16 | Session reopened after interruption, including before or after initial identity persistence | Last projection whose publication commit point was durably reached | Before new-format identity is durable, a successful summary cannot be persisted or recognized; after identity is durable, the candidate is unpublished until its commit point; committed publication remains published | Reconstruct pending ordinary work from its durable identity; do not infer a real user request from synthetic compaction messages |
| 17 | Recent turn too large to preserve as a tail | Prior projection before commit; full summary after commit | Validly published without a tail | No tail-preservation requirement is added to scheduling |
| 18 | Existing model metadata `context: 0` | History follows the same publication and tail rules as other models | Publication state is unaffected | Preserve existing unknown-ceiling behavior; zero is not treated as zero usable input |

## Requirements *(mandatory)*

### Functional Requirements

#### Publication states and transitions

- **FR-001**: The system MUST make the observable state of a new compaction distinguishable as not yet published, successfully published, failed or abandoned, or legacy without explicit publication metadata. Before a successful summary can be persisted or recognized, the new-format/unpublished identity MUST already be durably established. Thus, at every crash boundary, a new candidate cannot be mistaken for a legacy completed pair. Tail-preservation metadata MUST NOT serve as the publication state.
- **FR-002**: A new compaction MUST be eligible for publication only after its paired summary is complete, has a successful finish state, has no failure, and all content required to read the summary is durably available.
- **FR-003**: Publication MUST have one durable, replayable linearization point identifying the exact compaction request and completed summary pair. Before that point all readers MUST use the prior valid projection; after it all readers MUST use the new complete projection. No reader may observe only part of the pair as authoritative.
- **FR-004**: Repeating the same publication request or replaying its persisted events MUST produce the same single effective published result. It MUST NOT publish a different pair, revert a published result, or create contradictory publication status.
- **FR-005**: A newer in-progress, complete-but-unpublished, failed, or abandoned compaction MUST NOT invalidate or supersede an older valid published compaction.
- **FR-006**: A failed, interrupted, cancelled, or partially persisted candidate MUST remain non-authoritative. Failure cleanup MUST NOT mark it published or delete the prior model-visible context.

#### Model-visible projection

- **FR-007**: Model-visible history MUST be derived from the newest applicable successfully published compaction and the existing compaction ordering/history-selection rules, not from the mere existence of a compaction user message or completed summary.
- **FR-008**: A published summary with a valid recent-tail marker MUST expose the summary and intended retained tail in the established order. A published summary with no tail marker MUST be valid as a full summary; it MUST NOT be treated as unpublished, failed, or malformed solely because the marker is absent.
- **FR-009**: An unpublished summary MUST NOT hide, remove, reorder away, or otherwise replace any portion of the prior valid model-visible projection.
- **FR-010**: Every session reader and existing compaction consumer that selects model history MUST agree on the same applicable published pair and tail. The feature MUST preserve prior-summary chaining and behavior for multiple successive publications.

#### Task scheduling and user-visible state

- **FR-011**: Model-visible projection, pending task scheduling, and user-visible current/completed response selection MUST be treated as separate consumer decisions. Hiding a compaction from model context MUST NOT indiscriminately hide it from pending-work scheduling.
- **FR-012**: A legitimate pending ordinary compaction MUST remain discoverable and executable while it is unpublished. Its synthetic request MUST NOT be mistaken for a new real user request or a completed assistant response.
- **FR-013**: A completed-but-unpublished preparation summary MUST NOT be treated as authoritative model context, an ordinary auto-compaction task, or the final response to an unrelated user request.
- **FR-014**: The publication contract MUST support a future operation that prepares a provisional summary while a failed generation is paused, publishes it only after the entire preparation succeeds, and leaves the prior projection intact if preparation fails. Durable synthetic-operation identity MUST distinguish ordinary compaction (`origin: "compaction"`) from reserved future recovery preparation (`origin: "recovery-preparation"`); the synthetic U message ID is the durable publication owner. Ordinary compaction scheduling MUST accept only ordinary queued compaction. Unknown/future synthetic origins MUST NOT be treated as normal user prompts, and a synthetic U without a part MUST NOT initiate generation. Future recovery preparation MUST use the same publication safety contract. It MUST NOT depend on `experimental.compaction.autocontinue`. This defines no recovery writer, generation fallback, or attempt state.

#### Legacy compatibility and durable history

- **FR-015**: A pair is legacy only when both its U has no explicit synthetic `origin` and its compaction part has no `publication` metadata. Such legacy pairs MUST retain historical publication recognition and finished-relative scheduling behavior; a successful legacy summary may be treated as published whether or not it has `tail_start_id`, while unfinished S without `finish` and S with `finish:"error"` retain their distinct scheduling outcomes. Either an explicit synthetic origin or publication metadata declares new-format identity. In particular, explicit synthetic U with missing publication metadata MUST NOT be treated as a valid completed legacy pair. New-format identity MUST be durably established before summary persistence or recognition so the legacy rule can never publish a new candidate accidentally.
- **FR-016**: A legacy incomplete, failed, or interrupted record MUST NOT be promoted to a published summary. It MUST retain existing ordinary-compaction continuation and pending-task behavior.
- **FR-017**: Where legacy data has no publication marker and therefore cannot reveal whether a historical complete pair had been explicitly committed, the compatibility policy MUST treat a valid complete pair as published to preserve established session behavior. The specification does not claim to reconstruct unavailable historical intent.
- **FR-018**: Publishing a compaction MUST change context selection without deleting or destructively rewriting original user messages, historical assistant responses, tool calls, completed tool results, prior summaries, or relevant provenance. Destructive cleanup or silent truncation MUST NOT be used to achieve publication.
- **FR-019**: Existing `context: 0` model metadata MUST continue to mean an unknown input ceiling, not zero usable input; this feature MUST NOT change context fitting or fallback selection.

#### Interruption and validation contract

- **FR-020**: After process restart, readers MUST reconstruct the last durably published projection and the correct independent pending-work state from persisted records and events. A crash before the publication linearization point MUST leave the prior valid projection authoritative. Restart MAY reconcile a complete-but-unpublished new-format pair only when durable evidence bound to that exact pair proves successful completion and readable content, its durable unpublished identity is present, and no failure or cancellation is recorded. If implemented, reconciliation MUST commit the same single durable publication decision used during live execution and MUST be idempotent; durable failure or cancellation prevents it. Completion alone, a success-looking message, or tail metadata is insufficient evidence. Do not regenerate a summary whose valid completion evidence exists solely because publication was interrupted. If required evidence is missing or contradictory, retain the prior projection and leave the candidate unpublished; do not guess intent or regenerate automatically. An explicit retry or new request remains governed by existing behavior.
- **FR-021**: Deterministic validation MUST cover interruption before request creation; before and after durable new-format identity establishment; after request creation; after request-part creation; during summary streaming; after summary completion but before publication; during publication; after publication; crash/reopen with a complete-but-unpublished pair including successful summary content; missing or contradictory evidence; and during failure or cancellation cleanup. These cases MUST prove that no incomplete pair is published or automatically resummarized. Tests of actual restart reconciliation and repeated reconciliation are required only if the optional reconciler is implemented. Validation MUST also prove idempotence for ordinary publication and event replay. The before-identity case MUST prove no successful summary can be persisted or recognized as legacy; the after-identity case MUST prove the candidate remains unpublished.
- **FR-022**: Validation MUST include negative controls that represent the current unsafe behavior or a controlled equivalent and show the corresponding acceptance assertion fail: using `tail_start_id` as publication status breaks a valid full summary; treating completion alone as publication hides prior context before commit; suppressing all incomplete compaction messages loses pending ordinary work; and treating separate message/part writes as an atomic pair permits partial-publication errors. Negative controls MUST leave the baseline source unchanged.
- **FR-023**: Validation MUST cover all 18 edge cases above, including both successful forms (with and without a recent tail), older publication surviving newer unpublished or failed work, repeated publication/replay, session reopen, and `context: 0`.
- **FR-024**: Ordinary compaction behavior and continuation MUST remain unchanged except where a change is strictly required to enforce the publication contract. Cross-context generation fallback, summarization changes, and unrelated recovery behavior MUST remain outside this feature.

### Existing Behavior and Dependencies

This specification is grounded in the following current source paths and symbols:

- `packages/opencode/src/session/message-v2.ts`: `filterCompacted` selects and orders model-visible history; `latest` selects current user, assistant, finished response, and pending tasks; `stream` supplies session messages.
- `packages/opencode/src/session/compaction.ts`: `completedCompactions` finds valid prior summaries; `processCompaction` prepares and completes ordinary compaction; `create` records ordinary pending work. Tail selection may produce no `tail_start_id` when no recent tail fits.
- `packages/opencode/src/session/session.ts`: `updateMessage`, `updatePart`, `removeMessage`, and `removePart` publish distinct session events.
- `packages/schema/src/v1/session.ts`: `CompactionPart` currently carries `auto`, optional `overflow`, and optional `tail_start_id`; `Event.MessageUpdated`, `Event.MessageRemoved`, and `Event.PartUpdated` describe independent message and part events.
- `packages/core/src/session/projector.ts`: projections for `SessionV1.Event.MessageUpdated`, `MessageRemoved`, and `PartUpdated` persist message and part changes independently.
- `packages/opencode/test/session/compaction.test.ts` and `packages/opencode/test/session/message-v2.test.ts`: existing compaction and projection coverage includes full summaries without a tail and task discovery for pending compaction work.

The specification does not require a particular field name, event type, storage layout, or multi-event transaction. It requires the observable single publication decision and consistent reader behavior described above.

### Scope

**In scope**:

- Explicit publication semantics for new completed compactions.
- Safe visibility of incomplete, failed, interrupted, completed-but-unpublished, and published compactions.
- Compatibility for legacy records and full summaries without a preserved tail.
- Separate model projection, ordinary task scheduling, and user-visible current response state.
- Event replay, independent persistence writes, and restart behavior.
- Preservation of source conversation history and existing ordinary compaction continuation.
- A publication contract suitable for future non-destructive context preparation.

**Out of scope**:

- Ordinary generation fallback or large-to-small context fitting, including 1M-to-256K prompt preparation.
- New, hierarchical, or multi-pass summarization algorithms.
- Changes to `SessionRecovery`, `SessionRetry`, `GenerationGate`, ordinary generation dispatch, provider retry, SSE timeout, or Splash calibration behavior.
- Changes to replay-safe tool execution, primary/fallback configuration, UI design, or broad event-persistence architecture.
- Rewriting or migrating legacy session records.
- Any change to feature 007's opt-in status or its incomplete T007/T008 promotion gates.

## Key Entities *(include if feature involves data)*

- **Compaction request**: The durable identity and intent for ordinary compaction or future provisional preparation, distinct from a real user request.
- **Summary pair**: A compaction request and its associated assistant summary, including completion state and content provenance.
- **Publication decision**: The durable decision that makes one complete summary pair authoritative for model-visible history.
- **Prior projection**: The last valid model-visible conversation before a candidate publication.
- **Retained tail**: Recent original conversation messages identified when preservation is possible; it may be absent for a valid full summary.
- **Pending compaction task**: Ordinary compaction work discoverable for execution independently of model-visible history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Deterministic acceptance coverage passes all 18 cases in the edge-case matrix and asserts model-visible history, publication status, and scheduling consequence for each; EC-10 proves successful-content complete-but-unpublished inactivity after reopen, with reconciliation-specific assertions conditional on implementing that optional capability.
- **SC-002**: For every pre-publication interruption point, 100% of session reads select the previous valid model-visible projection; after the commit point, 100% select the complete new pair.
- **SC-003**: Deterministic controls demonstrate that both a published summary with a tail and a published full summary without `tail_start_id` produce the intended history.
- **SC-004**: A newer unpublished or failed compaction leaves the prior published projection unchanged in every tested session-reader and compaction-consumer path.
- **SC-005**: An ordinary pending compaction remains discoverable and executable while excluded from model-visible history; a completed preparation summary does not become ordinary pending work or a user-facing final response.
- **SC-006**: Replaying publication events and repeating the same publication request produces one consistent result with no contradictory state or duplicate scheduled task.
- **SC-007**: Crash/reopen validation after each independent message and part persistence boundary reconstructs a valid projection without removing original messages, assistant responses, tool calls, completed tool results, summaries, or provenance.
- **SC-008**: Legacy valid summaries with and without tails, legacy failed/interrupted records, and multiple chained summaries retain their established observable behavior without user-triggered migration.
- **SC-009**: A negative control for each prohibited shortcut identified in FR-022 demonstrates failure of its targeted acceptance assertion, proving the validation can detect that regression.
- **SC-010**: `context: 0` remains an unknown ceiling and has no effect on publication status or the established behavior covered here.
- **SC-011**: Missing, contradictory, failed, or cancelled evidence never triggers publication or automatic resummarization; repeated ordinary publication and event replay preserve one effective result.

## Assumptions

- A new publication is considered successful only at its durable publication linearization point; summary completion alone is preparation, not publication.
- Existing legacy completed summary pairs were authoritative under the historical behavior. A legacy record lacking explicit metadata cannot reveal a different historical publication intent, so compatibility favors the established complete-pair interpretation.
- New-format identity is durable before successful summary persistence or recognition. Recovery evidence for publication is durable, pair-bound proof of successful completion and readable summary content; failure or cancellation evidence blocks reconciliation. Missing or contradictory evidence leaves the prior projection authoritative.
- Existing summary ordering and prior-summary chaining remain authoritative for which published compaction is current.
- Existing normal and automatic compaction remain the source of ordinary pending work and continuation semantics.
- The publication contract is a prerequisite for future asymmetric-context recovery preparation, but this feature does not implement that recovery lifecycle or generation fallback.
