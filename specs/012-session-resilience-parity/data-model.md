# Data Model for Session Resilience Parity

## Global configuration resource and host reference

| Field | Meaning |
|---|---|
| Resource key | Opaque token from the effective Config filesystem’s backing-store owner paired with directory identity from that same service. The annotated platform layer supplies the local token. Transparent wrappers forward it, and distinct backends supply separate tokens. Use reliable directory device/inode or a backend-guaranteed alias-stable canonical path within that namespace. Missing or unproven identity fails startup. |
| Host target | The acquired effective Global config directory, initialized and canonically resolved by the same captured FSUtil service that Config readers and the update owner use. Equivalent names share a key within their backing namespace. The captured Global and FSUtil bindings reach the route root, ordinary locations and the SDK private selector. |
| Shared values | One `SessionGenerationAdmission.Interface` and one `FallbackRuntimeIntent.Interface` for this resource. |
| Host references | Count of live embedded graph acquisitions. Startup acquires before graph build. Disposal drains and closes host work before dropping its reference. |
| Local state | Each host retains its runtime, Config cache and observed revision, publication, events, database, plugins and locations. |

The first reference creates the pair. A later reference borrows the same pair. One release leaves the pair available while any reference survives. The last release removes the pair after owned work has settled. A later first reference starts with fresh synchronization state and reads committed bytes from disk. Graphs without an explicit resource still have local values. Temporary files and atomic replacement stay within the existing directory; there is no coordination data on disk.

## Admission and fallback revisions

| Entity | Fields and transitions |
|---|---|
| Lease waiter | ID, shared/exclusive mode, queued/active state and existing readiness deferred. A queued waiter can retire on cancellation. An active lease releases once. A queued exclusive prevents overtaking by later shared waiters. |
| Update reservation | Monotonic per-resource revision, reserved before candidate validation. The owner may validate/stage, wait for predecessors, wait for exclusive admission, revalidate and commit. Retirement on every exit unblocks successors. |
| Staged snapshot | Highest accepted staging revision and override of absent, explicit null or model/variant selection. A snapshot with no override retains the high-water revision, including after cancellation. Late older validation cannot republish that intent. |
| Committed revision | Greatest successful rename revision. Advances immediately on successful replacement, before publication. A byte-equal or rejected update never increments it. |
| Reader observation | Host-/location-local observed committed revision plus existing pending and delivery flags. A lagging protected read reconciles or fails, and checks again after suspended reload/notification. |
| Dispatch token | Staged revision and override presence. Include committed revision when the committed tier was consulted. Retry resolution if relevant state changes before dispatch. |

B enters before C, even when C validates first. A holding admission can consume C's accepted intent. B can later commit without displacing C's staged intent. C retirement clears only C's override, exposing the most recent committed value or configured default. B's superseded staged value stays retired as a runtime choice. A later D stays effective through B/C cleanup. An already dispatched attempt keeps its resolved model and variant.

## Recovery disposition and attempt

| Disposition | Preconditions and next state |
|---|---|
| Existing transport or overflow recovery | Existing full-transport and context-overflow branches take precedence and retain their compaction/continuation limits. An overflow failure is excluded from model failover even if compaction cannot run. |
| Ordinary retry | Session retry hook and schedule authorize another ordinary attempt. Publish existing retry status, wait, then resolve distinct fallback as today or use the original primary snapshot if none qualifies. |
| Distinct-only restart | Classified failure, no ordinary retry, and no unsafe or durable current-attempt work requiring continuation. Settle the failed physical attempt and resolve a distinct fallback with a fresh assistant. |
| Distinct-only continuation | Classified failure, no ordinary retry, with known durable settled tools and replay-safe history. Settle the failed attempt, load history for the fallback, carry tool results and use a fresh assistant. |
| Terminal | Cancellation, blocked or unknown work, an inapplicable failure, or no eligible candidate for a distinct-only recovery. Unknown executing-tool effects bar both ordinary retry dispatch and distinct-only recovery when dispatch would replay or continue from unresolved work. Retain the original failure/cause and settlement path. |
| Attempted identity set | Transient set credited at actual generation dispatch, keyed by provider plus model with variant excluded from identity. Carry it through tool continuations and actual session move/reload or Location handoff in the same active turn. Reset at the boundary of a genuinely new turn. Preserve model and variant on each attributed physical attempt. |

The step captures provider/tool facts before synthetic cleanup. Store only transient recovery facts and the original exit. Include the initial primary in the attempted identity set. Same-model retries remain governed by the ordinary policy.

## Terminal SSE transport summary

Use milliseconds for durations and distinguish absence from actual zero. Record transport data at the physical HTTP SSE execution. A new execute, retry or fallback gets fresh state.

| Field | Value and provenance |
|---|---|
| `terminalOutcome` | `completed`, `timeout`, `abort`, `consumer_cancel`, or `other_error`. Written once at classification. |
| `responseHeaderWaitMs` | Existing execute-to-headers interval measured by Effect Clock. |
| `sseStreamDurationMs` | Response establishment to terminal observation, excluding detached log delivery. |
| `firstReadWaitMs` | First byte pull's observed wait. May be the elapsed time of an ending in-flight first pull. Absent before any pull. |
| `maxSuccessfulReadWaitMs` | Maximum observed successful pull wait, absent until a successful pull outcome. A naturally observed EOF is a read with no chunk. |
| `successfulReadCount`, `chunkCount` | Completed reads, including observed natural EOF, and returned byte chunks respectively. A pull can deliver several byte chunks. Empty byte elements count as delivered chunks but cannot calibrate the timer. Counters start at zero. |
| `splashAdaptiveSseTimeoutEligible`, `adaptiveSampleCount` | Existing opt-in/origin/explicit-limit decision and current qualifying window size, 0–5. |
| `readDeadlineSource`, `readDeadlineMs` | Last selected per-pull basis and limit, using the stalled pull for an idle timeout. Source is fixed default, explicit, disabled, adaptive initial or adaptive calibrated. Absent before selection, with no numeric limit for disabled. |
| `adaptiveBasisWaitMs` | Second slowest of the five samples used for the selected calibrated read. Absent for other sources. A fifth sample can qualify before a calibrated deadline has actually been selected. |
| `timeoutReadWaitMs` | Elapsed wait for the active pull at the winning timeout, when there was a pending read. |
| `timeoutSource` | Per-read idle limit or whole-request completion limit when the local timeout branch won. A total timeout reports the selected read threshold separately from the timer that won. |

State transitions from established to reading and then to terminal. A successful protocol acknowledgement can complete an early-finishing stream even when HTTP EOF was never consumed. An explicit abort visible at classification wins over downstream cancellation. Closing an unfinished stream with no terminal acknowledgement, EOF or failure produces consumer cancellation. An Effect request interruption can produce abort through the owning scope's interrupt exit. No row exists for a request that failed before establishing an SSE execution.
