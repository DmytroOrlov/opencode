# Quickstart: Validate Splash Adaptive SSE Timeout

This guide defines validation for implementation. It does not enable the option by default. The behavior remains opt-in until the full-context and post-compaction gates below have both passed.

## Prerequisites

- Bun and repository dependencies installed.
- A deterministic fake SSE response harness; no GPU or live Splash backend is required for arithmetic and timeout-control checks.
- A model/provider configuration that explicitly sets `splashAdaptiveSseTimeout: true` and resolves to an HTTP(S) loopback endpoint for adaptive-path scenarios.

## Focused deterministic validation

From the repository root, run the existing provider timeout suite:

```sh
bun test packages/opencode/test/provider/header-timeout.test.ts
```

The focused suite should cover:

1. Option off by default; explicit opt-in plus loopback HTTP(S) required. A remote endpoint, a non-Splash provider without the option, and aliases/ports alone do not enable adaptation.
2. Explicit numeric `chunkTimeout` remains fixed and `chunkTimeout: false` disables chunk timing.
3. Reads returning empty data, EOF, rejected reads, or data in less than 100 ms do not count; a nonempty successful read at 100 ms does.
4. The latest five qualifying waits form a rolling window. Excluding one longest wait, taking the maximum of the remaining four, multiplying by 10, and clamping to 30,000 ms through the existing default produce the exact threshold.
5. Fewer than five qualifying samples retain the default threshold; recalibration affects future reads only. A currently pending read keeps its original deadline.
6. Stalled streams still produce the established response stream timeout error and preserve cancellation behavior. A long overall generation continues when each read progresses within its idle threshold.
7. Independent requests and retry attempts begin with empty calibration; option state is absent from SDK arguments and present in cache-key separation.
8. One lightweight terminal diagnostic provides sample/threshold and outcome evidence without per-chunk logging, and logger failure does not fail generation.

## TypeScript validation

From the repository root, typecheck the OpenCode package as well as running its focused tests:

```sh
bun run --cwd packages/opencode typecheck
```

This gate catches TypeScript errors in the test harness that Bun test execution does not check.

## Full-context and post-compaction promotion gates

Run and record these as separate validations before changing the default:

- **Full request context**: Exercise a complete local Splash generation with adaptive opt-in, then verify non-local and remote configurations, fixed/disabled overrides, request timeout controls, retry/fallback, cancellation, and tool replay safety retain their established behavior.
- **Post-compaction request**: Exercise a compaction followed by generation and verify the compaction request and subsequent request each begin with empty calibration. Confirm retries also reset state and that cancellation, fallback, and tool replay remain unchanged.

Both gates must pass independently. Record the tested configuration, observed request-local thresholds, terminal outcomes, and recovery/replay results. Keep `splashAdaptiveSseTimeout` disabled by default until this evidence is reviewed.

## Real-runtime validation record — 2026-10-08

### T007 — near-ceiling context: incomplete

- Runtime: `http://127.0.0.1:8000`, provider `splash38`, model `incoai/Qwen3.8-27B-Splash`; the endpoint advertised a 262,144-token context ceiling.
- Opt-in was supplied only to the `splash38` provider through process-local `OPENCODE_CONFIG_CONTENT`; the temporary model output limit was 256 tokens. No production provider configuration or code was changed.
- The first fresh OpenCode session attached a 960,131-byte text file. This did **not** produce near-ceiling context: OpenCode reported 10,732 input tokens (10,988 total; 256 reasoning; 0 output). The provider summary recorded `splashAdaptiveSseTimeoutEligible=true`, 166 successful reads, 165 chunks, 91,788.756 ms stream duration, 76.816 ms response-header wait, 2,101.096 ms maximum successful read wait, `adaptiveSampleCount=5`, `adaptiveTimingUsed=true`, `adaptiveThresholdMs=30000`, and `terminalOutcome=completed`. The CLI step ended with reason `length`.
- After that measured shortfall, one bounded retry in the same session sent 900,000 characters of positional prompt text (900,233 argument bytes) with a 20-minute process timeout. It timed out after 1,200 seconds without SSE output, token usage, or a provider terminal summary. This is a measured runtime timeout for that request; it does not establish the backend's memory limit or context capacity.
- Cancellation, retry/fallback, and tool replay safety were not exercised in real inference. Their previously reported deterministic coverage (31 provider tests and 31 processor tests) remains separate evidence and does not satisfy those real-runtime checks.
- **Result: T007 remains incomplete.** The completed request used 10,732 input tokens, far below the advertised ceiling. The subsequent near-ceiling attempt timed out without evidence to pass the acceptance criteria.

### T008 — post-compaction: NOT EXECUTED

- No genuine OpenCode compaction was observed; no compaction or post-compaction request summaries exist.
- **Result: T008 remains incomplete.** There is no real-runtime evidence for compaction or calibration reset.

T007 and T008 remain unchecked in `tasks.md` and are independently required before any default promotion. T013 is complete: deterministic acceptance coverage and the real-runtime evidence were reviewed, establishing that the opt-in implementation is ready while neither promotion gate has passed. The adaptive timeout default remains disabled.

For the request-local fields and calculation rules, see [data-model.md](data-model.md); for option compatibility, see [contracts/provider-options.md](contracts/provider-options.md).
