# Quickstart: Provider Stream Liveness

The provider transport keeps generic header and chunk timeouts at 300,000 ms and defaults `opencode-go` to a 150,000 ms SSE idle-read boundary. Numeric and `false` provider options override that default. Timed SSE requests emit at most one passive terminal diagnostic summary through the existing configured logger; no summary is required when chunk timeout is disabled.

## Focused validation

From the repository root:

```sh
bun test packages/opencode/test/provider/header-timeout.test.ts
bun test packages/opencode/test/session/processor-effect.test.ts
```

The provider suite should establish:

- `opencode-go` gets the 150,000 ms default, while numeric and `false` overrides win.
- Generic defaults remain unchanged.
- `chunkTimeout: false` returns the original response with no body proxy.
- Healthy reads inside the boundary complete, and a stalled read produces the existing retryable `ResponseStreamError("SSE read timed out")`.
- A timed SSE response emits no more than one summary with available request and read-wait fields; terminal attribution distinguishes completion, timeout, explicit request abort, consumer cancellation, and other read error when transport semantics allow.
- The summary logger's failure cannot change generation behavior.

The processor regression should open a fake SSE response, stop body chunks, configure a short `chunkTimeout`, run the normal provider/session path, and verify that existing recovery dispatches an eligible fallback. A focused abort case must remain terminal with an eligible fallback. Calling `SessionRecovery` directly does not satisfy the transport integration proof.

The summary's `firstReadWaitMs` and `maxSuccessfulReadWaitMs` measure pending `reader.read()` durations, not total generation latency. Production observations of healthy transport idle gaps are future policy evidence, not deterministic acceptance tests for 006. No adaptive behavior is specified.

## Configuration override

Set `provider.opencode-go.options.chunkTimeout` to a numeric millisecond value to override 150,000 ms, or set it to `false` to disable SSE idle-read timing. The disabled path returns the original response unchanged.

## Scope

The provider wrapper remains the transport-liveness owner. No external API, persistent data model, telemetry service/store, session/recovery production change, or experimental native runtime support is added.
