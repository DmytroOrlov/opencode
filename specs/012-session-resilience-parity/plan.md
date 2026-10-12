# Implementation Plan for Session Resilience Parity

**Feature** `012-session-resilience-parity` · **Git branch** `011-restore-config-integrity` · **Date** 2026-11-22
**Input** [Clarified specification](spec.md) and [requirements checklist](checklists/requirements.md)

## Summary

Share generation admission and fallback intent by the effective writable config resource across embedded hosts. Give the existing session runner a safe distinct-model dispatch path when the ordinary retry decision declines or runs out. Observe the complete HTTP SSE execution with one terminal diagnostic and the actual timing selected for its reads.

Planning HEAD is `49dd00a44f61a63032f299c2946a31fdf1091e9c`. Relative to audited V2 `24d4ecb1a1442e0a638471807ae11261011869f0`, only Spec Kit tooling changed. The initial index contained the staged 012 spec and checklist. See [research](research.md#checkout-evidence) for the V1 reference and checkout record.

## Technical Context

| Area | Selection |
|---|---|
| Language and runtime | TypeScript 6, Bun 1.4.4 and Effect 4.1.0 as pinned in the checkout. |
| Dependencies | Existing Effect LayerNode/Scope, queues, streams and Clock, platform FileSystem, SDK embedded transport and HTTP executor. No dependency additions. |
| Storage and contract impact | Existing JSON/JSONC files and atomic rename stay authoritative. No schema, generated client, session storage or user interface change. One structured debug diagnostic is additive. |
| Platforms | Same-process embedded hosts using the same backing config filesystem. Preserve standalone server and embedded workerd behavior. |
| Validation | Package-local Bun suites, controlled filesystem and provider fixtures, Effect TestClock, gates and actual dispatch/rename counters. |
| Performance and constraints | Resolve resource identity once per host. One registry entry per live writable resource. Diagnostic state is per stream, constant-sized apart from the existing bounded five-sample window, with no waiting on delivery. Preserve retry caps, cleanup and deadline behavior. |
| Scope | A1, A3 and A2. Three implementation slices and one independent review per slice. |

## Constitution Check

| Gate | Before research | After design |
|---|---|---|
| I, VII, IX — behavior, scope and existing assertions | Retain 011 and working session/transport behavior except deltas explicitly specified by 012. | Pass. Preserve standalone-build controls, Config update and failure semantics, retry and transport suites. Extend the unchanged-compaction fixture and add a real stale-candidate control. |
| II, III, V, X — reuse, authority, boundaries and evidence | Inspect the existing LayerNode, Config, runner and HTTP/Effect owners and V1 behavior before adding state. | Pass. The map owns only resource pair lifetime. Config still writes and publishes. RunStep dispatches and the physical step settles. Reuse HTTP execution scope and route acknowledgement. Concrete gaps and alternatives are recorded in research. |
| IV, VIII — ordering and deterministic coverage | Require observable entry, dispatch, rename, cancellation and timer boundaries. | Pass. Revision and completion tokens, resource reference lifetime, barrier fixtures, request counts, same-resource and isolation controls, and abort races are specified. |
| VI, XIII–XX — provenance and observational telemetry | Keep diagnostic timing tied to the transport; preserve normalized generation telemetry. | Pass. One immutable per-execution snapshot, optional unavailable times, distinct idle and total timers, no provider-native metric substitution, no polling or extra requests, and detached guarded delivery. Preserve attempt telemetry lifecycle, Splash/MLX adapter and Promise parity checks. |
| XI, XII — UI stability and governance | Review applicable boundaries and record exceptions. | Pass. No presentation touched. No exceptions or amendment required. |

## Project Structure

```text
specs/012-session-resilience-parity/
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   ├── embedded-config.md
│   ├── session-recovery.md
│   └── sse-diagnostics.md
└── quickstart.md
```

Code remains in `packages/{core,server,sdk,ai}` using the ownership and test map below. Tasks is the next workflow, followed by Analyze before implementation.

## Phase 0 — Research

[R1–R6](research.md) resolve the resource identity and lifetime, reservation semantics, retry/service boundaries, freshness and SSE classification. No product clarification remains open.

## Phase 1 — Architecture and slice handoff

[Data model](data-model.md) · [Validation guide](quickstart.md)

### S1 — A1 resource-scoped admission and intent

**Production owners.** `packages/server/src/routes.ts` owns the embedded mode. Finalize its standard and runtime/simulation replacements before acquiring the effective Global and `FSUtil.Service` via the existing LayerNode group/compile mechanism. The local provider in `packages/util/src/effect/app-node-platform.ts` annotates its backing namespace and `packages/util/src/fs-util.ts` forwards it. A virtual backend owns its token. Initialize and probe the Config directory via the captured FSUtil. Let a small scoped Core owner in `packages/core/src/effect/app-node-builder.ts` or an adjacent module acquire the pair using the proven namespace and directory identity. Bind the exact captured FSUtil, the resolved Global target and the pair into the host build. Propagate a typed startup error and finalize partially acquired scopes on failure. Freeze the final list before the SDK's deferred private-instance selector can use it. Preserve the standalone path and synchronous compile checks for direct builder callers. The embedded path binds the resource pair as a unit. Keep test observation against the real owner. Acquire the registry reference in the outer scope before compiling the host layer, with host runtime and child scopes closing before the reference finalizer. See [R1](research.md#r1--identify-the-writable-directory-then-borrow-its-coordination) and [R2](research.md#r2--extend-the-binding-and-lifetime-preserving-config-ownership).

`packages/sdk/src/effect/opencode.ts`, `packages/sdk/src/internal/host.ts` and `packages/sdk/src/internal/fetch.ts` own SDK and runtime lifetime. Preserve their public signatures and shutdown order. Verify inheritance through `packages/sdk/src/internal/instances.ts` and `packages/core/src/location-services.ts`. `packages/core/src/session/generation-admission.ts` and `packages/core/src/session/run-coordinator.ts` own queue and generation leases. `packages/core/src/config.ts` and `packages/core/src/config/fallback-runtime-intent.ts` own update flow, reservation, staging, committed revision and reconciliation. Retain algorithms and narrow changes to scope wiring and acquire/cleanup handoffs.

**Fixture and regression.** `packages/sdk/test/embedded.test.ts` owns end-to-end evidence. Reuse `withEmbedded`, the independent-host event topology, `TestLLM` gates and isolated providers. Reuse or share the existing server filesystem fixture's delegate and rename recorder. Test through public SDK generation, PATCH and protected GET, including prewarming both host reads so a fresh-cache-only pass cannot hide a stale-reader defect. Use an acceptance/admission barrier at the actual ownership transition and a separate rename barrier. A test trace must observe the real shared logic. If existing seams cannot expose actual enqueue, add a narrowly scoped, observational checkpoint at that transition. Use the paired host scopes for independent closure. See [embedded contract](contracts/embedded-config.md).

**Migration rule.** Preserve both standalone controls in `packages/core/test/effect/app-node-builder.test.ts`. The lease test asserts different service references and B's exclusive grant before A's shared lease releases. The intent test asserts different references, revision 1 in each local stream, an earlier reservation blocking its own owner only, no cross-owner visibility, and retirement unblocking its own owner. Narrow any title or comments that generalize those controls to all independent builds. These fixtures never bind a resource. Add real same-resource blocking and distinct-resource progress separately. Retain the existing same-build root/location, cross-location stale-read, cleanup and 011 S1/S2/S3 assertions including server abort, typed responses and publication identity.

**Dependency and completion.** Independent of S2. Use the existing backoff-based fallback path to witness A reading B's intent. Both same-resource and distinct-resource SDK tests, alias and disposal controls, and the 011 regression gates must pass. One independent review checks alias identity, scope/refcount, failed startup and cancellation handoff, plus evidence at the rename boundary.

### S2 — A3 recovery decision and safe fallback

**Production owners.** `packages/core/src/model-retry.ts` and `packages/core/src/session/runner/retry.ts` keep authorization, schedule and hook semantics. Expose the hard cap state distinctly from the proposed retry so a session hook cannot replenish an exhausted budget. `step.ts` and `publish-llm-event.ts` own settlement and replay facts. Inspect actual local and provider-executed tool outcomes before failures are synthesized. Add a distinct-only recovery result after the existing failed-step settlement, retaining the original failure. Keep current full-transport recovery and overflow precedence. Safe distinct restart applies to clean failures; safe distinct continuation carries the durable settled tool history. Unsupported partial work keeps the existing ordinary decision or terminates. Ordinary retry paths may still run their existing same-model continuation after partial output when a distinct switch is unsafe. Use pre-cleanup tool facts to gate both ordinary retry dispatch and distinct-only recovery. Even a retryable failure or in-budget hook authorization cannot replay an unknown executing-tool effect or dispatch an unsafe fallback. Preserve original failure identity and settlement in these cases. Cancellation, handoff and blocked-work guards still apply.

`llm.ts` owns newest candidate selection and dispatch, including post-compaction and request-preparation freshness. Put the final freshness check and attempt credit at the entry to provider stream consumption in `step.ts`, after its setup and before any model I/O. If the token changed, return to runner preparation without marking or publishing a failed attempt. Recheck effective model and variant after async preparation. Carry the [attempted identity set](data-model.md#recovery-disposition-and-attempt) via `runner/index.ts` and `session/execution.ts` through real session move/reload or Location handoff in the same active turn. Test X as a previously dispatched provider/model, exclude it after handoff and allow it in a genuinely new turn. Preserve primary snapshot, ordinary delay and durable tool history. No classifier change is needed in `packages/ai/src/provider-error.ts` or `schema/errors.ts`. See [recovery contract](contracts/session-recovery.md).

**Fixture and regression.** `packages/core/test/session-runner.test.ts` owns runner scenarios using `scenario`, the existing Config read barrier, retry subscription, `RETRY_GAPS_MAX`, `TestLLM`, tool fixtures and recorded projection checks. Use `RequestExecutor.httpFailure` with HTTP 401 input or a route-level fake 401 to demonstrate the actual classifier, then feed the typed failure through the production runner. Record request counts, attributed ref and variant, retry events, tool calls/results and terminal state. Use `session-runner-retry.test.ts` to pin existing caps and hook behavior. Keep the existing compaction test's request, step, model-event and history assertions for unchanged intent. Add two sibling fixtures. In the first, let provisional B physically start and finish an attributed compaction summary while intent changes to C. Require the subsequent fallback generation and its telemetry to identify C and its variant, with no B fallback-generation dispatch, attempt credit or telemetry. In the second, supersede fully prepared B before provider consumption and require zero B generation requests or credits, followed by C with rebuilt history, options, model and variant. Keep already dispatched requests immutable.

**Dependency and completion.** Independent of S1 implementation through the existing intent service seam. After both slices integrate, rerun the same-resource test and the runner freshness suite. One independent review checks forbidden dispatch counts, replay evidence, the last budgeted request, and actual model attribution.

### S3 — A2 SSE terminal diagnostics

**Production owners.** `packages/ai/src/route/transport/http.ts` owns setup, stream-local metrics, selected deadline and terminal finalization. Mark raw-pull starts and outcomes around the existing adaptive and fixed paths, preserving the fixed `Stream.timeoutOrElse` implementation and whole-request limit. Capture the calibrated basis at deadline selection from the same computation as the deadline. Use the transport execution scope so the classification sees the owning stream exit rather than a cancelled internal pull. Implement HTTP SSE’s optional `TransportExecution.complete` and wire it into the existing successful-consumption path in `packages/ai/src/route/transport/index.ts` and `packages/ai/src/route/client.ts`. HTTP currently leaves the acknowledgement absent. Carry an explicit per-request abort probe in the existing Promise bridge `packages/ai/src/index.ts`. Preserve the actual signal race and public error. Keep timing, classification, the immutable snapshot and detached Effect-native sink in `http.ts`. Adapt Promise-returning sinks only in `packages/ai/src/index.ts`, where the adapter catches throws, attaches rejection handling and returns without waiting. Exercise the actual adapter in Promise regressions. Keep the diagnostic independent of `packages/ai/src/telemetry/splash.ts` and normalized session telemetry. See [SSE contract](contracts/sse-diagnostics.md).

**Fixture and regression.** `packages/ai/test/http-timeout.test.ts` owns timing, using `dynamicResponse`, fake SSE bodies and TestClock. Use `promise.test.ts` or a focused Promise case in the timeout suite for iterator return versus `AbortSignal` through the real bridge. Use a per-execution recorder for exactly one attempted summary and separate latches for transport cleanup and sink settlement. Preserve timeout, adaptive policy, HTTP middleware, Promise type parity and provider telemetry assertions.

**Dependency and completion.** Independent of S1/S2. Exercise all outcomes, stable classification under cancellation races, both sink failure modes, a never-settling controlled sink, fixed and whole-request deadlines, calibrated stall and fresh stream calibration. One independent review checks classification with the owning scope exit, actual selected deadline, sink detachment and unchanged transport behavior.

## Validation gates and readiness

Run package-scoped tests and typechecks in the [quickstart](quickstart.md). Capture command, exit code, exact trace evidence, and any applicable check unavailable to the implementer. Each slice has one implementation pass scoped for a GPT-6.1 Terra Low coding agent and one independent review. Use Tasks to encode the slices and Analyze before implementation. Use Convergence after implementation and reviews.

**Risks to verify during implementation**

- Filesystem aliases depend on reliable identity from the effective filesystem. Exercise independent wrappers over the same store, real aliases and canonical casing where supported, absent config files, two virtual stores with colliding path/inode data, and startup failure without a leaked reference. Do not use changing file inode or process-wide path folding.
- A waiter can be interrupted between grant and cleanup registration. Exercise that boundary while the other host stays live, alongside the existing 011 precommit and forward-publication tests.
- Async configuration, model resolution and compaction can race with candidate dispatch. Test a revision change in each relevant suspended interval, and preserve history/accounting for the provisional candidate.
- Transport tests must pin which scope receives the exit for iterator return versus explicit interruption. Observe the owning execution scope and capture the signal before classifying. A test that merely observes a child read interruption is insufficient.

**Readiness verdict** READY FOR TASKS. Phase 1 design and constitution checks are complete. No unresolved architecture decision or constitution exception remains. Runtime acceptance and test/typecheck results are implementation evidence.
