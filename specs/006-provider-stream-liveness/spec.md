# Feature Specification: Provider Transport Liveness

**Feature Branch**: `006-provider-stream-liveness`

**Created**: 2026-10-07

**Status**: Draft

**Input**: Make existing provider transport liveness timely enough to detect silent connections and prove the resulting retryable failure reaches established session fallback recovery.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recover from a silent provider connection (Priority: P1)

As a user waiting for a response, I want a provider connection that stops delivering data to be detected within a useful bounded time, so the existing recovery policy can retry or use an eligible fallback.

**Why this priority**: A silent but locally established connection can otherwise hold a generation until the current 300-second transport timeout expires.

**Independent Test**: Hold an SSE response open after it begins, stop yielding body chunks, and verify that the existing retryable stream timeout reaches `SessionRecovery`; with an eligible fallback, verify that recovery dispatches it according to `005-live-fallback-recovery`.

**Acceptance Scenarios**:

1. **Given** a provider request receives no response headers, **When** its configured header-wait boundary expires, **Then** the existing header timeout produces the failure for normal retry/recovery handling.
2. **Given** an SSE response remains open but yields no next body chunk, **When** its configured idle-read boundary expires, **Then** the existing chunk timeout produces a retryable response-stream failure.
3. **Given** a retryable timeout failure occurs and an eligible fallback exists, **When** the failure reaches session recovery, **Then** the fallback is dispatched according to the existing recovery policy.
4. **Given** a healthy provider stream continues yielding data within the configured idle boundary, **When** the generation runs, **Then** it is not failed by this feature.
5. **Given** an explicit abort occurs before or during timeout handling, **When** the request is interrupted, **Then** the outcome remains abort and does not become automatic retry or fallback.
6. **Given** a failure reaches recovery after tool work or partial output, **When** recovery decides whether to restart, continue, or terminate, **Then** the safety behavior in `005-live-fallback-recovery` remains authoritative.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST use the existing provider response-header timeout for requests that do not receive response headers and the existing SSE chunk timeout for an established SSE response that stops yielding body chunks.
- **FR-002**: A silent provider connection MUST reach the existing retry/recovery decision in a bounded, materially shorter interval than the current 300-second default behavior. The plan MUST justify any selected defaults or provider-specific overrides using compatibility and risk evidence; exact values remain a planning decision.
- **FR-003**: Existing `headerTimeout` and `chunkTimeout` provider options MUST remain the configuration mechanism. This feature MUST NOT require new public configuration keys. Planning may determine whether defaults change globally, for appropriate remote providers, or through documented provider-specific overrides.
- **FR-004**: A chunk timeout MUST produce the existing retryable response-stream timeout failure, and eligible fallback selection MUST remain the responsibility of existing session recovery policy.
- **FR-005**: Healthy provider streams MUST NOT be failed spuriously by the selected timeout policy. Validation MUST cover ongoing healthy SSE data as well as a stream that remains open without yielding further chunks.
- **FR-006**: Explicit cancellation MUST remain distinguishable from timeout failure and MUST remain terminal cancellation rather than automatic retry or fallback.
- **FR-007**: Recovery behavior after a timeout MUST preserve the replay, settled-tool continuation, unknown executing-tool safety, bounded failover, live fallback intent, and cancellation contracts in `005-live-fallback-recovery`. This feature MUST NOT add a second retry, fallback, or recovery state machine.
- **FR-008**: Validation MUST prove end to end that an open but silent SSE body yields the existing retryable timeout failure and that, when eligible fallback exists, the failure reaches existing `SessionRecovery` and dispatches fallback according to `005-live-fallback-recovery`.
- **FR-009**: For each timed SSE request, the provider transport layer MUST expose at most one bounded terminal diagnostic summary sufficient to evaluate timeout safety in real workloads. Where available, it MUST include `responseHeaderWaitMs`, `firstReadWaitMs`, `maxSuccessfulReadWaitMs`, `successfulReadCount`, `chunkCount`, `sseStreamDurationMs`, `configuredChunkTimeout`, `terminalOutcome`, `timeoutReadWaitMs` on timeout, and a non-secret transport identifier such as the request host. The read-wait measurements MUST measure pending `reader.read()` duration, not total model-call duration.
- **FR-010**: The transport summary MUST be passive and request-scoped: no per-chunk or token-level logging, persistence requirement, new public configuration key, telemetry service or store, session/recovery state, or effect on retry, fallback, cancellation, or generated output. Logging failure MUST NOT fail generation. `chunkTimeout: false` MUST preserve the original unwrapped response path and need not produce a summary. Explicit request abort, consumer cancellation, timeout, normal completion, and other transport error MUST remain distinguishable where the underlying transport can distinguish them.
- **FR-011**: Keep generic `headerTimeout` and `chunkTimeout` at `300_000` ms and set the `opencode-go` provider-specific `chunkTimeout` default to `150_000` ms. Existing explicit numeric and `false` overrides MUST continue to take precedence.
- **FR-012**: This feature MUST NOT adapt timeout values at runtime or specify an adaptive algorithm. Passive measurements may inform a future bounded adaptive default only if production evidence shows healthy `firstReadWaitMs` or `maxSuccessfulReadWaitMs` materially grow with long sessions or context. Total model latency MUST NOT be used as a liveness signal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A response-header-silent request and an established SSE stream with no next body chunk each reach existing recovery within their configured bounded timeout; the selected timeout policy is materially shorter than the current 300-second default for the incident-relevant provider path.
- **SC-002**: In deterministic regression coverage, every open-but-silent SSE stream produces the existing retryable timeout failure, and an eligible fallback is dispatched through existing `SessionRecovery` according to `005-live-fallback-recovery`.
- **SC-003**: Healthy provider streams that continue delivering SSE data within the configured idle boundary are not failed by this feature.
- **SC-004**: Explicit abort remains abort, and timeout recovery preserves the existing replay-safe restart, settled-tool continuation, unknown executing-tool terminal behavior, and bounded fallback outcomes.
- **SC-005**: No second session-level liveness timer or independent recovery/failover state machine is introduced; timed SSE requests produce no more than one terminal transport summary, and diagnostic failure does not affect generation.
- **SC-006**: Transport summaries distinguish timeout, completion, abort, consumer cancellation, and other transport errors when the underlying transport exposes those outcomes, and include read-wait measurements rather than total model-call duration.

## Assumptions

- Existing provider transport timeout handling, retry classification, and `SessionRecovery` policy remain the authoritative mechanisms; this feature tunes the time to detect transport silence and verifies their integration.
- The incident-relevant path is the ordinary provider path using the existing provider fetch timeout infrastructure.
- Receipt of provider/SSE data is sufficient liveness evidence for this feature because the reproduced failure is transport silence. A provider that sends heartbeats indefinitely while model generation makes no semantic progress is out of scope unless separate evidence establishes that failure mode.
- Generic timeout defaults remain 300,000 ms; `opencode-go` defaults to a 150,000 ms SSE idle-read timeout while explicit numeric and `false` overrides remain supported.
- Healthy SSE idle-gap observations are not yet established by session-level progress observations. The bounded transport summary is included to gather the relevant evidence without changing generation behavior.

## Scope

This feature makes existing provider transport liveness timely, proves that timeout failures reach established recovery, and adds passive bounded diagnostics needed to evaluate the timeout policy against real transport idle gaps. Diagnostics exist only for the liveness policy; they are not UI telemetry or an adaptive-timeout implementation. It does not add normalized-event semantic classification, a session-level watchdog, a tool-execution timer suspension policy, new public timeout keys, a separate telemetry service or store, persistent metrics storage, or a second recovery state machine. The experimental native LLM runtime's transport liveness is out of scope and may be handled as a separate follow-up if it does not share this provider timeout facility. Existing fallback and tool/replay safety remain governed by `005-live-fallback-recovery`.

## Clarifications

### Session 2026-10-07

- Q: Should transport diagnostics remain out of scope, or should passive request-scoped observability be included to assess timeout safety? → A: Include bounded passive transport diagnostics as specified; they must not change generation behavior or create a separate telemetry/control subsystem.
- Q: What timeout defaults and adaptive-policy boundary apply to this feature? → A: Keep generic defaults at 300,000 ms, set `opencode-go` to 150,000 ms with explicit overrides preserved, and do not add adaptive timeout behavior.
