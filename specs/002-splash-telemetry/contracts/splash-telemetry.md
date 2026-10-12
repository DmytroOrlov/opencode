# Splash telemetry interface contract

This contract extends the existing OpenCode provider configuration and generation telemetry flow. It does not create a new endpoint, event type, store, or UI. The protocol version is installed Splash 1.1.0 and the pinned OpenAI-compatible SDK is 2.0.41.

## Provider configuration and request boundary

- Explicit provider option: splashTelemetry: true. Default absent/false means generic fallback only. mlxTelemetry: true remains independently supported.
- splashTelemetry is an OpenCode control. It is removed before SDK constructor/cache-key creation and before inference request option conversion. It must never appear in captured SDK constructor options or the HTTP body.
- splashTelemetry modifies no part of the inference request. return_progress is an independent, real Splash protocol/request option; this feature never inserts, removes, or requires it. It reaches the wire only through ordinary provider/request configuration. Streaming remains enabled. Existing includeUsage behavior sends stream_options.include_usage: true unless explicitly disabled by existing provider settings.
- Other OpenAI-compatible providers and disabled Splash providers receive no raw observation and no added field.
- Telemetry never selects or changes the generation runtime or transport. For an enabled Splash model whose normal path is @ai-sdk/openai-compatible, the AI SDK raw-stream observer applies because that is already its normal generation path. If another runtime is the one OpenCode would otherwise select and it does not expose raw stream data, native Splash telemetry is unavailable and existing fallback behavior remains. If MLX telemetry is simultaneously enabled, existing MLX selection wins and no Splash observation is attached.

Two request bodies are valid:

A. Baseline, splashTelemetry: true with no return_progress (nothing is injected):

~~~json
{"model":"test-model","messages":[{"role":"user","content":"Hi"}],"stream":true,"stream_options":{"include_usage":true}}
~~~

B. The normal Splash request independently contains return_progress: true through provider/request configuration:

~~~json
{"model":"test-model","messages":[{"role":"user","content":"Hi"}],"stream":true,"return_progress":true,"stream_options":{"include_usage":true}}
~~~

The full body can include normal SDK fields such as tools and generation settings. Capturing the body with splashTelemetry off and on must yield the identical body. No second HTTP inference request, no retry without return_progress, and no polling are permitted.

Both cases behave the same way except for native prefill:

- **Case A** (`splashTelemetry: true`, no `return_progress`): no native prefill progress; the existing fallback supplies eligible live decode; a valid final Splash `timings.predicted_per_second` may replace the fallback at successful completion.
- **Case B** (`splashTelemetry: true` and the normal request independently contains `return_progress: true`): native request-local prefill may be displayed; the existing fallback supplies eligible live decode; a valid final Splash rate may replace the fallback at successful completion.

## Stream input accepted by the Splash observer

The observer receives AI SDK raw parts shaped as { type: "raw", rawValue: unknown } from the same fullStream that supplies normal generation events. It recognizes only validated Splash 1.1.0 Chat chunks. The SDK parser requires choices as an array, so fake-server fixtures must include it. prompt_progress frames appear only in case B; in case A they are absent and that is harmless — no native prefill is published and live decode stays on the existing fallback.

Illustrative SSE JSON following a data: prefix:

~~~json
{"id":"chatcmpl-123","object":"chat.completion.chunk","created":123,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":null}],"prompt_progress":{"total":2,"cache":1,"processed":1,"time_ms":0.0}}
{"id":"chatcmpl-123","object":"chat.completion.chunk","created":123,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":2,"cache_n":1,"prompt_ms":1.0,"prompt_per_second":1000.0,"predicted_n":5,"predicted_ms":2.0,"predicted_per_second":1500.0}}
{"id":"chatcmpl-123","object":"chat.completion.chunk","created":123,"model":"test-model","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":5,"total_tokens":7},"metrics":{"decode":{"tokens":3},"request_latency":{"first_token_to_done_ms":2.0}}}
~~~

The observer ignores unrelated raw chunks and extra fields. It never returns modified content to the normal LLMAISDK adapter. Malformed telemetry values are ignored and cannot throw into generation.

## Normalized output

When present, valid changing prompt_progress maps to the existing session.telemetry publication with current sessionID and AssistantMessage ID, phase prefill, processed, total, and source provider. cache/time_ms are validation inputs, not new displayed metrics. Updates are coalesced to the existing bounded cadence. A provider prefill publication does not suppress generic live fallback.

Terminal arbitration is based on the count of observed terminal timings, taken before any validation of predicted_per_second. With zero terminal timings observed, the native terminal rate is unavailable. With exactly one terminal timing observed, predicted_per_second is validated: a finite positive value may map on successful stream finalization to phase decode, tokensPerSecond equal to that rate, done true, source provider, and no approximate marker; a zero, absent, non-finite, or malformed value is unavailable. With more than one terminal timing observed in one OpenCode telemetry attempt, the native terminal rate is ambiguous regardless of whether one, several, or none of those timings carry a valid rate: no provider terminal rate is published and the existing fallback behavior is retained (fail closed), including the multi-request case where an earlier terminal timing carries a zero or invalid rate and a later one carries a valid rate. There is no multi-step aggregation, no averaging, no last-step substitution, and no usage-metric parsing for aggregation. A zero, absent, non-finite, malformed, or ambiguous provider rate never suppresses fallback. If the fallback has no measurable sample, no rate is displayed.

Reset, abort, retry, provider setup failure, stream failure, finalize, and discard use the existing attempt lifecycle. A late raw part after closure cannot publish. Generic and MLX paths retain their existing event contracts and behavior.

## Error and performance behavior

Telemetry parsing and publication are best-effort and may not fail or wait for generation. No /status or /metrics polling, timers at token cadence, extra request, injected request field, runtime or transport switch, or provider-specific app state is introduced. Enabling splashTelemetry must leave the inference request body and the selected generation runtime identical to the opt-off configuration. A fake stream whose normal text/tool behavior differs with telemetry enabled fails the contract.
