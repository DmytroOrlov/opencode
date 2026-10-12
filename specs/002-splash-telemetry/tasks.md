---

description: "Dependency-ordered tasks for Splash generation telemetry"
---

# Tasks: Splash Generation Telemetry

**Input**: `specs/002-splash-telemetry/{spec,plan,research,data-model,quickstart}.md` and `specs/002-splash-telemetry/contracts/splash-telemetry.md`

**Scope**: Passive observation on the already-selected AI SDK path. `splashTelemetry` changes neither the inference body nor runtime selection. Reuse the existing attempt owner, EffectBridge, `session.telemetry`, fallback, and MLX behavior. Do not add schema, store, UI, polling, transport, request, or multi-step aggregation work.

**Tests**: Required by the specification and the implementation gate. Use Splash 1.1.0 choices-bearing Chat SSE fixtures and the pinned SDK; no live backend is needed.

## Phase 1: Setup — protocol-mechanical gate

**Purpose**: Prove the exact SDK seam before changing architecture or production code. Stop implementation and amend the plan if this gate fails.

- [X] T001 In `packages/opencode/test/session/llm.test.ts`, add a protocol-faithful fake Splash Chat SSE test using the contract's choices-bearing `prompt_progress`, finish `timings`, optional usage, and `[DONE]` frames; prove the pinned SDK accepts progress when present and terminal timings as `{ type: "raw", rawValue: unknown }` on `fullStream`, ignores malformed/unrelated raw telemetry, and preserves ordinary text/tool stream events. This is the first implementation gate; no production task starts until it passes.

**Checkpoint**: T001 passes against the pinned SDK before T002–T022.

---

## Phase 2: Foundational — request invariance and shared ownership

**Purpose**: Lock down the passive opt-in boundary, then extract only ownership needed by both providers.

- [X] T002 [P] In `packages/opencode/test/provider/provider.test.ts`, add constructor-option regression cases for `splashTelemetry: true` and absent/false; assert the OpenCode control is absent from SDK factory/cache-key options while ordinary provider options and `mlxTelemetry` behavior remain intact. Depends on T001.
- [X] T003 [P] In `packages/opencode/test/session/llm.test.ts`, capture telemetry-off/on HTTP bodies and dispatch choices for Splash and another OpenAI-compatible provider; assert byte-identical bodies, no `splashTelemetry` on the wire, no inserted or removed `return_progress`, unchanged `stream`/`include_usage`, identical runtime selection including experimental native dispatch, and MLX precedence when both controls are enabled. Depends on T001.
- [X] T004 In `packages/opencode/src/provider/provider.ts`, strip `splashTelemetry` from the SDK constructor option copy before cache-key/factory construction, as T002 specifies; do not alter real provider protocol options. Depends on T002.
- [X] T005 In `packages/opencode/src/session/llm.ts`, strip `splashTelemetry` from prepared request options before provider-option conversion or native construction, retaining the local opt-in value only for later observation; do not inject `return_progress` or change dispatch. Depends on T003 and T004.
- [X] T006 In `packages/opencode/src/session/llm/attempt-telemetry.ts`, move/generalize only the provider-neutral holder, provider-source ownership, and finite-positive decode acceptance needed by MLX and Splash; preserve `providerDecodeAccepted` and EffectBridge ordering. If the existing owner already satisfies an item, record no change for that item. Depends on T005.
- [X] T007 In `packages/opencode/src/session/llm/mlx-telemetry.ts`, consume the provider-neutral pieces from T006 while leaving MLX `/events` watching, attribution, decode behavior, and public semantics unchanged; use no-change where no edit is needed. Depends on T006.
- [X] T008 In `packages/opencode/test/session/mlx-telemetry.test.ts`, run the existing MLX lifecycle/arbitration suite after T007 and add a focused assertion only if the extraction exposes an uncovered regression; preserve existing expectations. Depends on T007.

**Checkpoint**: Request and runtime invariance are proven; MLX behavior remains green before Splash integration.

---

## Phase 3: User Story 1 — View Splash request progress and final rate (P1) 🎯 MVP

**Goal**: Display validated request-local prefill when the normal stream contains it and one authoritative final decode rate after successful completion; retain generic live fallback.

**Independent Test**: A single opted-in fake Splash generation with independently configured `return_progress` shows coalesced provider prefill, live fallback decode, unchanged text/tools, and a provider-native final rate only after stream success. Without `return_progress`, prefill is absent and fallback remains eligible.

### Tests

- [X] T009 [US1] In `packages/opencode/test/session/splash-telemetry.test.ts`, write collector contract tests first for valid and absent `prompt_progress`, finite/nonnegative `total/cache/processed/time_ms`, positive total, cache/processed bounds, repeated/regressing/inconsistent progress rejection, step-local reset, bounded 250 ms coalescing with final prefill flush, and one cached valid terminal rate that cannot publish before successful finalize. Depends on T008.

### Implementation

- [X] T010 [US1] Create `packages/opencode/src/session/llm/splash-telemetry.ts` as an attempt-local, best-effort raw-chunk parser/collector satisfying T009: observe only recognized Splash Chat chunks, publish normalized provider prefill through the existing source, leave fallback acceptance false for prefill, count every recognized terminal timing before rate validation, accept finite positive `predicted_per_second` only when the count is exactly one and finalize succeeds, and close on discard/late events. Do not parse usage metrics or derive decode rate from counts/durations. Depends on T009.
- [X] T011 [US1] In `packages/opencode/test/session/llm.test.ts`, add a failing opted-in AI SDK integration case that consumes the same `fullStream`, checks unchanged text/tool events and the existing `session.telemetry` path, and proves no extra inference request or Splash-specific event is created. Depends on T010.
- [X] T012 [US1] In `packages/opencode/src/session/llm.ts`, attach the T010 collector only when `splashTelemetry: true` selects the existing OpenAI-compatible AI SDK path and MLX is not selected; enable `includeRawChunks`, observe raw parts from that same `fullStream` before normal conversion, return every original part unchanged, and bind finalize/discard to `beginAttemptTelemetry`. Catch telemetry parsing/publication errors without delaying or failing generation. Depends on T010 and T011.
- [X] T013 [US1] In `packages/opencode/src/session/llm/ai-sdk.ts`, verify the existing conversion still passes ordinary text/tool semantics and ignores Splash raw telemetry while preserving Copilot raw billing behavior; make no edit if T001/T011 prove it already does so, otherwise make only the smallest required conversion fix. Depends on T012.

**Checkpoint**: US1 passes its independent fake-stream test on the already-selected AI SDK path.

---

## Phase 4: User Story 2 — Keep telemetry truthful and generation resilient (P1)

**Goal**: Invalid, absent, or ambiguous native values never displace eligible fallback or affect generation.

**Independent Test**: Fake streams with zero, one invalid, and multiple terminal timings complete with normal output; only exactly one finite positive timing becomes native terminal telemetry, and a too-short stream with no measurable fallback has no fabricated rate.

### Tests and minimal fixes

- [X] T014 [US2] In `packages/opencode/test/session/splash-telemetry.test.ts`, extend collector tests to cover zero terminal timings; exactly one zero, missing, malformed, or non-finite `predicted_per_second`; two timings with invalid-first/valid-second and other validity combinations; and ignored unrelated, aggregate, malformed, or late raw parts. Assert every recognized terminal timing increments the count before rate validation and more than one always fails closed. Depends on T013.
- [X] T015 [US2] In `packages/opencode/test/session/llm.test.ts`, add integration regressions proving provider prefill leaves generic live decode eligible, a valid single rate replaces fallback only after successful finalization, unavailable/ambiguous rates retain measurable fallback, and no provider or fallback sample produces no `0 tok/s`; telemetry exceptions cannot change normal text/tool output or stream outcome. Depends on T014. Exception isolation is covered at the collector publication boundary and by the existing guarded raw-observation call in `llm.ts`; no test-only production injection was added.
- [X] T016 [US2] In `packages/opencode/src/session/llm/splash-telemetry.ts`, close only gaps exposed by T014–T015 in terminal-count arbitration, validation, coalescing, or exception isolation; keep the parser attempt-local and leave generic fallback logic unchanged. If T010 already passes all cases, make no edit. Depends on T015. No production change was needed.

**Checkpoint**: US2's malformed, absent, ambiguous, and short-output cases retain truthful telemetry and normal generation behavior.

---

## Phase 5: User Story 3 — Preserve provider behavior and attempt lifecycle (P1)

**Goal**: Splash observations remain bound to one AssistantMessage attempt across retries, failures, aborts, and concurrency; MLX and generic fallback remain unchanged.

**Independent Test**: Retry one AssistantMessage and run two overlapping Splash streams; neither stale nor cross-request telemetry appears. Abort, setup failure, stream failure after a timing frame, and late callbacks cannot publish successful terminal telemetry. Existing MLX/fallback regressions pass.

### Tests and minimal fixes

- [X] T017 [US3] In `packages/opencode/test/session/llm.test.ts`, add attempt-lifecycle regressions for reset on same-message retry, abort, provider setup failure, stream failure after a timing frame, raw callbacks after discard, and two concurrent Splash attempts with distinct progress/rates; assert no stale or cross-contaminated `session.telemetry`. Depends on T016. Provider setup and late-after-discard remain covered by the existing generic lifecycle tests and T014 collector test, respectively.
- [X] T018 [US3] In `packages/opencode/src/session/llm.ts`, make only lifecycle wiring fixes revealed by T017 so the existing attempt owner finalizes Splash before fallback on stream success and discards its cached timing/progress on every unsuccessful exit; preserve EffectBridge order and `providerDecodeAccepted`. If T012 already passes, make no edit. Depends on T017. No production change was needed.
- [X] T019 [US3] In `packages/opencode/test/session/mlx-telemetry.test.ts` and `packages/opencode/test/session/fallback-telemetry.test.ts`, run existing MLX `/events`, generic fallback, arbitration, and no-sample regressions unchanged after T018; add a focused test only for a demonstrated gap, with no MLX redesign. Depends on T018.

**Checkpoint**: US3 passes lifecycle, concurrency, MLX, and generic fallback tests independently.

---

## Phase 6: User Story 4 — Opt in without changing provider requests (P2)

**Goal**: The explicit OpenCode-local control gates observation and remains absent from constructor options and inference data for Splash and other providers.

**Independent Test**: Compare captured SDK options, byte-identical request bodies, runtime choice, and native/fallback behavior with the control off and on, with and without independently supplied `return_progress`, and with MLX also enabled.

- [X] T020 [US4] In `packages/opencode/test/provider/provider.test.ts`, complete the opt-in regression matrix for true/false/absent `splashTelemetry` and non-Splash OpenAI-compatible providers; assert constructor sanitization and unchanged ordinary options. Depends on T019.
- [X] T021 [US4] In `packages/opencode/test/session/llm.test.ts`, complete the wire/runtime matrix from T003 using captured full request bodies: telemetry off/on is byte-identical, native dispatch stays native when selected, disabled or non-Splash requests attach no Splash observer, and `mlxTelemetry` selection wins when both controls are true. Depends on T020.

**Checkpoint**: US4 demonstrates the opt-in is observational at both sanitization boundaries.

---

## Phase 7: Polish and cross-cutting validation

- [X] T022 Run focused Bun suites for `packages/opencode/test/session/splash-telemetry.test.ts`, `packages/opencode/test/session/mlx-telemetry.test.ts`, `packages/opencode/test/session/fallback-telemetry.test.ts`, `packages/opencode/test/provider/provider.test.ts`, and `packages/opencode/test/session/llm.test.ts`; resolve only failures within the listed production/test paths. Depends on T021.
- [X] T023 Run the package typecheck for the touched `packages/opencode/src/provider/provider.ts`, `packages/opencode/src/session/llm.ts`, `packages/opencode/src/session/llm/ai-sdk.ts`, `packages/opencode/src/session/llm/attempt-telemetry.ts`, `packages/opencode/src/session/llm/mlx-telemetry.ts`, and `packages/opencode/src/session/llm/splash-telemetry.ts`; resolve only relevant type errors within the permitted paths. Depends on T022.

## Dependencies and execution order

```text
A  T001 protocol/SDK gate
   ↓
B  T002 ∥ T003 tests → T004 → T005 request sanitization
   ↓
C  T006 → T007 → T008 minimal shared extraction and MLX gate
   ↓
D/E  T009 → T010 → T011 → T012 → T013 US1 collector and fullStream wiring
   ↓
F  T014 → T015 → T016 US2 truthfulness
   ↓
F  T017 → T018 → T019 US3 lifecycle and regression
   ↓
B/F  T020 → T021 US4 opt-in completion
   ↓
G  T022 → T023 focused tests and typecheck
```

`∥` is the sole marked parallel opportunity: T002 and T003 touch independent test files after T001. Every later task follows its listed prerequisite. T004–T005 are already covered by tests before the shared ownership extraction. The story dependencies are US1 → US2 → US3 → US4 for this implementation sequence, even though US4's request-boundary tests start in the foundation. No story requires a new schema, store, UI, polling path, runtime switch, or transport.

## Implementation strategy

**MVP**: Complete T001–T013, then run the US1 independent test. Continue through US2 and US3 to establish truthful fallback and lifecycle behavior before claiming full feature completion. Finish US4 and T022–T023 before delivery. A shared-file task may end with a documented “no change required” result when its specified tests prove the existing behavior already meets the contract.
