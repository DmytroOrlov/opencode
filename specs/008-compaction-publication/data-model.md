# Data model and crash visibility — Feature 008

## Optional schema extensions (concrete proposal)

```ts
// On SessionV1.User; omitted on ordinary users and legacy records.
// String-valued for extensibility; known values: "compaction" and
// reserved "recovery-preparation". Any present value is synthetic.
origin?: string

// On SessionV1.CompactionPart; absence retains LEGACY meaning.
publication?:
  | { state: "queued" }
  | { state: "preparing" }
  | { state: "abandoned" }
  | { state: "published"; summaryID: MessageID }

// Existing tail_start_id?: MessageID is independent of publication.
```

`U.id` is the durable synthetic operation identity and publication owner. `origin: "compaction"` remains distinct from genuine users; `origin: "recovery-preparation"` is reserved for future recovery preparation. Unknown future origin strings remain synthetic and must never be treated as ordinary prompts. Strict legacy identity requires both absent `U.origin` and absent `P.publication`; only those pairs use legacy compatibility and scheduling rules. Explicit synthetic origin with absent publication metadata is malformed new-format state, never legacy. Ordinary new scheduling accepts only `origin: "compaction"` with `publication.state:"queued"`; recovery-preparation and unknown origins never enter ordinary scheduling or generation. No recovery writer, generation fallback, or attempt state is implemented in 008.

## Pair validity

A candidate is authoritative if and only if:

- **Legacy**: U has no `origin`, compaction part has no `publication` property, AND an S exists with `S.parentID === U.id`, `S.summary === true`, truthy successful `S.finish`, no `S.error`. `tail_start_id` optional. A U with any explicit synthetic origin cannot use legacy recognition even if publication metadata is absent.
- **New**: part has `publication.state === "published"` and exact `publication.summaryID === S.id` AND S has the same required success checks. `tail_start_id` optional.

All other candidates are non-authoritative. New `preparing` + successful S is **not** legacy. New `origin:"compaction"` with missing publication metadata is also **not** legacy. A new `published` with a missing/broken S is not considered published by readers; it should be flagged diagnostically without hiding the previous valid projection.

## Write protocol

```text
N0:   MessageUpdated(U, origin=compaction)  ← identifiable even without part
N1:   PartUpdated(P, publication=queued)
N2:   PartUpdated(P, publication=preparing) ← before any S success write
N3:   MessageUpdated(S, summary=true, incomplete)
N4:   PartUpdated(text parts / deltas / completion)
N5:   MessageUpdated(S, successful finish, no error)
N5a:  Verify persisted S belongs to U and content is readable
N6:   PartUpdated(P, publication=published, summaryID=S.id,
                 tail_start_id=selected.tail_start_id if present)
       ^ Only durable publication linearization point
N7:   Existing ordinary autocontinue/replay and Event.Compacted
```

If `process` starts from an eligible **legacy pending U**, the pair remains governed by historical finished-relative scheduling until N2; N2 MUST first update its existing part to `preparing`, after which it is no longer automatically runnable. An already completed valid legacy pair MUST NOT be upgraded to pending.

## Crash matrix

| Crash after | Read projection | Scheduling | Response semantics |
|---|---|---|---|
| Before N0 | Prior valid projection | None | Existing response |
| N0, before N1 | Prior valid projection | Orphan U recognized as synthetic; no runnable task | Existing response, not U |
| N1, before N2 | Prior projection | Genuine queued ordinary compaction runnable | Existing response |
| Legacy U/P before upgrade | Existing legacy projection rules | Historical finished-relative scheduling: unfinished S without `finish` may leave U runnable; `finish:"error"` suppresses U | Existing response |
| N2, before N3 | Prior projection | `preparing` not automatically re-run after restart | Existing response |
| N3/N4 | Prior projection | Do not re-run `preparing` automatically | Streaming S not final response |
| N5/N5a | Prior projection after crash/reopen, even when S has successful readable content | Complete but unpublished; no automatic resummarization. No reconciler is implemented by this plan. | S not final answer |
| N6 | New summary + optional tail | No duplicate work | Published S has normal compaction semantics |
| N7 | New summary + optional tail plus optional continuation | Normal behavior | Existing autocontinue preserved |
| Error/cancel before N6 | Prior projection | Try marking abandoned; no re-run even if cleanup crashes | Failed S not authoritative |

If a previously published pair exists, “prior projection” means that previously published pair plus its applicable tail and later real turns, not the raw entire historical transcript. For an intentional revert/delete that removes a published summary or its required content, select the newest *remaining* valid pair; do not interpret this as a stale-update rollback or preserve a dangling authoritative binding.

Fork edge: clone IDs for all included messages before copying any parts. Remap every included published part's `summaryID` and every included `tail_start_id`. If a fork includes synthetic U but omits its referenced published S, retain the new-format synthetic identity, convert its incomplete publication candidate to `abandoned`, and remove source-session references. It remains explicitly non-authoritative and non-runnable; do not reinterpret it as a legacy pending compaction. Complete published pairs remain unchanged apart from ID remapping.

## Monotonicity

`published(summaryID=S)` is absorbing **for ordinary part updates**: a later `PartUpdated` cannot downgrade the state, change `summaryID`, or change the published tail boundary. Identical publication is idempotent. The projector rejects such conflicting events inside the durable event transaction, so the projector, event log, and sequence roll back together.

The referenced S is independently mutable: `MessageUpdated(S)` uses an unconditional upsert. Reject stale post-publication writes that remove S's successful `finish`, add `error`, change `summary` or `parentID`, or invalidate successfully published readable text/provenance via updates to S parts. Use narrow summary/part-content checks only when relevant; avoid an expensive publication scan on every streaming delta. Test aborted/late summary finalizers after the publication event.

**Explicit deletion/revert is distinct from an ordinary stale update.** A user-authorized `MessageRemoved(S)`, `PartRemoved` of necessary S content, or removal of U/P intentionally invalidates the pair; consumers must then fall back to the preceding valid publication, not silently claim S is readable. Preserve supported `revert.cleanup` and delete workflows, and make the user-visible undo outcome explicit. Under the current API, `MessageRemoved` and `PartRemoved` are explicit deletion events, unlike late `MessageUpdated`/`PartUpdated` finalizer upserts; preserve their existing authorized semantics, and investigate any newly discovered automatic deletion writer separately. A published binding does not make a missing S magically valid.

## Reader contracts

`modelHistory(raw)`: apply only authoritative pairs; ignore new unpublished U/S as model input, while respecting legitimate latest real turns. `pendingWork(raw)`: classify first. Strict legacy pairs (U origin absent and P publication absent) preserve the old `latest()` finished-relative cutoff: interrupted S without `finish` may leave U runnable, while `finish:"error"` advances the latest finished S and suppresses U. New ordinary work is runnable only for `origin:"compaction"` and publication `queued`; new `preparing`/`abandoned` and completed-unpublished S never regenerate implicitly. Explicit synthetic origin with absent publication is invalid, not legacy. Recovery-preparation and unknown origins never enter ordinary compaction scheduling. Use each runnable part's **owner messageID**, not the newest user. `currentResponse(raw)`: omit new provisional S as the final user-facing answer; preserve published summary behavior. `compactionWorkInput`: active model projection through the scheduled U plus that exact U and necessary parts; preserve any later real user Y separately, do not re-parent the job to Y or unhide previously compacted head.

`runLoop` must assess pending work *before* the completed-turn exit, process compaction with `parentID: task.messageID`, reject any synthetic U without a part and any non-ordinary synthetic origin as a normal prompt, reject explicit synthetic identity without publication metadata as legacy, and select the latest genuine user for generation. Preserve legacy pending classification until an eligible legacy part is upgraded to `preparing`. Do not use one filtered list for all three purposes.
