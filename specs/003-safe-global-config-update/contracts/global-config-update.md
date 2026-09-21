# Contract: Global Configuration Update and Generation Admission

## HTTP contract

**Endpoint**: Existing `PATCH /global/config` request schema and response shape remain unchanged.

**Request behavior**:

1. The request enters the process-wide exclusive FIFO queue before config parsing/merge/decode or effective mutation.
2. Waiting is interruptible. Cancellation and grant compete in one atomic `queued -> cancelled` or `queued -> granted(writer-token)` transition. If cancellation wins, it removes the queued writer and triggers admission reevaluation; no config mutation occurs.
3. If grant wins, the writer token transfers atomically to the protected application. A disconnect cannot abandon the granted token or interrupt the protected update and lifecycle sequence.
4. Each request applies separately in queue order. Payloads are not coalesced; each merge uses the preceding successful committed config.
5. A no-op update returns through the existing success contract and does not dispose instances.
6. A changed update returns success only after atomic persistence, config cache invalidation, process-wide old-instance eviction, and cleanup attempts for all selected entries.

**Errors**:

- Existing schema/config validation failures retain the current typed `400` behavior where applicable.
- Persistence or unexpected application defects retain the existing generic JSON `500` boundary and error reference.
- No busy/`409` response is introduced.
- A failure before atomic replacement leaves the old file/config effective.
- After replacement commits, recovery is forward-only. Cleanup defects are logged after all cleanup attempts and do not restore old config when consistency has been established.

**Explicit disposal**: `POST /global/dispose` (or current route/method as declared by the API) retains its intentionally destructive behavior and is outside this feature's protection guarantee.

## Internal admission contract

- V1 and V2 generation work acquire shared leases from the same gate used by config writers.
- Existing admitted readers can finish while a writer waits.
- Once the writer is queued, later readers cannot overtake it.
- A queued writer receives exclusive ownership only after earlier readers drain; no new reader enters while the writer is active.
- When the queue head is a reader, all contiguous readers before the next writer may be admitted as a batch.
- Cancelling a queued reservation removes it immediately and reevaluates the new queue head.
- Lease release is idempotent.
- Reservation grant and cancellation are mutually exclusive terminal outcomes. A granted lease has explicit reservation-owned, work-owned, and released ownership states; interruption before transfer releases it exactly once, and after transfer the original requester cannot release work-owned admission.
- Queue state is in-memory only and is discarded at process shutdown.

## Consistency boundary

Exclusive ownership spans the complete mutating `Config.updateGlobal()` operation and, if changed, the required process-wide lifecycle invalidation. It is released only when either (a) pre-commit failure has preserved the prior effective state, or (b) post-commit forward consistency is established. A writer cancelled before grant is removed with no mutation. A writer granted first transfers its token to protected application, which completes and releases it even if the caller disconnects.
