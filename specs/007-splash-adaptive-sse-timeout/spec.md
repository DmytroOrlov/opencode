# Feature Specification: Adaptive SSE Idle Timeout for Splash

**Feature Branch**: `[007-splash-adaptive-sse-timeout]`

**Created**: 2026-10-08

**Status**: Opt-in implementation complete; default promotion gates outstanding

**Input**: User description: "Specify a minimal adaptive SSE idle timeout for local Splash models. Keep a rolling window of the last 5 successful, meaningful reader.read() wait durations; exclude the single longest duration; take the maximum of the remaining 4; multiply by exactly 10; clamp to a minimum of 30 seconds and a maximum equal to the existing provider timeout. New thresholds apply only to future reads. Preserve conservative timeout before enough evidence, ignore buffered or near-zero reads, reset calibration on every SSE request including compaction, never impose a total generation timeout, preserve explicit numeric overrides and chunkTimeout: false, limit behavior to local Splash, preserve retry/fallback/cancellation/tool replay safety, use constant-size state, and require deterministic and full-context/post-compaction validation before enabling the new default."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete healthy local Splash generations (Priority: P1)

A user runs a local Splash model whose SSE output sometimes has pauses between chunks. The generation continues through pauses consistent with that stream's observed cadence instead of being cut off by an overly short fixed idle timeout.

**Why this priority**: Avoids false failures during healthy generations while keeping the behavior focused on local Splash.

**Independent Test**: A deterministic local SSE stream supplies a series of meaningful read waits, then pauses for less than its calculated timeout and resumes; the generation completes.

**Acceptance Scenarios**:

1. **Given** fewer than five meaningful successful read waits in an SSE request, **When** a read is pending, **Then** the existing conservative provider timeout remains in effect.
2. **Given** five meaningful successful waits, **When** the adaptive threshold is calculated, **Then** the longest wait is excluded, the maximum of the other four is multiplied by exactly 10, and the result is bounded below by 30 seconds and above by the existing provider timeout.
3. **Given** a recalculated threshold while a read is already pending, **When** that read completes, **Then** its original deadline remains unchanged and only later reads use the recalculated threshold.

### User Story 2 - Stop genuinely stalled streams (Priority: P1)

A user runs a local Splash model whose SSE stream stops making progress. The request still ends under the existing provider timeout bound and follows the established failure, retry, or fallback behavior.

**Why this priority**: Adaptation must not turn a stream stall into an unbounded wait or alter established recovery behavior.

**Independent Test**: A deterministic stream establishes calibration and then stalls; verify the pending read expires at its applicable idle threshold and existing recovery semantics remain intact.

**Acceptance Scenarios**:

1. **Given** an SSE read has no data before its applicable idle threshold, **When** the threshold expires, **Then** the read follows existing timeout and recovery behavior.
2. **Given** a legitimate gap shorter than the applicable adaptive threshold, **When** the stream resumes, **Then** the request continues successfully.
3. **Given** cancellation, retry, fallback, or tool replay occurs, **When** the request changes lifecycle state, **Then** the adaptive timeout does not prevent cancellation or change the established retry, fallback, or replay outcome.

### User Story 3 - Keep existing timeout controls and other providers stable (Priority: P1)

A user or caller configures explicit timeout behavior, or uses a provider other than a local Splash model. Those requests retain their existing timeout semantics.

**Why this priority**: The change is narrowly scoped and must remain compatible with existing controls and integrations.

**Independent Test**: Exercise explicit numeric overrides, disabled chunk timeout, and non-local-Splash requests; compare behavior with their existing configured semantics.

**Acceptance Scenarios**:

1. **Given** an explicit numeric timeout override, **When** an SSE read is made, **Then** the configured numeric timeout is used without adaptive replacement.
2. **Given** `chunkTimeout: false`, **When** an SSE read is made, **Then** no chunk idle timeout is imposed.
3. **Given** an SSE request for any provider other than a local Splash model, **When** chunks are read, **Then** that provider's existing timeout behavior is unchanged.
4. **Given** one SSE request has accumulated calibration, **When** a new SSE request starts, including a compaction request, **Then** it begins with fresh calibration state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Adaptive idle timeout behavior MUST apply only to SSE requests for local Splash models.
- **FR-001a**: Adaptive behavior MUST be disabled by default and enabled only by the explicit provider option `splashAdaptiveSseTimeout: true`. The option declares that the configured provider is local Splash; Splash MUST NOT be inferred from localhost, provider aliases, or port numbers alone.
- **FR-001b**: Adaptive behavior MUST additionally require an effective endpoint using HTTP or HTTPS and a loopback host (`localhost`, an IPv4 loopback address, or an IPv6 loopback address). The endpoint MUST be the same resolved endpoint used for provider dispatch.
- **FR-002**: Each SSE request MUST begin with empty calibration state. Calibration MUST NOT carry across requests, retries that start a new request, or compaction requests.
- **FR-003**: Before five successful, meaningful read waits have been observed in the current request, the request MUST retain the existing conservative timeout behavior.
- **FR-004**: The calibration sample MUST be the rolling window of the most recent five successful `reader.read()` calls that return nonempty data after waiting at least 100 ms. EOF, empty data, and reads completing in less than 100 ms MUST NOT count as meaningful samples.
- **FR-005**: Once five samples exist, the adaptive threshold MUST be exactly ten times the maximum of the four durations remaining after excluding the single longest duration, bounded to at least 30 seconds and at most the existing provider timeout.
- **FR-006**: A newly calculated threshold MUST apply only to reads that begin after that calculation. It MUST NOT change or shorten the deadline of a read already pending.
- **FR-007**: The timeout MUST measure inactivity between stream reads only. It MUST NOT impose a total generation-duration limit; a healthy generation may continue indefinitely while it continues to make progress within applicable idle thresholds.
- **FR-008**: Explicit numeric timeout overrides MUST retain their current behavior, and `chunkTimeout: false` MUST continue to disable the chunk idle timeout.
- **FR-009**: Adaptive timeout failures MUST preserve existing retry, fallback, cancellation, and tool replay safety semantics.
- **FR-010**: Calibration MUST use constant-size state bounded to the five most recent meaningful wait durations, plus only the minimal state needed to calculate and apply the current threshold.
- **FR-010a**: Calibration MUST be request-local, including across retries and compaction; each new SSE request MUST start with no samples.
- **FR-010b**: The `splashAdaptiveSseTimeout` option MUST be removed from provider options passed to the SDK while remaining represented in the SDK cache key so enabled and disabled configurations do not share a cached SDK instance.
- **FR-010c**: Adaptive calibration MUST apply only when `chunkTimeout` is unspecified. Explicit numeric `chunkTimeout` values MUST retain fixed-timeout semantics, and `chunkTimeout: false` MUST continue to disable chunk timeouts.
- **FR-010d**: The existing `headerTimeout` and explicit request `timeout` MUST remain unchanged. No total-generation timeout may be introduced.
- **FR-010e**: Before five qualifying samples exist, reads MUST use the existing conservative default chunk timeout. Once five samples exist, the adaptive threshold MUST be recalculated from the last five, but MUST affect only subsequent reads.
- **FR-010f**: Diagnostics MUST remain lightweight and request-scoped, reporting enough calibration/sample and timeout outcome information to validate chosen thresholds without logging each chunk.
- **FR-011**: Before the adaptive behavior becomes the default, deterministic validation MUST cover calibration arithmetic, outlier exclusion, changing cadence, legitimate long gaps, stalled streams, and long healthy generations.
- **FR-012**: Before the adaptive behavior becomes the default, validation MUST exercise full request context and post-compaction requests, confirming request isolation and unchanged cancellation, retry, fallback, and tool replay safety.

### Key Entities

- **SSE request calibration**: Request-scoped record of up to five meaningful successful read-wait durations and the resulting idle threshold.
- **Read-wait duration**: Time spent waiting for a successful SSE read to produce data, excluding time for reads already satisfied from buffered data or completing near immediately.
- **Adaptive idle threshold**: Per-read inactivity allowance derived from the current request's calibration samples and bounded by the existing provider timeout.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any set of five meaningful waits, the resulting threshold matches ten times the maximum of the four non-longest samples, subject to the specified 30-second minimum and existing-provider-timeout maximum.
- **SC-002**: Deterministic tests demonstrate that no more than five qualifying wait durations are retained for calibration and that new requests, including retries and compaction, begin without prior samples.
- **SC-003**: Deterministic tests show that a pending read retains its original timeout when a new threshold is calculated and that subsequent reads use the updated threshold.
- **SC-004**: Deterministic validation passes cases for outliers, changing cadence, legitimate long gaps, stalled streams, and generations that exceed the maximum idle timeout in total duration while continuing to make progress.
- **SC-005**: Full-context and post-compaction validation confirms the behavior is limited to local Splash and preserves explicit timeout settings, cancellation, retry, fallback, and tool replay behavior before the default is enabled.

## Assumptions

- The existing provider timeout is the authoritative upper bound and conservative pre-calibration timeout for local Splash requests.
- Existing timeout precedence and error recovery behavior remain authoritative wherever this specification does not explicitly define adaptive local Splash behavior.
- A successful read is useful cadence evidence only when it returns nonempty data after at least 100 ms; EOF, empty results, and faster buffered reads are excluded.
- Default enablement is gated on separate deterministic full-context and post-compaction validation. Until both gates pass, the behavior remains opt-in.
- This specification defines the required behavior and validation gate; implementation design and work breakdown belong to later Spec Kit phases.
