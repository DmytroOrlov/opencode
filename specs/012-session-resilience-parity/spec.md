# Feature Specification for Session Resilience Parity

**Feature Directory** `specs/012-session-resilience-parity`

**Created** 2026-11-22

**Status** Draft

**Input** Close three verified V1→V2 behavioral gaps in `feat(session): make long-running agent turns resilient to failures`.

## Clarifications

### Session 2026-11-22

- Q: When a request abort and downstream consumer cancellation both occur before an SSE stream’s terminal summary is recorded, which outcome should the summary report? → A: Request abort takes precedence if both signals are present before classification.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cross-host generation and configuration safety (P1, A1)

As an embedded SDK consumer, I can run a generation while another host updates the same global configuration resource. The generation remains protected and both hosts see consistent configuration and current fallback intent.

**Why this priority** — Competing hosts can otherwise replace configuration while an active generation depends on it.

**Independent Test** — Open two simultaneously live hosts through the public embedded SDK and production route roots, with separate application builds and the same global configuration directory. Use deterministic barriers at actual generation admission, valid PATCH entry and durable replacement.

**Acceptance Scenarios**

1. **Decisive negative.** Given host A's real generation holds shared admission, when host B enters a valid PATCH for the same global resource, then zero replacement renames occur and committed bytes remain unchanged while A holds admission. Releasing A allows B to commit once. Both hosts' subsequent protected reads see the committed configuration.
2. **Positive.** Given host A holds the actual shared generation lease for resource R, when host B accepts a newer eligible fallback intent for R while its PATCH waits for exclusive admission, then A's next eligible recovery decision can observe the staged intent before B's durable rename. An already dispatched physical attempt is unaffected. If B is cancelled before commit, its staged intent is retired and A no longer selects that abandoned value. A newer accepted intent wins over an older one, including across hosts B and C. No intent leaks to a host associated with a distinct resource.
3. **Isolation control.** Given two hosts targeting distinct global configuration directories, when A holds admission and B updates its resource, then B commits before A releases, and B's fallback intent does not affect A. Host-specific events, lifecycle, user state and configuration remain isolated under both same-resource and distinct-resource setups, subject to the shared global resource contract.
4. **Interrupted-host control.** Interrupt A while it holds admission and verify B progresses. In a separate case interrupt B while its writer is queued, verify zero replacements from that writer, and show a subsequent valid writer and generation can complete. Retain the existing post-replacement cancellation and coherent publication guarantees.

### User Story 2 - Observable SSE transport failures and calibration (P2, A2)

As an operator diagnosing a streamed inference request, I can tell how it ended, how long it waited and which read deadline applied.

**Why this priority** — The distinctions are necessary to diagnose stalls, user aborts and downstream cancellation.

**Independent Test** — Exercise the V2 HTTP transport with deterministic clocks and streams, recording summary attempts, outcomes and cleanup.

**Acceptance Scenarios**

1. **Positive.** End five separate streams through normal completion, a read timeout, explicit request abort, downstream consumer cancellation and another transport error. Each attempts exactly one terminal summary classified respectively as `completed`, `timeout`, `abort`, `consumer_cancel` and `other_error`. Verify that request abort and consumer cancellation remain distinct and that competing teardown signals cannot emit a second summary. If both signals are present before terminal classification, classify the outcome as `abort`.
2. **Decisive negative.** On otherwise healthy streams, make the diagnostic sink throw synchronously and reject asynchronously in separate runs. Each stream delivers its expected output and completes, cleanup finishes and exactly one summary attempt occurs. Verify sink failure also leaves abort and cancellation behavior intact.
3. **Calibration control.** After five qualifying samples select a calibrated threshold different from the configured default, stall the next read. The summary reports that read's actual deadline, basis and elapsed wait. Start a new stream and verify fresh calibration. Exercise opt-in, qualifying reads, outlier handling, the 10× multiplier and both clamp limits using the existing regression coverage and targeted additions where needed.

### User Story 3 - Safe failover independent of primary retryability (P3, A3)

As a user with an eligible distinct fallback, I can continue a safe turn when the primary model fails and its retry policy disallows another primary attempt.

**Why this priority** — A terminal primary failure need not end a turn that can safely continue through a different model.

**Independent Test** — Drive the production session runner with controlled provider responses and record physical requests, model and variant attribution, tool executions and terminal outcomes.

**Acceptance Scenarios**

1. **Decisive negative.** With a primary returning HTTP 401, no retry override and no output or tools executed, confirm the production classifier produces non-retryable Authentication. With a distinct eligible fallback available, observe exactly one primary request and one successful fallback request, with zero primary retries.
2. **Positive.** With a retryable primary failure and its ordinary same-model schedule exhausted, demonstrate that an eligible distinct fallback continues the turn, with zero primary requests beyond the existing budget.
3. With settled executed tools and safe continuation, the fallback sees the settled results and no tool is executed twice. With an unknown executing-tool outcome, verify zero fallback dispatches and zero unsafe replays.
4. For user cancellation, unsafe interruption or blocked work, verify zero fallback dispatches. For context overflow, verify the existing compaction path retains precedence and zero fallback requests occur for the overflow decision.
5. Before fallback dispatch, supersede the candidate with a newer eligible selection and verify dispatch uses that model and its variant. Reject the same model and models already attempted in the turn. Verify an absent or ineligible fallback leaves the ordinary terminal error or retry policy in effect.

### Edge Cases

- Two hosts may share a global resource while retaining separate host-local data and lifecycle. References that identify the same global configuration resource share admission and intent even when their text differs; distinct resources remain isolated. Planning establishes how resource equivalence and ownership are recognized.
- Cancellation on either side of durable replacement must preserve the existing commit-boundary guarantees of 011. Cancelling a queued writer retires its own staged intent and reservation without cancelling an active generation. Interrupting or disposing one host releases only its own participation and must not invalidate resources still used by another host. Staged intent is not a durable commit or publication of committed configuration.
- If a measurement is unavailable at termination, the summary identifies it as unavailable. An observed zero remains distinguishable from an unavailable value. A request that fails before an SSE response is established has no SSE stream and owes no stream terminal summary.
- When a fallback changes or becomes ineligible before dispatch, the decision uses the latest eligible intent and preserves cancellation and tool safety.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (A1)** — Same-process hosts targeting the same global configuration resource MUST coordinate generation admission and destructive replacement across independent runtime graphs. Replacement MUST wait for protected generations to release, and later protected reads MUST reflect the committed result.
- **FR-002 (A1)** — While host A holds the actual shared generation lease for resource R and host B's PATCH waits for exclusive admission, B's accepted newer eligible fallback intent for R MUST be visible to A's next eligible recovery decision before B's durable rename, without retroactively changing an already dispatched physical attempt. If B is cancelled before commit, its staged intent MUST be retired and A MUST NOT continue selecting that abandoned value. A newer accepted intent MUST win over an older one, including across hosts B and C. No intent may leak to a host associated with a distinct resource. Distinct global resources MUST have independent admission and intent. Host-local events, lifecycle, user state and settings MUST retain their existing ownership. Planning MUST establish the resource identity and ownership boundary while preserving this isolation.
- **FR-003 (A1)** — Interrupted generation and queued writer cleanup MUST release their participation without leaked reservations, damage, deadlock or interference with surviving hosts. Cancellation after replacement MUST complete or clean up forward and preserve the committed outcome and reader coherence.
- **FR-004 (A2)** — Each SSE stream MUST attempt one terminal summary across the five outcomes in Story 2. If request abort and downstream consumer cancellation are both present before terminal classification, the classification MUST be `abort`. It MUST capture response-header latency, read waits, successful reads and chunks, stream duration, adaptive eligibility, sample count, the actual selected per-read deadline threshold and its basis, timeout read wait when applicable, and terminal classification.
- **FR-005 (A2)** — Summary delivery MUST be observational. Synchronous sink throws and asynchronous rejections MUST leave output, terminal behavior, abort and cleanup intact and MUST NOT trigger another summary attempt. Delayed or failed diagnostic delivery MUST NOT delay stream completion or cleanup.
- **FR-006 (A2)** — Adaptive read timeout behavior MUST preserve opt-in, qualifying reads, five samples, outlier handling, the 10× multiplier, the 30–300-second clamp and stream-local calibration.
- **FR-007 (A3)** — A safe turn MUST be eligible for dispatch to a distinct eligible fallback even when the primary failure is classified non-retryable or the primary retry budget is exhausted. Same-model retries MUST remain subject to the existing retryability policy and caps.
- **FR-008 (A3)** — Fallback decisions MUST preserve cancellation, unsafe interruption, blocked-work and unknown tool-effect guards, compaction precedence, settled-tool continuation without re-execution, variant attribution, same-model exclusion and already-attempted-model exclusion. The latest eligible fallback MUST be resolved immediately before dispatch.

### Key Entities *(include if feature involves data)*

- **Global configuration resource** — The configuration target whose protected generations, destructive replacements and accepted fallback intent need coordinated ordering.
- **Terminal SSE transport summary** — A stream-local diagnostic record with one outcome and the timings, counts and deadline provenance observed for that stream.
- **Recovery decision** — The disposition of a failed physical attempt based on safety, configured fallback eligibility and the separate same-model retry policy.

### Scope and cross-feature contract impact

Only A1, A2 and A3 are in scope. Runner rewrites, revival of the V1 subsystem, compaction redesign, reimplementation of 011 Config and other audit findings are excluded. A process-wide fallback singleton is outside the design mandate. Resource identity and ownership must satisfy same-resource coordination and distinct-resource isolation.

[011 FR-010](../011-restore-config-integrity/spec.md#functional-requirements) requires admission across runtime graphs and safe interruption around replacement. Its cross-graph edge case and [T011/T012 evidence](../011-restore-config-integrity/tasks.md) establish sharing across graphs inside one build. The independent-build controls demonstrate that the audited implementation lacks cross-build sharing. This new feature requires same-resource protection across independent embedded hosts. FR-010 remains in force and any proposed narrowing of a guarantee requires explicit human approval.

Preserve every existing assertion whose behavioral contract remains valid. The existing `AppNodeBuilder.build(SessionGenerationAdmission.node)` and `AppNodeBuilder.build(FallbackRuntimeIntent.node)` isolation tests construct standalone graphs without an explicit shared global configuration resource. They do not establish that production hosts referencing the same resource should remain isolated. If a resource-aware implementation legitimately changes an old test’s ownership assumptions, migrate the test explicitly and record the exact old assertions, the guarantees that remain valid, the superseded assumptions and the replacement decisive negative tests. Never silently remove, weaken or rewrite an assertion merely to make the suite green. Preserve distinct-resource isolation and same-resource coordination as separate observable requirements. The design remains open, including resource identity, ownership and lifecycle.

### Source traceability and validation workflow

- **Behavioral reference for A1–A3** — V1 `08488fb3a1e274ce00c517dc5106640f3780f50a`. V2 history begins at `8d403db345f3bf429f7dc967e006e4acdb0a90a2` with follow-up `aa73ad59b7b7e59f3f6b61b0abbe6da3b1d16927`. The 011 history includes S1 `01134d2e9db18667d0c56a345e26706d4071822e`, S2 `91dc8a5f86544f8f3d2b78b70c068efcd751b60c`, S3 `05c3997ec8aebeaf41d61a2e6c7a693ca77039c1` and T022 `24d4ecb1a1442e0a638471807ae11261011869f0`. T022 is the final audited baseline. The three audit findings establish the problems. The new acceptance cases establish implementation evidence.
- **A1 evidence owners** — Embedded SDK constructor and host runtime, server route roots, application builder, Config and session run coordinator. Reuse the dual-host fixture in `packages/sdk/test/embedded.test.ts` and existing admission and builder tests.
- **A2 evidence owners** — V1 `packages/opencode/src/provider/provider.ts` and `packages/opencode/test/provider/header-timeout.test.ts`. V2 `packages/ai/src/route/transport/http.ts` and `packages/ai/test/http-timeout.test.ts`.
- **A3 evidence owners** — V1 `SessionRecovery.decide`. V2 model retry policy, session runner retry, step and LLM recovery owners, and AI provider-error classification and error schemas. Exercise the existing runner suites and production classifier.
- Prefer three architecture-owned slices covering A1 shared-resource admission, A3 recovery policy and A2 transport diagnostics. Keep related work together with one independent acceptance review per slice. Adjust boundaries only where demonstrated code dependencies justify the change. Reuse existing V2 Effect owners, production fixtures and suites.
- Run Spec Kit Analyze on the spec, plan and tasks before implementation. Record deterministic positive and decisive negative evidence for each slice independently. Preserve existing assertions and record the actual commands and exit codes for relevant tests and typechecks, plus any checks that could not run and why. Run full Spec Kit Convergence after all slices.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (A1, FR-001–003)** — Two live same-resource hosts exhibit zero renames before generation releases and one successful replacement afterward, with coherent reads in both hosts and visibility of the newer eligible intent. Both isolation and interruption controls pass.
- **SC-002 (A2, FR-004–006)** — All five terminal outcomes produce exactly one correctly classified summary attempt per stream. Healthy inference completes in both sink-failure cases. The calibrated timeout reports the actual selected deadline and the next stream begins with fresh calibration.
- **SC-003 (A3, FR-007–008)** — The classified Authentication case has exactly one primary and one fallback request. The exhausted-budget case has zero excess primary attempts and successfully falls back. Safety controls show zero duplicate tool executions, zero unsafe replay or prohibited fallback requests, and preserved compaction precedence and dispatch attribution.

## Assumptions

- Same-process embedded hosts are the boundary of A1. Existing configuration semantics still determine which global resource each host targets.
- Deterministic fixtures can exercise real host and runner entry points with controlled provider responses, timing and filesystem observation. Live external providers are unnecessary for acceptance.
