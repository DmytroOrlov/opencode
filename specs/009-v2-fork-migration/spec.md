# Feature Specification: OpenCode Fork Migration to V2

**Feature Branch**: Not created (per request)

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: Preserve the fork's required behavior while migrating from the removed V1 runtime layout to upstream OpenCode V2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start with a verified TLS CA policy (Priority: P1)

An operator starts OpenCode through its supported V2 CLI or server entrypoint and can rely on the selected certificate trust policy being active, verified, and reported to the user.

**Why this priority**: An unverified or silently weakened CA policy can make every outbound TLS connection unsafe or unusable. Startup and its child processes must agree on the policy before network work begins.

**Independent Test**: Start the V2 CLI and server in isolated processes against controlled certificates. Exercise the default and explicit policy modes, a child process, health reporting, and the titlebar indicator.

**Acceptance Scenarios**:

1. **Given** no CA mode is specified, **When** the supported V2 startup completes, **Then** the bundled CA policy is verified, certificate verification remains enabled, and health and the titlebar report `bundled`.
2. **Given** the operator selects system CA mode, **When** startup completes, **Then** the system CA policy is verified, certificate verification remains enabled, and health and the titlebar report `system`.
3. **Given** an explicitly supplied CA mode has a missing, unknown, conflicting, or unverifiable value, or certificate verification is disabled, **When** startup is requested, **Then** the CLI or server fails before accepting work or making an outbound request.
4. **Given** a supported startup launches a child process, **When** that process performs TLS work, **Then** it uses the same verified policy and does not inherit conflicting trust overrides.
5. **Given** a connected server does not report a verified mode, **When** the titlebar renders its CA status, **Then** it identifies the mode as unknown and does not imply that verification succeeded.

### User Story 2 - Recover safely from provider failures (Priority: P1)

An OpenCode user can continue eligible generation after a provider failure or a fallback selection while work is recovering, without repeating uncertain tool effects, ignoring cancellation, or racing destructive configuration changes.

**Why this priority**: Recovery must preserve user intent and external side effects across long-running generation, queued work, and configuration updates.

**Independent Test**: Use deterministic provider and tool outcomes to exercise retryable failure, fallback changes during backoff, each tool execution state, cancellation while admission is pending or held, and configuration updates from separate runtime graphs.

**Acceptance Scenarios**:

1. **Given** a retryable primary failure and an eligible configured fallback, **When** recovery is decided, **Then** the existing fallback behavior is preserved within the configured retry limits.
2. **Given** a newer valid fallback is accepted during retry backoff, **When** the next recovery decision occurs, **Then** it selects that fallback before another primary dispatch and does not require a new prompt; a fallback change after dispatch does not retarget that in-flight attempt.
3. **Given** work is replay-safe, has a settled tool result, or has an executing tool with an unknown outcome, **When** recovery changes models, **Then** replay-safe work may restart, settled tool work continues without repeating the tool, and unknown outcomes are not replayed.
4. **Given** a user explicitly cancels generation, **When** cancellation races with a provider failure or retry delay, **Then** cancellation remains terminal for that operation and no retry or fallback dispatch follows.
5. **Given** an accepted asynchronous prompt is waiting for shared generation admission, **When** its HTTP request ends or the user cancels it, **Then** accepted work is not cancelled merely by request-scope closure, while explicit cancellation can stop parked work and release its admission exactly once.
6. **Given** generation in one runtime graph and a global configuration update in another, **When** the update would replace shared runtime state, **Then** the update waits for the active admission to release and commits without exposing partial configuration.
7. **Given** runtime fallback intent is newer than persisted configuration and its save fails, **When** active recovery or later work reads configuration, **Then** active recovery can observe the accepted intent, the save failure is reported as a persistence failure, and a later process uses only the last successfully persisted value.

### User Story 3 - Keep only published compaction summaries authoritative (Priority: P1)

An OpenCode user can continue a session after compaction, interruption, deletion, restart, replay, or fork without losing pending work or exposing a partial summary as model-visible history.

**Why this priority**: Compaction changes which conversation history the model sees. A plausible-looking summary is insufficient if it was never durably published or if it hides pending work.

**Independent Test**: Create a session with established history and pending work, interrupt compaction at each durable boundary, then compare model-visible history, pending work, and current response after replay, restart, deletion, and fork.

**Acceptance Scenarios**:

1. **Given** compaction is preparing, incomplete, failed, cancelled, or complete but unpublished, **When** session history is read, **Then** the previous valid model-visible history remains authoritative.
2. **Given** a complete summary with readable content is explicitly published, **When** session history is read, **Then** the complete summary pair and its valid retained tail are selected together; a full summary without a retained tail is also valid.
3. **Given** a pending compaction is excluded from model-visible history, **When** pending work is listed or scheduled, **Then** that work remains discoverable without becoming an ordinary user request or unrelated final response.
4. **Given** a published summary is deleted or a publication event is rejected, **When** ordinary updates, replay, restart, or fork occur, **Then** the deleted or rejected summary cannot become authoritative again and the rejected mutation leaves the event and projected state consistent.
5. **Given** a session with valid legacy summaries, **When** it is read without user-triggered migration, **Then** its established behavior is preserved for full summaries, tailed summaries, chained summaries, and failed or unfinished summaries.
6. **Given** a session is forked at a selected history boundary, **When** the fork reads compaction history, **Then** any published pair refers only to the fork's own records and incomplete pairs are not promoted.

### User Story 4 - Keep healthy streams live and silent reads bounded (Priority: P2)

An OpenCode user can run a long generation whose event stream continues making progress without being terminated by total elapsed time, while an actually silent read still expires according to the configured policy.

**Why this priority**: Long generations may be healthy even when their total duration exceeds an idle timeout. A stalled connection must still reach existing recovery promptly.

**Independent Test**: Use a deterministic event stream and clock to exercise a healthy stream longer than the timeout, a silent read, explicit timeout settings, local Splash adaptation, retryable timeout classification, and user cancellation.

**Acceptance Scenarios**:

1. **Given** a healthy stream keeps delivering data within its applicable per-read deadline, **When** its total duration exceeds that deadline, **Then** the generation continues.
2. **Given** an individual stream read remains silent past its applicable deadline, **When** the deadline expires, **Then** the timeout reaches existing retry or fallback recovery as a retryable transport failure.
3. **Given** an explicit numeric timeout or a disabled timeout is configured, **When** a read is made, **Then** that explicit setting takes precedence over adaptation.
4. **Given** local Splash adaptation is explicitly enabled and five qualifying waits have been observed, **When** the next read begins, **Then** its deadline is ten times the largest of the four waits remaining after excluding the longest, bounded by 30 seconds and the existing provider timeout; the pending read's deadline does not change.
5. **Given** the user cancels while a read is pending, **When** cancellation is received, **Then** it remains terminal user cancellation rather than a retryable provider failure.

### User Story 5 - See truthful telemetry for the current generation attempt (Priority: P2)

An OpenCode user can see live generation telemetry in the V2 session experience, with the value's source and attribution kept accurate across retries, fallback, concurrency, and cancellation.

**Why this priority**: Telemetry helps users understand generation progress only when it belongs to the request they are viewing and does not affect generation success.

**Independent Test**: Feed deterministic MLX, Splash, and generic provider streams through success, retry, fallback, concurrent request, malformed data, and cancellation cases; inspect the live session presentation and source attribution.

**Acceptance Scenarios**:

1. **Given** an attempt has usable provider-native measurements, **When** the session UI displays them, **Then** they are identified as provider-native and associated with that attempt.
2. **Given** native telemetry is absent or unusable, **When** generation continues, **Then** a valid estimated fallback may be shown as an estimate and unavailable values are not shown as zero.
3. **Given** the same assistant message is retried or another request runs concurrently, **When** late or reordered telemetry arrives, **Then** only the current owning attempt can update its presentation.
4. **Given** telemetry setup, parsing, publication, or cleanup fails, **When** inference is running, **Then** generation retains its normal success, failure, retry, and cancellation outcome.
5. **Given** Splash telemetry is not explicitly enabled, **When** a Splash model generates, **Then** native Splash collection remains disabled and the provider request is unchanged; existing MLX telemetry remains functional.

### User Story 6 - Select a compact primary and fallback model pair (Priority: P2)

An OpenCode user can select a primary and fallback model from compact composer controls and trust that their pair, variants, and newest accepted intent survive persistence and session changes.

**Why this priority**: Model selection directly affects which provider receives generation work, and stale rollback can make the interface disagree with the user's most recent choice.

**Independent Test**: Run the primary/fallback/variant action matrix in the V2 composer for an existing session, a new session draft, and the dedicated new-session flow, with delayed success and failure responses.

**Acceptance Scenarios**:

1. **Given** primary A and fallback B, **When** the user selects B as primary, **Then** the existing symmetric swap behavior is preserved and each supported variant remains with its model.
2. **Given** a fallback selection is accepted while an older save is pending, **When** that older save fails or returns late, **Then** it cannot overwrite the newer accepted fallback intent.
3. **Given** a model pair is selected in any supported session flow, **When** persistence settles, **Then** each flow presents the same effective pair and variant behavior.
4. **Given** the fallback status is shown in the composer, **When** the user changes locale, **Then** the fallback status text remains available for every supported locale.

### Edge Cases

- A CA mode flag is repeated with the same value, repeated with conflicting values, placed after the argument terminator, or combined with an environment setting that weakens certificate verification.
- A child process starts with hostile ambient TLS settings or a runtime that cannot prove the requested effective trust set.
- A fallback is changed, cleared, unavailable, or becomes invalid between retry scheduling and the recovery decision; multiple generations observe different accepted intents.
- A primary succeeds while fallback intent changes, or explicit cancellation races with a timeout or retry delay.
- A tool is unstarted, executing with unknown outcome, or settled when recovery is requested.
- Cancellation arrives while work is parked for admission, while a subagent is running, or after protected configuration work has crossed its commit point.
- A compaction summary is empty to the session reader, has terminal error without a separate error record, lacks a retained-tail marker, or is deleted while duplicate parts or stale events remain.
- A crash occurs before or after summary completion, publication, deletion, or fork reference remapping; event replay presents stale or contradictory publication evidence.
- A stream has buffered reads, long healthy gaps, a stalled read, a timeout-disabled request, or a new retry/compaction request after prior Splash calibration.
- Telemetry is aggregate, malformed, zero, late, duplicated, from a discarded attempt, or concurrently reported by more than one provider source.
- An older model-selection failure arrives after newer fallback intent, or the selected fallback is not in the ordinary visible model catalog.

## Requirements *(mandatory)*

### Functional Requirements

#### TLS CA security and startup

- **FR-001**: The supported V2 CLI and server startup MUST provide the established `bundled` default and explicit `system` and `bundled` CA modes.
- **FR-002**: Startup MUST verify that the effective CA policy matches the selected mode before performing outbound TLS work or accepting server requests; inability to verify MUST fail closed.
- **FR-003**: A missing value for an explicitly supplied mode, an unknown value, or conflicting mode values MUST fail startup. Certificate verification MUST remain enabled in every accepted mode.
- **FR-004**: Child processes started by a supported entrypoint MUST use the same selected and verified CA policy, and conflicting ambient TLS settings MUST NOT silently change that policy.
- **FR-005**: The current V2 server health/status contract MUST expose the verified CA mode. A client that cannot obtain a verified mode MUST report `unknown`, not infer one from the endpoint or process name.
- **FR-006**: The V2 titlebar MUST display a user-visible CA mode indicator for `bundled`, `system`, or `unknown`, with accessible text that explains whether the mode was verified.

#### Safe generation recovery and fallback

- **FR-007**: The system MUST preserve configured primary/fallback behavior and existing retry limits when a provider failure is eligible for retry or failover.
- **FR-008**: Scheduling a retry MUST remain distinct from deciding to retry or fail over. After any backoff, the recovery decision MUST use the latest accepted fallback intent before dispatching another primary attempt.
- **FR-009**: A valid fallback accepted during backoff MUST prevent an unnecessary next primary dispatch. A fallback change after an attempt has been dispatched MUST NOT retarget that attempt.
- **FR-010**: Recovery MUST distinguish replay-safe work, settled tool work, and executing tool work with an unknown outcome. It MUST NOT repeat settled tool effects or replay work whose outcome is unknown.
- **FR-011**: Explicit user cancellation MUST remain distinct from retryable provider failure and MUST prevent later retry or fallback dispatch for that operation.
- **FR-012**: Runtime fallback intent MUST remain distinct from durably committed configuration. Active recovery MUST be able to observe accepted runtime intent before persistence completes; failed persistence MUST NOT be represented as durable success, and a later process MUST use the last committed configuration.
- **FR-013**: Shared generation admission MUST coordinate generation and destructive global configuration updates across distinct runtime graphs. Updates MUST preserve their atomic commit boundary and MUST NOT dispose or rebuild shared state while protected generation is active.
- **FR-014**: Accepted asynchronous work MUST outlive its HTTP request scope. Work parked before admission MUST remain interruptible; cancellation of a parked or active agent/subagent operation MUST terminate it and release its admission lease exactly once. Protected configuration work already past its commit point MUST finish or clean up forward without being abandoned in a partial state.
- **FR-015**: Concurrent generations MUST independently apply fallback validity, same-model, already-used-model, retry-limit, variant, and tool-safety rules.

#### Crash-safe compaction

- **FR-016**: Every new compaction candidate MUST be distinguishable as preparing/incomplete, published, failed or abandoned, or legacy. New-format unpublished identity MUST be durably established before successful summary content can be recognized.
- **FR-017**: A candidate MUST be publishable only after its exact paired summary has completed successfully and all content needed by the session reader is durably available and nonempty under reader-equivalent validation.
- **FR-018**: Publication MUST be one durable, replayable, idempotent decision for the exact request/summary pair. Repeating publication or replay MUST NOT publish a different pair, revert the decision, or create contradictory status. Before publication, the prior valid model-visible projection remains authoritative; after publication, readers select the complete pair.
- **FR-019**: A valid full summary without a retained-tail marker MUST remain publishable. An unpublished, failed, interrupted, cancelled, or incomplete candidate MUST NOT hide or replace the prior projection.
- **FR-020**: Model-visible history, pending work, and current/completed response selection MUST remain separate decisions. Excluding a candidate from model input MUST NOT hide legitimate pending work or make it an unrelated final response.
- **FR-021**: Legacy identification MUST remain strict: a record is legacy only when both explicit new-format identity and publication metadata are absent. Valid legacy summaries with or without a tail MUST retain established behavior; unfinished and terminal-error legacy summaries MUST retain their distinct prior outcomes; malformed new-format records MUST NOT fall back to legacy publication.
- **FR-022**: Event and projector validation for publication MUST be transactional. A rejected mutation MUST leave the durable event history, projected state, and aggregate ordering consistent, with no partial publication.
- **FR-023**: Explicit deletion or cancellation MUST prevent the same summary or pending operation from becoming authoritative again through ordinary updates, replay, restart, reused message or part identifiers, additional parts for the same owner, or retyping.
- **FR-024**: After restart or replay, readers MUST reconstruct the last published projection and independent pending-work state. A complete but unpublished candidate MAY be reconciled only when durable evidence bound to that exact pair proves successful completion and readable content with no failure or cancellation; otherwise it remains unpublished and MUST NOT be regenerated automatically.
- **FR-025**: A session fork MUST remap all references in a published compaction pair to records owned by the fork. Partial or unmappable pairs MUST NOT be upgraded to authoritative summaries.
- **FR-026**: Publication MUST preserve original messages, assistant responses, tool calls, tool results, prior summaries, and relevant provenance. Existing unknown-context semantics, including `context: 0`, MUST remain unchanged.

#### Transport liveness

- **FR-027**: Provider SSE liveness MUST be measured per pending read. A healthy generation MUST NOT fail solely because its total elapsed duration exceeds a read-idle timeout.
- **FR-028**: Existing generic and provider-specific read-timeout defaults MUST remain in force, including the established 300,000 ms generic and 150,000 ms `opencode-go` defaults where applicable.
- **FR-029**: Explicit numeric timeout values MUST take precedence over adaptation, and an explicit disabled timeout MUST continue to disable the read timeout.
- **FR-030**: Splash adaptive read timeouts MUST remain opt-in and limited to an explicitly designated local Splash provider using its effective HTTP(S) loopback endpoint; locality MUST NOT be inferred from provider ID, host, or port alone. A meaningful wait is a successful nonempty read that waited at least 100 ms. For five meaningful waits in one request, the threshold MUST exclude the longest wait, multiply the maximum of the remaining four by ten, and clamp the result between 30 seconds and the existing provider timeout.
- **FR-031**: Adaptation MUST be request-local, begin with fresh calibration for each new SSE request including retries and compaction requests, and affect only reads that begin after the threshold is calculated.
- **FR-032**: An idle-read timeout MUST enter the established retryable transport-failure recovery path. Explicit user cancellation MUST remain terminal cancellation, and the SSE wrapper MUST NOT create a separate retry policy.
- **FR-033**: Splash adaptation MUST NOT be silently enabled by default. Any later default change remains gated on deterministic calibration, near-context-ceiling, and post-compaction validation; a successful local smoke alone is insufficient, and live GPU inference MUST NOT be required for this migration's deterministic acceptance.

#### Attempt-scoped generation telemetry

- **FR-034**: Telemetry MUST belong to one concrete generation attempt, not only to a session or assistant-message identifier. A retry or fallback MUST reset or replace prior attempt state, and stale events MUST NOT update the current attempt.
- **FR-035**: MLX telemetry behavior MUST remain compatible. Splash-native telemetry MUST remain explicitly opt-in and MUST observe the selected generation request without adding an inference request, changing its inference options, or forcing a different runtime path.
- **FR-036**: Provider-native measurements and OpenCode-estimated measurements MUST retain distinguishable provenance and measurement meaning. A native value may replace an estimate only when it is valid, authoritative for that metric, and attributable to the current attempt.
- **FR-037**: Missing, malformed, non-finite, semantically incompatible, or aggregate-only values MUST be omitted rather than represented as zero or attributed to a request. Prefill progress alone MUST NOT be treated as decode-rate authority.
- **FR-038**: Concurrent attempts, retries that reuse an assistant-message identity, fallback, cancellation, and out-of-order terminal events MUST NOT misattribute measurements. When more than one native source could report for one attempt, sources MUST NOT race or be combined without an explicit authoritative rule.
- **FR-039**: Telemetry setup, collection, publication, or cleanup MUST NOT fail or materially delay generation. Provider watchers, listeners, timers, and attempt state MUST have bounded lifetimes and be released on completion, failure, interruption, or abort.
- **FR-040**: Live telemetry MUST be visible through the V2 session UI using one consistent presentation contract for provider-native and estimated values; provider-specific parallel stores or UI paths MUST NOT be required.

#### Composer model selection

- **FR-041**: The V2 composer MUST retain compact model controls and support selection of a primary/fallback pair using V2 state ownership and persistence behavior.
- **FR-042**: Selecting the current fallback as primary MUST preserve symmetric swap behavior. Supported variants MUST remain attached to their models, unsupported carried variants MUST be cleared, and a null fallback variant MUST retain provider-default meaning.
- **FR-043**: Pair-selection behavior MUST remain consistent for existing sessions, new-session drafts, and the dedicated new-session flow. A configured fallback MUST remain selectable wherever the existing composer exposes it, even if absent from the ordinary visible catalog.
- **FR-044**: Failure or stale client rollback from an older persistence operation MUST NOT overwrite newer accepted fallback intent or unrelated current composer state.
- **FR-045**: The fallback status translation key MUST be present in every supported locale and MUST remain consistent with the selected fallback state.

#### Scope and compatibility

- **FR-046**: Upstream V2 behavior MUST remain intact except where a specific deviation is required by this specification. Existing V2 capabilities that already satisfy a requirement MUST be reusable without adding duplicate ownership, storage, retry, event, or UI mechanisms.
- **FR-047**: Required parity is behavioral; implementation MUST NOT depend on restoring the removed V1 package, obsolete entrypoints, old SDK-generated files, or a line-by-line port of the prior implementation.
- **FR-048**: The migration MUST distinguish upstream behavior reused unchanged, changed behavior requiring a V2 contract, and explicitly unsupported inherited behavior. Optional cleanup or unrelated redesign MUST NOT be required for acceptance.
- **FR-049**: If an upstream V2 semantic prevents a required behavior from being preserved, the affected migration area MUST be placed on HOLD for an explicit contract decision. A stub, reduced functionality, disabled regression test, or dead legacy code MUST NOT count as acceptance.
- **FR-050**: Required acceptance coverage MUST use deterministic, focused tests. Relevant regression suites and affected-package typechecks MUST be capable of passing; unrelated upstream baseline failures MUST be recorded separately and MUST NOT be attributed to the migration.

The migration scope is classified as follows:

- **Required functional parity**: The six user stories and their acceptance scenarios define the behavior that must remain correct.
- **Reusable upstream V2 behavior**: The supported CLI/server lifecycle, current server health and public contracts, Session execution and projection behavior, provider streaming, V2 app state ownership, and session UI are the baseline. Existing behavior that already passes the relevant acceptance scenario remains reusable.
- **Changed behavior requiring a V2 contract**: Verified CA mode reporting and its titlebar indicator; recovery decisions that observe current fallback intent while preserving tool and cancellation safety; explicit compaction publication and independent pending-work visibility; attempt-owned telemetry in the V2 session experience; and persisted primary/fallback selection in the V2 composer.
- **Explicitly unsupported behavior**: Replaying tool work with an unknown outcome, enabling Splash adaptation by default before its validation gate, requiring a live GPU for deterministic acceptance, or treating unknown CA mode as verified.
- **Optional cleanup**: Broad refactoring, visual changes beyond compact model controls and the required CA indicator, and unrelated V2 redesign are not migration requirements.

### Key Entities *(include if feature involves data)*

- **Verified CA policy**: The selected bundled or system trust mode that was confirmed active before TLS work begins.
- **Generation admission**: Shared permission for generation and protected global configuration work to use or replace runtime state safely.
- **Fallback intent**: The latest accepted runtime fallback selection, distinct from the value last committed for future processes.
- **Tool outcome state**: Whether tool work is replay-safe, settled with a known result, or executing with an unknown outcome.
- **Compaction candidate**: A request and summary pair that may be preparing, published, failed, abandoned, or legacy.
- **Publication decision**: The durable fact that makes one complete compaction pair authoritative for model-visible history.
- **Generation attempt**: One concrete provider generation whose telemetry has independent ownership and lifecycle.
- **Telemetry measurement**: A native or estimated value with a source, semantic interval, and attribution to an attempt.
- **Model pair**: The selected primary model and optional fallback model, each with its associated variant state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All four original feature areas—TLS CA policy, integrated generation recovery/liveness/compaction, attempt-scoped telemetry, and compact composer selection—pass their V2 acceptance scenarios without relying on deleted V1 runtime paths.
- **SC-002**: In every deterministic TLS mode scenario, the running process and its tested child process either use the selected verified CA policy or fail before network work; the health response and titlebar never claim an unverified mode.
- **SC-003**: In every tested recovery decision where a valid fallback is accepted during backoff, no later primary retry is dispatched first; settled tool effects are not repeated and unknown tool outcomes are not replayed.
- **SC-004**: Every reproduced parked-agent/subagent cancellation scenario terminates within its configured test bound, releases admission exactly once, and permits the next queued protected operation to proceed.
- **SC-005**: At every tested pre-publication crash or interruption boundary, reads select the prior valid projection; after publication they select the complete pair; pending work is asserted independently and remains discoverable; and zero deleted or incomplete pairs become authoritative after replay, restart, or fork. A plausible final conversation alone does not pass this criterion.
- **SC-006**: A healthy SSE stream that continues making progress beyond the configured read timeout completes, while every silent read expires within its applicable configured bound and follows existing retry/cancellation classification.
- **SC-007**: In all retry, fallback, concurrent, malformed-data, and cancellation telemetry scenarios, zero measurements are attributed to the wrong attempt and zero telemetry failures alter inference success or failure.
- **SC-008**: The primary/fallback model and variant action matrix produces the same effective selection across all supported composer flows, and zero late older failures overwrite newer accepted fallback intent.
- **SC-009**: Deterministic migration acceptance does not require a live GPU service. Splash adaptive timeout remains opt-in until its separate near-context-ceiling and post-compaction validation gates are met.
- **SC-010**: Relevant regression suites and affected-package typechecks pass on the migration result, with any unrelated upstream baseline failures identified separately.

## Assumptions

- Upstream V2's supported CLI/server lifecycle, public contracts, session execution/projection model, provider streaming, app state ownership, and session UI are the migration baseline; planning will determine which already-satisfied behavior can be reused unchanged.
- The existing CA policy's default remains bundled, and system mode remains a supported explicit choice with certificate verification enabled.
- Existing retry limits, provider timeout precedence, legacy session behavior, and model-pair persistence semantics remain authoritative unless a requirement above explicitly changes them.
- Splash adaptive timeout is intentionally opt-in until deterministic full-context and post-compaction validation supports any future default change.
- A successful local Splash smoke does not replace the separate near-context-ceiling and post-compaction evidence required before any future default promotion.
- Original specifications 001–008 are historical behavioral references. They are not active feature directories and are not rewritten by this specification.
- Real-backend smoke testing may supplement deterministic coverage, but neither GPU access nor live model inference is required for specification acceptance.

## Out of Scope

- Restoring deleted V1 packages, entrypoints, runtime ownership, or generated SDK artifacts.
- A line-by-line port of original files or preservation of obsolete abstractions.
- Promoting Splash adaptive timeouts to the default without their separate validation gate.
- Replacing upstream V2 session execution, event replay, provider dispatch, or application state architecture where it already satisfies the required behavior.
- Broad cleanup, unrelated redesign, new provider families, or changes to unsupported real-backend validation limits.

