# Feature Specification: Live Fallback Recovery

**Feature Branch**: `005-live-fallback-recovery`

**Created**: 2026-09-30

**Status**: Draft

**Input**: User description: Support selecting or changing a fallback model while an existing generation is recovering from a retryable primary-model failure, so the active generation can recover without a second prompt submission and without weakening safe global configuration updates.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Redirect an active retry to a newly selected fallback (Priority: P1)

As a user running a long or unattended task, I want a fallback I select during retry recovery to be considered by that same generation, so an unavailable primary does not continue to be retried only because no fallback was selected when the turn began.

**Why this priority**: This is the incident and the primary user value: recovery can proceed without a second prompt or a manual stop, even when the user cannot remain at the machine.

**Independent Test**: Begin a generation with no fallback, cause a retryable primary failure, select a valid fallback during retry backoff, and verify that the same generation dispatches the fallback at its next eligible recovery decision without resubmitting the prompt.

**Acceptance Scenarios**:

1. **Given** a generation started with fallback disabled and its primary has failed retryably, **When** the user selects an available fallback during backoff, **Then** the next recovery decision for that active generation observes the accepted selection and uses the existing recovery safety rules to dispatch it.
2. **Given** the fallback is selected while the generation is waiting between retries, **When** the next recovery decision occurs, **Then** the current generation continues without another user prompt and does not retry the dead primary merely because fallback was disabled when the assistant turn began.
3. **Given** a fallback selection is accepted for runtime recovery but saving the configured fallback later fails, **When** the active generation reaches its next recovery decision, **Then** runtime use and persistent configuration status remain distinguishable, and the user is told that the configured fallback was not saved.

### User Story 2 - Preserve configured fallback behavior and safe tool recovery (Priority: P1)

As a user, I want existing fallback-before-retry behavior and tool replay protections to remain intact, so adding live selection does not repeat work unsafely or regress fallback configured before a turn.

**Why this priority**: Fallback recovery is only useful if the existing safety distinctions continue to protect user work.

**Independent Test**: Exercise recovery with a fallback set before generation and with retryable failures at each tool-execution state; verify the existing restart, continue, and terminal outcomes.

**Acceptance Scenarios**:

1. **Given** fallback B is configured before generation and primary A fails retryably, **When** recovery is decided, **Then** the existing behavior selects B before another unnecessary retry of A.
2. **Given** a retryable failure occurs before any tool work has settled, **When** fallback recovery is selected, **Then** recovery restarts the work on the fallback.
3. **Given** tool work has settled before a retryable failure, **When** fallback recovery is selected, **Then** recovery continues after the settled tool work without replaying it.
4. **Given** a tool is executing and its outcome is unknown, **When** fallback recovery would require replaying that work, **Then** recovery remains terminal as it is today and does not replay the tool unsafely.

### User Story 3 - Change fallback intent while recovery is pending (Priority: P2)

As a user, I want edits made before fallback dispatch to take effect predictably, while edits after dispatch do not retarget a request already accepted for dispatch.

**Why this priority**: Users may revise their choice while a long retry backoff is underway; clear latest-choice behavior prevents stale or surprising recovery.

**Independent Test**: Select B during backoff, change it to C before the next eligible recovery decision, and verify C is used; then change the selection after fallback dispatch has been accepted and verify the dispatched attempt remains on its selected model.

**Acceptance Scenarios**:

1. **Given** fallback B is selected during recovery and then changed to C before the next recovery decision is dispatched, **When** that decision occurs, **Then** the latest accepted intent C is considered.
2. **Given** a fallback has been accepted for dispatch for the current turn, **When** the user later changes or clears the configured fallback, **Then** the already-dispatched fallback attempt is not silently retargeted.
3. **Given** the user clears fallback during recovery before fallback dispatch, **When** the next recovery decision occurs, **Then** it behaves as having no fallback and follows the existing retry and terminal rules.

### User Story 4 - Keep configuration updates safe during active work (Priority: P1)

As a user, I want a live fallback selection to become visible to active recovery without allowing destructive global configuration changes to interrupt active work.

**Why this priority**: The runtime incident must be fixed without undoing the existing guarantee that global configuration cannot dispose or rebuild shared state underneath active generations.

**Independent Test**: While a generation remains active and observes a newly selected fallback, verify that destructive global configuration application waits until the active generation releases admission, while the active generation can still observe runtime fallback intent.

**Acceptance Scenarios**:

1. **Given** an active generation holds admission and the user selects fallback B, **When** the selection is accepted, **Then** active recovery can observe B without waiting for that generation to release admission.
2. **Given** the same generation remains active, **When** ordinary destructive global configuration application is requested, **Then** disposal or rebuilding of shared state does not occur underneath the generation.
3. **Given** fallback B is selected and its normal persistence succeeds, **When** a later generation starts, **Then** B is the configured fallback for that work.

## Edge Cases

- A selected fallback cannot be resolved to a usable model: it is not dispatched, the failure is reported, and recovery returns to the existing primary retry or terminal policy for that failure, within existing attempt limits and without treating the fallback as successfully used.
- The selected fallback model resolves but its selected variant is unavailable: the unavailable variant is not dispatched, the failure is reported, and recovery returns to the existing primary retry or terminal policy for that failure, within existing attempt limits.
- The primary recovers before the fallback is dispatched: a request already in progress is not preempted; at the next failed-attempt recovery decision, the latest accepted intent and existing fallback preference rules apply. A successful primary attempt ends the need for failover for that attempt.
- The active generation is aborted while runtime fallback intent is pending: the intent does not cause another dispatch after abort, while any completed persistent configuration outcome remains independently accurate.
- The process shuts down while runtime intent or persistence is pending: no pending intent is reported as persistently saved unless persistence has succeeded; restart behavior uses the last successfully saved configuration.
- Multiple active generations can observe a global fallback selection at their next eligible recovery decision. Each generation retains its own turn state, retry limits, already-used fallback state, and tool-safety outcome; one generation's dispatch does not imply another's dispatch.
- Fallback A is already used for the current turn, equals the primary model, or is unavailable: existing `already_used`, `same_model`, and `model_unavailable` protections remain effective. Variant availability remains separately protected.
- Changes made after a fallback attempt has been accepted for dispatch do not change the target of that accepted attempt; later recovery decisions may observe later accepted intent.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST make fallback intent selected during retry recovery available to the active generation at the next recovery decision after a provider attempt fails and before choosing between another primary retry and fallback recovery.
- **FR-002**: The system MUST preserve the behavior of fallback configured before generation begins, including preferring an eligible fallback over an unnecessary retry of a retryable primary failure.
- **FR-003**: When a fallback is selected during a retry backoff, the next eligible recovery decision MUST consider that selection without requiring a second prompt submission, manual generation stop, server restart, or exhaustion of primary retries.
- **FR-004**: Before a fallback dispatch is accepted for the current turn, each not-yet-dispatched recovery decision MUST use the latest accepted runtime fallback intent, including a changed or cleared selection.
- **FR-005**: After a fallback dispatch is accepted for the current turn, ordinary later fallback edits MUST NOT silently retarget that already-dispatched attempt.
- **FR-006**: The system MUST preserve the current recovery safety outcomes: replay-safe work restarts on fallback; work after settled tool results continues without replaying settled tool work; and work with an executing tool of unknown outcome remains terminal when replay would be unsafe.
- **FR-007**: A runtime fallback selection MUST be distinguishable from persistent global fallback configuration. Active recovery MUST be able to observe accepted runtime intent without waiting for active generation admission to be released.
- **FR-008**: Ordinary destructive global configuration application MUST continue to wait for active generation admission to be released before disposing or rebuilding shared state.
- **FR-009**: When persistence of a selected fallback succeeds, the selected fallback MUST remain configured for future work. When persistence fails, the system MUST NOT report persistent success and MUST communicate that failure separately from any runtime use by the active generation.
- **FR-010**: A fallback model or variant that cannot be resolved or is unavailable MUST NOT be dispatched as if valid; the user-visible outcome MUST identify the unavailable fallback, and recovery MUST return to the existing primary retry or terminal policy for that failure within existing attempt limits, without counting the unavailable fallback as used.
- **FR-011**: If the primary succeeds before a fallback attempt is dispatched, the system MUST allow that successful attempt to complete without preemption; an accepted fallback selection MUST apply only at a later eligible recovery decision.
- **FR-012**: Aborting a generation MUST prevent pending runtime fallback intent from causing a later dispatch for that generation.
- **FR-013**: Pending runtime intent or an incomplete persistence operation MUST NOT be represented after process shutdown as a successfully persisted setting; subsequent work MUST use the last successfully persisted configuration.
- **FR-014**: When multiple active generations can observe a global fallback selection, each generation MUST independently apply current same-model, already-used, availability, variant, retry-limit, and tool-safety protections.
- **FR-015**: The feature MUST preserve GenerationGate reservation, grant, transfer, and release ownership; writer fairness; process-wide gate identity; atomic configuration persistence; forward-only instance cleanup; operation-local prompt scope lifetime; retryability classification; and existing recovery and telemetry behavior.

### Key Entities *(include if feature involves data)*

- **Persistent fallback configuration**: The successfully saved fallback choice used as the default for future work.
- **Runtime fallback intent**: The latest accepted fallback choice, change, or clear operation that may be observed by eligible active recovery before dispatch.
- **Active generation**: A running assistant turn with its own primary model, retry state, fallback-use state, and tool-execution safety state.
- **Fallback attempt**: A fallback model dispatch accepted for the current turn, whose target is fixed for that dispatch even if later intent changes.
- **Recovery decision**: The decision made after a provider attempt fails and before retrying the primary, dispatching an eligible fallback, continuing safely after settled tool work, or terminating.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of validation runs where a valid fallback is selected during retry backoff before the next recovery decision, that decision observes the latest accepted selection without a second user prompt.
- **SC-002**: In 100% of scenarios with an eligible fallback already configured before generation, retryable primary failure follows existing fallback-first behavior.
- **SC-003**: In 100% of recovery scenarios, replay-safe work, settled tool work, and executing-tool-unknown work retain their respective restart, continue, and terminal outcomes.
- **SC-004**: In 100% of scenarios where ordinary destructive global configuration is requested during an active generation, shared-state disposal or rebuilding waits until active admission is released.
- **SC-005**: In 100% of persistence-failure scenarios, runtime fallback use is distinguishable from persistent success, and future work does not treat the failed save as durable.
- **SC-006**: In 100% of scenarios involving an unavailable fallback, abort, shutdown, or multiple active generations, no invalid or post-abort dispatch occurs and each generation follows its own safety and retry limits.

## Assumptions

- The described retryable connection failure classification and existing recovery decisions are correct and remain unchanged; this feature addresses when fallback intent becomes visible to active recovery.
- Runtime fallback intent is relevant only to recovery decisions that have not yet dispatched a fallback. It does not preempt a provider request already in progress.
- A successful fallback persistence operation remains the source of configured fallback behavior for future work.
- The fallback choice is global in scope as described; when multiple active generations exist, each may independently consider it at an eligible recovery decision.
- The eventual design will select the smallest safe mechanism for communicating runtime intent. This specification does not prescribe a mutable reference, endpoint, event mechanism, configuration exception, or other implementation form.
- This feature does not redesign the completed GenerationGate or global configuration safety behavior.
