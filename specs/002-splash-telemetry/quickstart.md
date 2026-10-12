# Quickstart: validate Splash telemetry implementation

This is a future implementation validation guide. The planning step creates no runtime code or tests. Protocol fixtures and expected event shapes are specified in [contract](contracts/splash-telemetry.md); state and arbitration rules are in [data model](data-model.md).

## Prerequisites

- Use this exact checkout and its bun.lock versions: ai 6.0.168, @ai-sdk/provider 3.0.16, @ai-sdk/openai-compatible 2.0.41.
- Use a protocol-faithful local fake Chat Completions SSE server. A GPU or live Splash instance is not required.
- Reuse packages/opencode/test/lib/llm-server.ts and packages/opencode/test/fake/provider.ts where appropriate.
- If doing optional live smoke validation, Splash 1.1.0 is the version researched here. Recheck protocol before extrapolating to another release.

## Validation sequence

1. **Request and SDK parsing gate**: Configure splashTelemetry: true on a Splash OpenAI-compatible provider and capture both SDK constructor options and the HTTP body with the opt-in off and on. Confirm the OpenCode-only control is absent from both captures; confirm the captured body is byte-identical with the opt-in off versus on (no return_progress injected, no field removed); confirm stream true and the existing include_usage behavior. Feed the exact choices-bearing progress, finish, usage, and [DONE] frames from the contract. Confirm the installed SDK accepts them and fullStream emits raw parts while normal text/tool output remains unchanged. Confirm generation runtime selection is identical with the opt-in off versus on, including with experimental native dispatch enabled: telemetry must not redirect native to AI SDK. With mlxTelemetry simultaneously enabled, confirm MLX wins and no Splash observation is attached.
2. **Prefill and live fallback, cases A and B**: Run case A with splashTelemetry: true and no return_progress. Confirm no prompt_progress frames are required, no native prefill appears, nothing is published for prefill, and the existing fallback supplies eligible live decode. Run case B where the normal request independently contains return_progress: true. Emit valid prompt_progress then repeated, regressing, non-advancing, negative, non-finite, missing, and inconsistent variants. Confirm only validated advancing progress appears on the current AssistantMessage and publications are coalesced, and that absence of prompt_progress is harmless. In both cases emit decode text long enough for the existing fallback sample; confirm provider prefill did not disable its approximate live rate.
3. **Terminal arbitration**: Finish with one terminal timing carrying a valid positive predicted_per_second; confirm the single provider rate replaces fallback at successful completion. Repeat with one terminal timing carrying a zero, missing, malformed, and non-finite rate; in each case confirm the native terminal rate is unavailable and fallback is retained. Emit more than one terminal timing within one attempt and confirm it fails closed regardless of rate validity, including a first terminal timing with a zero/invalid predicted_per_second followed by a second with a valid predicted_per_second: no provider-native terminal rate is published and fallback is retained. Confirm the collector counts every recognized terminal timing before rate validation. Confirm fallback is retained only when it has a measurable sample and no unavailable 0 tok/s is displayed. Force stream failure after a timing frame and confirm no provider terminal success.
4. **Lifecycle and attribution**: Retry the same AssistantMessage after terminal state; confirm reset removes stale state. Test abort, provider setup failure, stream failure, and raw callbacks after discard. Run two concurrent fake Splash streams with distinct progress/rates and confirm neither can affect the other's message.
5. **Tool and step semantics**: In the pinned SDK default one-step path, stream a tool call and verify its timing belongs to that provider request while the next outer OpenCode turn has a new AssistantMessage. Confirm the collector stays step-local (prefill resets on start-step) without any multi-step rate aggregation.
6. **Regressions**: Run existing MLX /events lifecycle and arbitration tests unchanged, existing generic fallback tests, provider sanitization tests, app telemetry reducer tests, and session-ui formatting tests. Verify non-Splash OpenAI-compatible providers receive no new request field.

## Commands after tests exist

From repository root:

~~~sh
bun test packages/opencode/test/session/splash-telemetry.test.ts
bun test packages/opencode/test/session/mlx-telemetry.test.ts packages/opencode/test/session/fallback-telemetry.test.ts
bun test packages/opencode/test/session/llm.test.ts packages/opencode/test/provider/provider.test.ts
bun test packages/app/src/context/global-sync/event-reducer.test.ts packages/session-ui/src/components/generation-telemetry.test.ts
~~~

Use the repository's normal typecheck command for the touched packages during implementation. The new Splash test path above is a proposed test target and does not exist in this planning step.

## Pass condition

The fake stream generates the same text/tool events, the same inference request body, and the same generation runtime with telemetry on and off. Enabled Splash shows native prefill only when prompt_progress is independently present (case B), always retains eligible live fallback, and shows a valid native terminal decode rate only when exactly one terminal timing was observed at successful completion and its predicted_per_second is finite and positive. Zero terminal timings, or exactly one terminal timing with an unusable rate, leaves the native terminal rate unavailable and fallback eligible. More than one terminal timing observed in one attempt fails closed to fallback regardless of how many of those timings hold a valid rate. Unusable native data preserves eligible fallback; a generation too short for either sample shows no rate. Retries, failure, abort, late callbacks, and concurrency never misattribute or leave stale successful terminal telemetry. MLX and generic-provider regressions pass unchanged.
