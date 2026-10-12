# Implementation Plan: Splash Adaptive SSE Timeout

**Branch**: `007-splash-adaptive-sse-timeout` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification and resolved architecture decisions for `specs/007-splash-adaptive-sse-timeout/spec.md`.

## Summary

Add opt-in, request-local adaptive SSE idle timeout behavior to the existing provider transport in `packages/opencode/src/provider/provider.ts`. Enable it only when `splashAdaptiveSseTimeout: true` is explicitly configured and the resolved dispatch endpoint is loopback HTTP(S). Keep the current conservative chunk timeout until five qualifying nonempty reads have each waited at least 100 ms; then use the last-five trimmed-maximum rule, bounded by 30 seconds and the existing default timeout. Fixed numeric and disabled `chunkTimeout` behavior remains authoritative. The feature remains opt-in until the separate full-context and post-compaction validation gates pass.

## Technical Context

**Language/Version**: TypeScript; repository runtime uses Bun and Effect.

**Primary Dependencies**: Existing `timeoutFetch()` / `wrapSSE()` transport in `packages/opencode/src/provider/provider.ts`, provider config options in `packages/core/src/v1/config/provider.ts`, existing provider SDK loading and cache-key path, and Effect logging bridge.

**Storage**: None. Keep at most five meaningful wait durations plus the current request's derived timeout in memory for one SSE response.

**Testing**: Deterministic Bun coverage alongside `packages/opencode/test/provider/header-timeout.test.ts`; separate full-context and post-compaction validation before any default enablement.

**Target Platform**: OpenCode provider and session-generation runtime; adaptive mode is limited to explicitly declared local Splash providers using loopback HTTP(S).

**Project Type**: TypeScript monorepo; provider runtime and core provider configuration.

**Performance Goals**: Constant-size calibration state; no per-chunk diagnostic logging; no total-generation timeout; only future reads observe recalculated thresholds.

**Constraints**: Default disabled pending validation; explicit opt-in and loopback endpoint required. Keep explicit numeric and `false` chunk-timeout semantics, header timeout, explicit request timeout, retries, fallback, cancellation, and replay safety unchanged. Strip the local option from SDK arguments while preserving cache-key separation.

**Scale/Scope**: Existing provider transport, provider option handling and focused provider timeout tests, plus feature design artifacts. No new timeout owner, persistent state, or recovery path.

## Constitution Check

- **Principle I, Upstream- and Protocol-First Reuse**: Pass. The behavior extends the existing response-body reader and provider fetch wrapper; it introduces no new transport abstraction.
- **Principle II, Additive Provider Support and Regression Compatibility**: Pass. Behavior is gated to explicit local Splash opt-in and leaves other providers and existing Splash telemetry options unaffected.
- **Principle III–V, Telemetry Lifecycle, Attribution, and Provenance**: Pass. Calibration is transport-local to one SSE request and measures its own read waits; it is not generation telemetry and is not persisted or attributed across requests.
- **Principle VI, Telemetry Is Observational and Must Never Break Generation**: Pass. The option is OpenCode-local and excluded from SDK arguments; diagnostics do not participate in stream control.
- **Principle VII, Preserve the Dispatch Source of Truth**: Pass. Loopback eligibility is evaluated against the effective endpoint used for dispatch, with no port or provider-name inference.
- **Principles IX–X, Tests Define Semantics and Minimal Evidence-Driven Change**: Pass with validation gate. Deterministic arithmetic and lifecycle coverage is required; separate full-context and post-compaction validation is required before changing default enablement.
- **Principle XI, Performance and UI Stability**: Pass. State is bounded to five samples and logging is aggregated without per-chunk spam.

**Gate result**: Pass. The requested behavior has clear ownership, explicit local-provider scope, bounded request state, and compatibility rules. Default enablement remains gated on the specified validation.

## Design Decisions and Repository Evidence

- `timeoutFetch()` currently reads `chunkTimeout`, `headerTimeout`, and `timeout`, combines abort signals, and wraps the response through `wrapSSE()` only when chunk timing is enabled. Keep policy and cancellation behavior here.
- `wrapSSE()` currently creates one timer per pending `reader.read()`, measures read waits with `performance.now()`, and cancels/aborts through the established `ProviderError.ResponseStreamError` path. Extend the per-read deadline selection and successful-read accounting in place.
- `resolveSDK()` copies provider options, removes local telemetry controls, hashes the remaining options for its SDK cache key, then installs `timeoutFetch()` and removes timeout controls before SDK construction. Remove `splashAdaptiveSseTimeout` from SDK factory arguments but retain it in the pre-strip cache-key options, so configurations remain cache-separated.
- `packages/core/src/v1/config/provider.ts` leaves provider-specific option records open through `StructWithRest`; the option can be represented there without narrowing or changing unrelated provider options. Preserve timeout option schemas and their existing semantics.
- `packages/opencode/test/provider/header-timeout.test.ts` already exercises timeout precedence, SSE stalls, response identity with disabled timing, diagnostics, and logger failure. Add deterministic adaptive cases there rather than creating another test harness.
- Do not add an external transport contract. The only new caller-facing surface is the provider option described in [contracts/provider-options.md](contracts/provider-options.md); it is configuration behavior, not an SDK or wire argument.

## Project Structure

### Documentation (this feature)

```text
specs/007-splash-adaptive-sse-timeout/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    └── provider-options.md
```

### Source Code (repository root)

```text
packages/core/src/v1/config/provider.ts                    # existing open-ended provider option schema
packages/opencode/src/provider/provider.ts                 # adaptive read timeout, endpoint gating, option stripping/cache key
packages/opencode/test/provider/header-timeout.test.ts     # deterministic timeout and calibration coverage
```

**Structure Decision**: Keep the implementation in the existing provider timeout owner. The schema already accepts arbitrary provider options, so no second configuration path is needed. Reuse the focused timeout suite and keep design artifacts under the feature directory.

## Existing Code Reused Unchanged

- Provider resolution and effective endpoint selection used for dispatch.
- Existing `timeoutFetch()` / `wrapSSE()` ownership, per-read abort and response stream error behavior.
- Existing header timeout and explicit request timeout composition.
- Existing retry, fallback, cancellation, and replay behavior in session processing.
- Existing request summary logger; extend its bounded fields only as needed to validate adaptive decisions.

## Validation Design

1. **Eligibility and precedence**: Verify the option is disabled by default; requires explicit `true`, a loopback HTTP(S) endpoint, and an unspecified `chunkTimeout`. Verify numeric and `false` overrides, non-loopback endpoints, and other providers retain existing behavior.
2. **Calibration arithmetic**: Use a deterministic controlled stream/clock to verify the 100 ms inclusion boundary, nonempty data requirement, five-sample rolling window, longest-sample exclusion, multiplier of exactly 10, and lower/upper clamping.
3. **Read deadline lifecycle**: Verify fewer than five qualifying samples use the existing default; recalculation does not alter an already pending read; future reads use the updated timeout; a stall still produces the established timeout error.
4. **Request isolation and controls**: Verify independent requests, retries, and compaction begin without samples from earlier requests. Verify no total generation limit, and existing header/request timeout and abort semantics remain intact.
5. **SDK boundary and cache**: Verify the option affects SDK cache separation while never reaching SDK constructors or wire requests.
6. **Diagnostics**: Verify bounded request-level calibration/threshold/outcome information and no per-chunk summary spam; logger failures remain observational.
7. **Required promotion gate**: Keep the option opt-in until separate full-context and post-compaction validation covers local-provider eligibility, retries, fallback, cancellation, and tool replay safety. Record evidence before any future default change.

## Post-Design Constitution Check

Pass. The design extends the established transport owner, relies on the dispatch-resolved endpoint, bounds calibration state to five samples, avoids SDK-option leakage, and preserves existing timeout controls and recovery ownership. The opt-in default is retained until both required validation contexts pass.

## Complexity Tracking

No constitution violations. No additional subsystem, persistence, telemetry lifecycle, or recovery layer is introduced.
