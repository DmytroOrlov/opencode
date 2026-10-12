# Research: Provider Stream Liveness

## Decision 1: Keep timeout ownership in the provider fetch wrapper

**Decision**: Continue using `timeoutFetch()` for response-header and SSE idle-read liveness. Do not add a session watchdog or a new error type.

**Rationale**: `packages/opencode/src/provider/provider.ts` wraps provider fetch and applies `wrapSSE()` to timed SSE responses. A stalled read raises the existing `ProviderError.ResponseStreamError("SSE read timed out")`. `resolveSDK()` installs this wrapper and removes OpenCode timeout controls before SDK construction. Existing retry and recovery owners handle the resulting failure.

**Alternatives considered**: A session semantic-progress timer, polling, or a second retry controller. Rejected because the reproduced failure is transport silence and existing transport and recovery owners cover the required behavior.

## Decision 2: Use a static 150,000 ms idle-read default only for `opencode-go`

**Decision**: Preserve generic `headerTimeout` and `chunkTimeout` at 300,000 ms and use the provider options/default merge seam for `opencode-go` `chunkTimeout: 150_000` ms. Explicit numeric and `false` config values remain authoritative.

**Rationale**: The incident had received headers and then stopped yielding stream data, so the idle-read timeout is the relevant boundary. Session-level observations around 62, 74, 81, and 89 seconds are not proven raw SSE idle gaps. They reject a 90-second default that sits too close to the observed tail, but do not justify adaptive transport timing. 150 seconds leaves headroom above that observed tail while reducing the generic five-minute wait for the incident provider.

**Alternatives considered**: A global reduction, changing the header timeout, retaining five minutes, or adding adaptive runtime state. A global change has broader compatibility impact; header timing does not match this failure; five minutes leaves the incident waiting too long; and the available observations do not establish a raw idle-gap distribution for an adaptive policy.

## Decision 3: Include passive transport diagnostics in 006

**Decision**: For each timed SSE response, retain a bounded request-local accumulator and emit at most one terminal summary through the existing configured OpenCode logger. Measure pending `reader.read()` duration; do not use total model-call latency as a liveness signal.

**Rationale**: A static timeout is evidence-sensitive. Production measurements must show whether healthy SSE idle gaps approach the configured timeout or whether only total generation latency grows. The current transport owner has direct access to the read boundaries and request host. `wrapSSE()` already submits the summary through the `Effect.logDebug` bridge, catches synchronous logger errors, and swallows rejected logging promises. There is no per-read log, persistent store, UI telemetry path, or generation control state.

The summary includes `requestHost` where parseable, `responseHeaderWaitMs`, `firstReadWaitMs`, `maxSuccessfulReadWaitMs`, `successfulReadCount`, `chunkCount`, `sseStreamDurationMs`, `configuredChunkTimeout`, `terminalOutcome`, and `timeoutReadWaitMs` on timeout, where available. Terminal outcomes distinguish completion, timeout, explicit request abort, consumer cancellation, and other read error where transport semantics allow.

**Alternatives considered**: Excluding all observability, adding per-chunk logs, introducing a telemetry service/store, or persisting metrics. Excluding it would prevent evaluation of the timeout policy against real transport gaps; the other options add unnecessary volume, infrastructure, or state.

## Decision 4: Preserve the disabled-timeout fast path

**Decision**: When no positive numeric `chunkTimeout` exists, do not create a chunk timeout controller and return the original response unchanged without calling `wrapSSE()`.

**Rationale**: The provider implementation already follows this path for `false` and other non-positive/non-numeric values. The response body remains unproxied and no timed SSE summary is required, as specified.

## Decision 5: Reuse the existing logger and recovery behavior

**Decision**: Use the configured Effect logger bridge for the terminal summary, preserve the existing timeout error, and leave retry/recovery production code unchanged.

**Rationale**: The logger path is structurally passive and failure-isolated. `SessionRetry` recognizes the timeout, `SessionRecovery` owns fallback decisions, and the processor applies them. The processor integration test proves the real transport timeout reaches eligible fallback dispatch. Explicit request abort remains terminal; provider tests distinguish request abort from consumer cancellation for diagnostic attribution.

**Alternatives considered**: Directly calling `SessionRecovery` from the integration test, changing retry/recovery code without a demonstrated defect, or adding a logger/metrics subsystem. These do not strengthen the transport proof and would broaden scope.

## Verified path and future policy boundary

The incident uses the ordinary provider SDK path: `Provider.getLanguage()` → `resolveSDK()` → SDK fetch → `timeoutFetch()` → `wrapSSE()`. The provider source includes the `opencode-go` 150,000 ms default and passes a summary logger into custom provider initialization. The focused provider test covers provider default/override precedence, response identity when disabled, healthy/stalled reads, and request-abort versus consumer-cancellation attribution. The processor test covers stalled SSE recovery and explicit abort with eligible fallback.

Future policy review may compare healthy `firstReadWaitMs` and `maxSuccessfulReadWaitMs` with the configured timeout. If healthy transport idle gaps remain small while total call duration grows, retain a static timeout. If real healthy transport gaps materially grow with long sessions or context, that evidence may justify a separate bounded adaptive-timeout feature. No adaptive algorithm or state is designed in 006.

## Scope exclusions

No persistent data model, public contract, telemetry service/store, UI telemetry, adaptive timeout state, session/recovery abstraction, public timeout key, or native runtime support is required. The exported session observations are not treated as transport timing guarantees.
