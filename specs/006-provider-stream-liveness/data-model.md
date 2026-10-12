# Data Model: Provider Stream Liveness

No persisted entity or public protocol is added. Timed SSE requests maintain a bounded, request-local diagnostic summary in the existing provider transport wrapper and submit it once at termination to the configured logger.

## Request-local terminal summary

| Field | Meaning |
|---|---|
| `requestHost` | Non-secret URL host, when parseable |
| `responseHeaderWaitMs` | Elapsed time from fetch start until response headers |
| `firstReadWaitMs` | Duration of the first pending `reader.read()` |
| `maxSuccessfulReadWaitMs` | Longest read duration that completed successfully |
| `successfulReadCount` | Number of completed reads, including end-of-stream when observed |
| `chunkCount` | Number of non-terminal body chunks delivered |
| `sseStreamDurationMs` | Time from response receipt to terminal stream outcome |
| `configuredChunkTimeout` | Effective numeric idle-read timeout for this request |
| `terminalOutcome` | `completed`, `timeout`, `abort`, `consumer_cancel`, or `other_error`, where distinguishable |
| `timeoutReadWaitMs` | Elapsed duration of the read that timed out; present only on timeout |

The timing fields use the provider transport's read boundaries; they do not represent total model-call duration. The accumulator is discarded after one best-effort terminal log attempt. Logging failure does not change the transport result. When `chunkTimeout: false` (or no positive numeric timeout) is effective, the original `Response` is returned without a controller, body proxy, or required summary.
