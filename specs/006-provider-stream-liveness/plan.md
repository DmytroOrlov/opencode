# Implementation Plan: Provider Stream Liveness

**Branch**: `006-provider-stream-liveness` | **Date**: 2026-10-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification and clarification decisions in `specs/006-provider-stream-liveness/spec.md`.

## Summary

Keep generic `headerTimeout` and `chunkTimeout` at 300,000 ms. Apply an `opencode-go` provider-specific `chunkTimeout` default of 150,000 ms through the existing provider options/default merge path; explicit numeric and `false` values remain authoritative. Keep `timeoutFetch()` / `wrapSSE()` as the transport-liveness owner and preserve `ProviderError.ResponseStreamError("SSE read timed out")`, `SessionRetry`, and `SessionRecovery` behavior.

For timed SSE responses, emit at most one passive terminal diagnostic summary through the existing OpenCode logging path. It measures pending `reader.read()` waits and reports request host, header wait, first read wait, longest successful read wait, read/chunk counts, SSE duration, configured timeout, terminal outcome, and timeout read wait when applicable. It is request-scoped and bounded; it adds no persistent storage or control state. This diagnostic is part of 006 because production evidence must distinguish healthy transport idle gaps from growing total model latency. It does not implement adaptive timeout behavior.

The expected production surface remains `packages/opencode/src/provider/provider.ts`; focused validation remains in the existing provider timeout and session processor suites. No production changes are planned for `session/retry.ts`, `session/recovery.ts`, or `session/processor.ts` absent a demonstrated defect.

## Technical Context

**Language/Version**: TypeScript; repository runtime uses Bun and Effect.

**Primary Dependencies**: Existing provider SDK integration, `timeoutFetch()` / `wrapSSE()`, the configured Effect logger bridge, `SessionRetry`, and `SessionRecovery`.

**Storage**: No persistent storage. A summary exists only for the lifetime of one timed SSE request and is handed to the configured logger once at termination.

**Testing**: Focused deterministic Bun tests in `packages/opencode/test/provider/header-timeout.test.ts` and `packages/opencode/test/session/processor-effect.test.ts`.

**Target Platform**: OpenCode server provider and session-generation runtime.

**Performance Goals**: Detect a silent `opencode-go` SSE stream within the 150,000 ms default while preserving per-read timeout semantics. Summary construction and best-effort logging must not delay, fail, or change generation.

**Constraints**: Generic header and chunk defaults remain 300,000 ms; `opencode-go` defaults to 150,000 ms. Explicit numeric and `false` overrides remain authoritative. No public config key, per-chunk/token logging, persistent metrics, telemetry service/store, adaptive timeout state, session watchdog, semantic-progress timer, polling, health probe, second recovery path, or native runtime work. When chunk timing is disabled, return the original response unchanged.

**Scale/Scope**: Production work is limited to `packages/opencode/src/provider/provider.ts`; tests stay in the named provider and processor suites; generated design artifacts stay in this feature directory.

## Verified Transport Path and Design Decisions

- The incident path uses the ordinary provider fetch path: `Provider.getLanguage()` → `resolveSDK()` → `timeoutFetch()` → `wrapSSE()`. `resolveSDK()` installs the timeout wrapper and removes OpenCode timeout controls before SDK construction. The `opencode-go` default is provided through the existing provider options/default merge seam.
- Generic `headerTimeout` and `chunkTimeout` remain `300_000` ms. `opencode-go` receives `chunkTimeout: 150_000` ms. Explicit numeric and `false` config values are reapplied after provider defaults and remain authoritative.
- `timeoutFetch()` creates no chunk timeout controller for `false` (or any value that is not a positive number), and returns the original `Response`; `wrapSSE()` is not called. This disabled path preserves response identity and avoids a body proxy.
- With a positive timeout and SSE response, `wrapSSE()` measures each pending `reader.read()` with a monotonic clock. It emits one summary on completion, timeout, abort, consumer cancellation, or other read error, according to outcomes the transport can distinguish. The summary contains the non-secret request host where parseable and the fields required by FR-009. It has no per-read logging; read waits are aggregated in memory for the request.
- The terminal summary is submitted through the existing configured OpenCode logger (`Effect.logDebug`) via the Effect bridge. The call is best-effort: synchronous throws are caught and rejected logging promises are swallowed. It does not participate in timeout, retry, cancellation, fallback, or output decisions.
- Timeout behavior remains `ProviderError.ResponseStreamError("SSE read timed out")`; retry classification and fallback dispatch remain owned by `SessionRetry` / `SessionRecovery`. A stalled SSE request must traverse the normal processor path to prove eligible fallback dispatch. Explicit abort remains terminal, and request abort and consumer cancellation retain separate diagnostic attribution when the transport exposes the distinction.
- Session-level observations around 62, 74, 81, and 89 seconds were not proven raw SSE idle gaps. They support the 150-second static default as a safer boundary than 90 seconds, but do not establish a need for adaptation. Future policy review may compare healthy `firstReadWaitMs` / `maxSuccessfulReadWaitMs` against the configured timeout: if those gaps remain small while total latency grows, retain a static timeout; if healthy transport gaps materially grow with long sessions/context, consider a separate bounded adaptive-timeout feature. 006 specifies no adaptive algorithm or runtime state.

## Constitution Check

- **Principle I, Upstream- and Protocol-First Reuse**: Pass. Use the existing provider transport wrapper and configured logger; do not add another liveness owner or logging subsystem.
- **Principles II–IX, telemetry contracts**: Pass where applicable. This request-scoped transport diagnostic is not generation telemetry: it creates no attempt/session store, event, UI path, polling, or persistence and cannot fail generation.
- **Principle X, Minimal, Evidence-Driven Change**: Pass. One provider implementation file and the two focused existing test suites cover the timeout default, diagnostic behavior, and recovery integration.
- **Principle XI, Performance and UI Stability**: Pass. No UI updates or per-chunk logging; aggregation is bounded to one request and one terminal summary.
- **Principle XII, Governance**: Pass. No constitution change is needed.

**Gate result**: Pass. The diagnostics are explicitly within the transport-liveness boundary and remain passive; timeout and recovery ownership do not change.

## Project Structure

### Documentation (this feature)

```text
specs/006-provider-stream-liveness/
├── plan.md
├── research.md
├── data-model.md
└── quickstart.md
```

No public `contracts/` artifact is needed. The summary is internal diagnostic logging, not a public interface. `data-model.md` records its request-local shape; it is not persisted.

### Source Code (repository root)

```text
packages/opencode/src/provider/provider.ts                 # provider timeout default and passive terminal summary
packages/opencode/test/provider/header-timeout.test.ts     # timeout policy, diagnostic, and disabled-path coverage
packages/opencode/test/session/processor-effect.test.ts    # transport-to-recovery integration and abort behavior
```

**Structure Decision**: Keep timeout policy and transport diagnostics together in the existing provider transport owner. Use the existing logger bridge. Reuse provider and processor test suites; do not add a telemetry framework or alter session/recovery production modules.

## Existing Code and Tests Reused Unchanged

**Production code reused unchanged**:

- Existing `timeoutFetch()`, `wrapSSE()`, SDK setup, and provider option merge path in `packages/opencode/src/provider/provider.ts`.
- Existing `Effect.logDebug` logger path and bridge for best-effort summary emission.
- Retry classification and recovery decisions in the existing session retry/recovery/processor path.
- Existing 005 live fallback intent, bounded failover, replay/tool safety, and cancellation behavior.

**Focused tests to retain or extend**:

- `packages/opencode/test/provider/header-timeout.test.ts`: generic timeout defaults, `opencode-go` 150,000 ms default and override precedence, disabled response identity/unwrapped body, healthy reads, stalled-read error, summary fields and terminal outcomes, and non-failing logging behavior by construction.
- `packages/opencode/test/session/processor-effect.test.ts`: real transport timeout reaches normal recovery and dispatches eligible fallback; explicit abort with eligible fallback remains terminal.
- Existing retry/recovery tests continue to cover classification and policy. Do not duplicate the 005 replay/tool-safety matrix.

Consumer cancellation and explicit request abort must be distinguishable in provider diagnostics where transport semantics permit; focused provider coverage is sufficient for that attribution. Do not build persistent log capture or a custom telemetry test framework solely to inspect logger plumbing when best-effort isolation is established structurally.

## Validation Design

1. **Policy and precedence** (`header-timeout.test.ts`): assert `opencode-go` defaults to `150_000`, explicit numeric and `false` values win, and generic defaults remain `300_000`.
2. **Disabled fast path**: assert no positive `chunkTimeout` means no chunk timeout controller, no `wrapSSE()` body proxy, and the original `Response` is returned unchanged.
3. **Transport behavior and summary**: retain healthy delayed-read and stalled-read tests. Assert a stalled read still raises the existing retryable `ResponseStreamError`. Verify one terminal summary includes applicable required values, times pending reads rather than model-call duration, and distinguishes completion, timeout, request abort, consumer cancellation, and other read error where observable.
4. **Logging isolation**: preserve the summary's fire-and-forget, caught logging path. No logging exception or rejection may alter the stream outcome; validate through a focused structural/failure case only if the existing harness can inject the configured logger without adding persistent capture infrastructure.
5. **Recovery integration** (`processor-effect.test.ts`): run a real provider/processor request against an open, silent fake SSE response using a short timeout. Assert the existing timeout failure reaches ordinary recovery and an eligible fallback is selected; do not call `SessionRecovery` directly as a substitute.
6. **Cancellation**: retain the focused processor case proving explicit abort with eligible fallback remains terminal and the provider tests proving request abort and consumer cancellation have distinct diagnostic outcomes.

Real long-session transport-gap distributions are future operational evidence, not deterministic acceptance tests for 006. Total model latency must not be used as a transport liveness signal.

## Complexity Tracking

No new subsystem, persistent state, or recovery abstraction is introduced. One bounded request-local accumulator feeds one best-effort terminal log entry.

## Post-Design Constitution Check

Pass. Generic defaults, provider-specific default, and override precedence remain explicit; the disabled fast path returns the original response; the provider wrapper remains the liveness owner; the existing logger is used without making generation depend on it; and retry/recovery/session production ownership remains unchanged. Adaptive timeout behavior and the experimental native runtime remain out of scope.
