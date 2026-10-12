# Data Model: Splash Adaptive SSE Timeout

All entities below are ephemeral and scoped to one wrapped SSE response. No persistence or session-level calibration store is introduced.

## SSE Request Calibration

One calibration state is created for an eligible SSE response and discarded when that response completes, errors, times out, is cancelled, or its owning request ends.

| Field | Type | Rule |
|---|---|---|
| `qualifyingWaitsMs` | finite nonnegative durations, list | Rolling window containing at most the latest five qualifying waits. |
| `adaptiveTimeoutMs` | finite nonnegative duration or absent | Derived only when the window contains five samples; used for reads that begin after it is recalculated. |
| `configuredChunkTimeout` | default marker or explicit number/false | Determines fixed/default/disabled semantics; adaptive mode is eligible only when unspecified. |
| `eligible` | boolean | True only for explicit `splashAdaptiveSseTimeout: true` and an effective loopback HTTP(S) endpoint. |

### Sample qualification

A sample is added only after `reader.read()` succeeds with nonempty data and the measured wait is at least 100 ms. EOF, empty data, rejection, and faster completions do not qualify. After insertion, discard the oldest sample if the list exceeds five.

### Threshold derivation

With fewer than five samples, the read threshold remains the existing default chunk timeout. With five samples, sort only for calculation, remove one longest value, select the maximum of the four remaining values, multiply by 10, then clamp to `[30_000, existing default chunk timeout]`. Keep sample order in the rolling list for eviction. Never modify the deadline for a read already pending.

## SSE Read

Each call to `reader.read()` has its own start time and fixed deadline selected when the read begins. A newly completed qualifying read can update calibration for subsequent reads only. The read may complete with nonempty data, EOF, rejection, abort, consumer cancellation, or timeout; only successful nonempty data meeting the duration threshold feeds calibration.

## Configuration

`splashAdaptiveSseTimeout` is a provider option, valid as opt-in only when `true`. It remains an OpenCode-local control and is removed before SDK construction. It remains represented in the SDK cache key to keep opt-in and opt-out configurations distinct. Explicit numeric `chunkTimeout` and `chunkTimeout: false` take precedence and bypass adaptive behavior.
