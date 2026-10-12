# Tasks: Provider Stream Liveness

**Input**: Design documents from `specs/006-provider-stream-liveness/`

**Story**: US1 (P1), recover from a silent provider connection while retaining bounded passive transport diagnostics. Current implementation already contains the planned policy, diagnostics, and recovery behavior; tasks below make each requirement traceable for convergence and call for code changes only where focused verification finds a gap.

## Phase 1: User Story 1 - Recover from a silent provider connection (P1)

**Goal**: Keep the evidence-based `opencode-go` idle-read policy, verify one passive terminal diagnostic per timed SSE request, and prove that transport timeout reaches existing fallback recovery.

**Independent Test**: Focused provider tests establish defaults, overrides, disabled-path behavior, healthy/stalled reads, and diagnostic semantics. A normal provider/session processor run against a silent SSE response reaches existing recovery and dispatches an eligible fallback; explicit abort with an eligible fallback remains terminal.

- [ ] T001 [P] [US1] Retain or adjust the provider-policy assertions in `packages/opencode/test/provider/header-timeout.test.ts` so generic defaults remain `300_000`, `opencode-go` defaults to `150_000`, and explicit numeric and `false` overrides win.
- [ ] T002 [US1] Retain or adjust the `opencode-go` provider-specific `chunkTimeout: 150_000` default through the existing options/default merge path in `packages/opencode/src/provider/provider.ts`; preserve later explicit numeric and `false` configuration precedence.
- [ ] T003 [US1] Verify in `packages/opencode/test/provider/header-timeout.test.ts` that a disabled chunk timeout returns the original response without a body proxy, healthy reads inside the boundary complete, and a stalled read raises the existing retryable `ResponseStreamError("SSE read timed out")`; add coverage only for any gap.
- [ ] T004 [US1] Verify in `packages/opencode/test/provider/header-timeout.test.ts` that a timed SSE request emits at most one terminal summary with the required available request host, header/read-wait timings, counts, stream duration, configured timeout, terminal outcome, and timeout read wait; measurements must represent pending `reader.read()` waits rather than total call latency.
- [ ] T005 [US1] Verify in `packages/opencode/test/provider/header-timeout.test.ts` that summary logging is best-effort and cannot fail generation, and that explicit request abort and consumer cancellation have distinct diagnostic attribution where the transport can distinguish them; add only missing focused coverage.
- [ ] T006 [P] [US1] Retain or adjust the processor integration regression in `packages/opencode/test/session/processor-effect.test.ts` so a real stalled SSE transport using a short timeout reaches ordinary recovery and dispatches an eligible fallback; do not invoke `SessionRecovery` directly.
- [ ] T007 [US1] Retain or adjust the processor cancellation regression in `packages/opencode/test/session/processor-effect.test.ts` so explicit abort with an eligible fallback remains terminal and does not dispatch the fallback.
- [ ] T008 [US1] Run focused verification from `packages/opencode`: `bun test test/provider/header-timeout.test.ts`, `bun test test/session/processor-effect.test.ts`, and `git diff --check`; record outcomes and investigate only failures related to these requirements.

## Dependencies & Execution Order

- T001 and T006 touch separate test files and can be reviewed independently.
- T002 confirms the implementation underlying T001; the default assertion should be available when evaluating the provider policy.
- T003, T004, and T005 share `header-timeout.test.ts` and should be handled sequentially or coordinated within one change.
- T006 and T007 share `processor-effect.test.ts` and should be handled sequentially or coordinated within one change.
- T008 follows all focused verification and any resulting gap fixes.
- Execution order: T001 → T002 → T003 → T004 → T005; T006 → T007; then T008.

## Parallel Opportunities

- T001 and T006 can proceed in parallel because they use separate test files.
- Provider diagnostic tasks T003–T005 share one file; processor tasks T006–T007 share another file and should not be edited concurrently within each pair.

## Implementation Strategy

Treat the existing implementation as the baseline. Confirm provider policy and disabled/healthy/stalled transport semantics, confirm the bounded diagnostic summary and its failure isolation, then confirm processor recovery and abort behavior. Make only focused corrections for uncovered gaps. Finish with the two test files and `git diff --check`.

## Scope Boundaries

- Expected production file: `packages/opencode/src/provider/provider.ts`.
- Expected test files: `packages/opencode/test/provider/header-timeout.test.ts` and `packages/opencode/test/session/processor-effect.test.ts`.
- No task changes session retry, recovery, or processor production code.
- No task adds adaptive timeout behavior, production trend analysis, persistence/UI telemetry, logging infrastructure, native runtime support, or unrelated cleanup.
- Generic timeout/retry/recovery tests that already prove unchanged behavior are reused rather than duplicated.

## Format Validation

All eight tasks use checkbox format, sequential IDs, the US1 story label, a concrete validation action, and an affected file path or runnable command. Tasks include only the work needed to establish clarified feature behavior and validation.

## Phase 2: Convergence

- [x] T009 Add focused assertions in `packages/opencode/test/provider/header-timeout.test.ts` using the existing logger test seam to verify one terminal summary per timed SSE request and its available request host, header/read-wait measurements, counts, duration, configured timeout, outcome, and timeout read-wait fields per FR-009 (partial).
- [x] T010 Add focused assertions in `packages/opencode/test/provider/header-timeout.test.ts` that diagnostic outcomes distinguish completion, timeout, explicit abort, consumer cancellation, and other read error where observable, and that logger failure cannot alter generation; use existing test seams without adding persistent capture infrastructure per FR-010 / SC-006 (partial).
