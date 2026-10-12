# Research: Splash Adaptive SSE Timeout

## Decisions

### 1. Extend the existing provider transport owner

- **Decision**: Implement adaptive timeout selection inside the existing `timeoutFetch()` / `wrapSSE()` path in `packages/opencode/src/provider/provider.ts`.
- **Rationale**: `timeoutFetch()` already owns timeout option resolution and signal composition. `wrapSSE()` already owns the pending `reader.read()` timer, monotonic wait measurement, reader cancellation, and established response stream timeout error. This is the smallest seam that can change per-read deadlines without adding a second watchdog.
- **Alternatives considered**: Session-level generation timers and a separate transport wrapper. They would duplicate existing ownership, risk measuring total generation time, and complicate cancellation/retry semantics.
- **Repository evidence**: `timeoutFetch()` and `wrapSSE()` in `packages/opencode/src/provider/provider.ts`; existing timeout behavior in `packages/opencode/test/provider/header-timeout.test.ts`.

### 2. Require explicit local Splash opt-in and a dispatch-resolved loopback HTTP(S) endpoint

- **Decision**: Add the provider option `splashAdaptiveSseTimeout: true`. Adaptive behavior is disabled by default and eligible only when the option is true and the effective dispatch endpoint uses HTTP(S) with a loopback host. Do not infer Splash from hostname, aliases, or port.
- **Rationale**: Hostnames and ports do not identify provider intent. The explicit option is the declaration that this provider is local Splash; checking the effective endpoint additionally prevents applying adaptive behavior to a remote endpoint configured under that declaration.
- **Alternatives considered**: Enabling for all loopback providers, matching provider aliases, and inferring by common ports. These are ambiguous and can affect unrelated providers.
- **Repository evidence**: `effectiveBaseURL()` and `resolveSDK()` in `packages/opencode/src/provider/provider.ts` supply the endpoint used by provider dispatch. `packages/core/src/v1/config/provider.ts` accepts provider options through open-ended `StructWithRest` records.

### 3. Keep the option out of SDK arguments and in SDK cache identity

- **Decision**: Read the option from provider configuration and remove it from SDK factory options after forming the cache key, matching the existing handling of local controls.
- **Rationale**: The setting controls OpenCode transport behavior and is not an SDK feature. Retaining it in the hashed option set prevents enabled and disabled configurations from reusing the same cached SDK instance.
- **Alternatives considered**: Passing the option to the SDK or stripping it before hashing. The first leaks an unsupported local control; the second collapses distinct configurations into one cache identity.
- **Repository evidence**: `resolveSDK()` in `packages/opencode/src/provider/provider.ts` hashes provider options and removes `chunkTimeout`, `headerTimeout`, and telemetry-only keys before SDK construction.

### 4. Use request-local bounded calibration with a conservative warm-up

- **Decision**: Keep the last five successful, nonempty read waits of at least 100 ms per SSE request. Until five samples exist use the existing default chunk timeout. At five samples, exclude one longest sample, multiply the maximum of the other four by 10, clamp to 30,000 ms through the existing default timeout, and use recalculation only for reads that start later.
- **Rationale**: This directly encodes the requested robust cadence estimate, avoids buffered-read noise and unbounded state, and preserves conservative behavior until enough evidence is available.
- **Alternatives considered**: Mean/median, lifetime history, including EOF, or updating a pending timer. Those diverge from the specified estimator, request isolation, sample semantics, or deadline stability.
- **Repository evidence**: `wrapSSE()` already times each read with `performance.now()` and scopes the reader/body wrapper to one response. Each fetch attempt obtains a new response wrapper.

### 5. Preserve fixed/disabled timeout controls and existing recovery paths

- **Decision**: Adaptive selection is eligible only when `chunkTimeout` is unspecified. Numeric values remain fixed and `false` disables chunk timing. Leave header and explicit request timeout composition unchanged; retain the existing read timeout error and abort/cancel path.
- **Rationale**: Existing explicit controls are compatibility contracts, and the transport error is already consumed by established recovery behavior.
- **Alternatives considered**: Treating an explicit value as the adaptive ceiling or using the algorithm to replace it. Both change caller-configured semantics.
- **Repository evidence**: `timeoutFetch()` applies existing configured timeout values and `header-timeout.test.ts` covers numeric, disabled, and stalled-stream behavior.

### 6. Keep diagnostics aggregated and promotion validation separate

- **Decision**: Report bounded request-level evidence sufficient to inspect qualifying sample count, chosen threshold, and terminal timeout outcome. Do not emit logs per chunk. Keep the option opt-in until separate full-context and post-compaction validation passes.
- **Rationale**: Diagnostics should allow behavior validation without creating log churn or changing generation outcome. Full request and compaction paths can exercise lifecycle interactions that isolated transport tests cannot establish.
- **Alternatives considered**: Per-read logging, automatic default enablement after unit tests, or treating transport-only tests as sufficient for the default gate.
- **Repository evidence**: The existing request-summary logger is best-effort in `wrapSSE()`; the current test file already captures one terminal summary for the request.
