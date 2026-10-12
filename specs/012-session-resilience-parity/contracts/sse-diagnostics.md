# SSE terminal diagnostic contract

**Coverage** FR-004–006 and SC-002.

One attempt to emit the structured debug message `provider SSE transport summary` per established HTTP SSE execution. Use the [data model](../data-model.md#terminal-sse-transport-summary) for fields and units. Read timing is client-observed and independent of Splash/MLX provider telemetry. No credentials, response bodies, full URL, prompt or session data are required. The existing Promise `signal`, iterator teardown and Effect stream semantics remain the input contract.

| Terminal evidence at classification | Outcome |
|---|---|
| Explicit request abort already signaled, including when downstream cancellation is also present | `abort` |
| Local deadline failure that ended the stream | `timeout` |
| Owning Effect request scope interrupted | `abort` |
| Winning non-timeout transport or framing failure | `other_error` |
| Normal body exhaustion or successful protocol completion acknowledgement | `completed` |
| Downstream returns or short-circuits an unfinished response without failure | `consumer_cancel` |

An internal pending pull interrupted by downstream close does not establish request abort. A successful protocol route may stop at a terminal event before underlying byte EOF. HTTP SSE implements the existing optional `TransportExecution.complete` and the route acknowledges successful protocol consumption through it before final classification. A failing request, including header timeout or rejected status before the SSE transport is established, owes no summary. The outcome freezes at synchronous classification, so teardown signals arriving afterward cannot revise it or initiate a second attempt.

Keep response setup and per-read scheduling unchanged. Snapshot the selected deadline at pull start, before that pull can add a calibration sample. Qualifying nonempty pulls of at least 100 ms contribute to a five-sample sliding window. Exclude the slowest when computing the basis, use the 10× multiplier, and clamp to 30–300 seconds. Existing same-loopback-origin and opt-in checks apply, and explicit chunk settings override adaptive timing. Disabled limits remain disabled. A whole-request timer remains separate from the selected idle limit.

The HTTP transport owns an Effect-native diagnostic sink. Schedule one detached Effect invocation after recording the immutable snapshot and absorb sink failures and defects. The default uses Effect debug logging. Any Promise-returning host or test callback is adapted in `packages/ai/src/index.ts`. That adapter guards synchronous throws, handles rejections immediately and completes its Effect after handing off the summary. A still-pending Promise retains no waiting Effect fiber, reader, timer or response scope. Output and cleanup are independent of delivery. Each summary receives one attempt and no retries.
