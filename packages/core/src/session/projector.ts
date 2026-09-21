export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { EventTable } from "../event/sql"
import type { DeepMutable } from "../schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

/**
 * Raised inside the durable event transaction when a stale writer attempts to
 * mutate a published compaction part, its referenced successful summary or
 * summary content, or the identity of the owner message of that publication.
 * The defect propagates through the existing Effect transaction mechanism so
 * the projector, event log, and aggregate sequence roll back together.
 */
export class StalePublicationUpdateError extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

type PartRow = typeof PartTable.$inferSelect
type MessageRow = typeof MessageTable.$inferSelect

// The stored JSON data columns are typed as Omit over the part/message unions,
// which keeps only the common fields; guards need the discriminated payloads,
// so they narrow through these structural views of the same persisted JSON.
type StoredPart = {
  readonly type?: string
  readonly publication?: NonNullable<SessionV1.CompactionPart["publication"]>
  readonly tail_start_id?: SessionV1.MessageID
  readonly text?: string
}
type StoredMessage = {
  readonly role?: string
  readonly origin?: string
  readonly summary?: boolean
  readonly finish?: string
  readonly error?: unknown
  readonly parentID?: SessionV1.MessageID
}

// Narrow persisted lookup for the exact published relationship: one session's
// compaction parts whose stored publication binds this summary. Only invoked
// when an attempted update is already potentially destructive, so ordinary
// streaming deltas never scan compaction parts.
function publishedSummaryBinding(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  summaryID: SessionV1.MessageID,
) {
  return db
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        eq(sql`json_extract(${PartTable.data}, '$.type')`, "compaction"),
        eq(sql`json_extract(${PartTable.data}, '$.publication.state')`, "published"),
        eq(sql`json_extract(${PartTable.data}, '$.publication.summaryID')`, summaryID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
}

// Narrow persisted lookup for readable text already hosted by one message,
// keyed by owner message_id (indexed) and evaluated only when a part id is
// aimed at a completed summary. It mirrors the reader's readable-content rule
// for summaries, so a published pair that has no model-visible content yet
// stays non-authoritative instead of being silently completed by a fresh part.
// The final-publication boundary applies the same JavaScript trim semantics as
// MessageV2.hasReadableSummaryText and the writer's persisted-summary check;
// SQLite's one-argument trim() cannot approximate Unicode whitespace, so the
// bounded per-message text parts are evaluated in TypeScript instead.
function summaryHasReadableText(db: DatabaseService, messageID: SessionV1.MessageID) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.message_id, messageID), eq(sql`json_extract(${PartTable.data}, '$.type')`, "text")))
      .all()
      .pipe(Effect.orDie)
    return rows.some((row) => {
      const text = (row.data as { text?: unknown }).text
      return typeof text === "string" && text.trim() !== ""
    })
  })
}

// Narrow persisted lookup for the published compaction owned by one message,
// keyed by owner message_id (indexed) instead of scanning a session's parts.
// Only reached from a MessageUpdated that already threatens owner identity.
function publishedOwnerBinding(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  ownerID: SessionV1.MessageID,
) {
  return db
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        eq(PartTable.message_id, ownerID),
        eq(sql`json_extract(${PartTable.data}, '$.type')`, "compaction"),
        eq(sql`json_extract(${PartTable.data}, '$.publication.state')`, "published"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
}

// Narrow durable removal evidence inside the aggregate's event log. Both
// MessageRemoved and PartRemoved record the affected messageID in their
// payload, so one indexed lookup shape serves both. Cost: the
// event_aggregate_type_seq_idx index confines the scan to this aggregate's
// events of that single removal type — typically a handful of rows even in
// long agent sessions, which are dominated by PartUpdated/PartDelta events —
// and never the full session event stream. It runs only when a new message
// row is created (MessageRemoved evidence) or when an incoming part proposes
// type "compaction" (owner-level deletion evidence), never on ordinary
// streaming text PartUpdated.
function removalEvidence(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  type: string,
  messageID: SessionV1.MessageID,
) {
  return db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, type),
        eq(sql`json_extract(${EventTable.data}, '$.messageID')`, messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
}

// Structural deep equality that ignores key order. Used to distinguish an
// exact idempotent replay of a stored part payload from any content-changing
// update, so identical re-delivery stays a no-op while every divergence is
// evaluated by the published-summary freeze.
function partDataEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => partDataEquals(item, b[index]))
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && partDataEquals(aRecord[key], bRecord[key]))
}

// Gap after authorized deletion: an explicitly removed compaction part must
// not be recreated by a stale producer under its previous part ID, in any
// publication state. An authorized PartRemoved is durable in the aggregate's
// event log, which distinguishes a genuinely new part ID (a new compaction
// attempt or a Session.fork clone) from a removed one. Without this, a late
// PartUpdated could reinsert a deleted published binding — or rebuild it
// queued-then-published — and silently reverse the authorized deletion.
//
// Type-transition closure (R4a/R4b): every incoming part whose PROPOSED type
// is "compaction" pays the deletion checks, not only brand-new rows. An
// ordinary text part created under the owner after the deletion (fresh ID)
// or already present before it (existing row) must not be retyped into the
// deleted publication: part-ID removal evidence covers a removed ID that
// re-entered as ordinary text first, and owner-level evidence covers the
// fresh-ID retype. Previously the guard returned early whenever the row
// existed and whenever the proposal was not compaction, so an existing
// non-compaction row satisfied neither precondition and slipped through.
//
// Owner-level deletion closure (R2/R3): the deletion of a compaction
// operation is recorded against its owner, not only its part rows.
// - MessageRemoved(U) cascades every part of U away WITHOUT a PartRemoved
//   event, so part-level evidence alone cannot see the deletion; durable
//   MessageRemoved evidence for the owner blocks any compaction part under
//   that deleted owner id.
// - PartRemoved of any part of U marks the owner's publication operation as
//   intentionally deleted; a DIFFERENT part id under the same owner must not
//   restart a queued attempt or re-bind the same surviving summary to revive
//   the removed publication. This evidence now also applies to an already
//   persisted compaction row, so a duplicate part created BEFORE the
//   authorized deletion (R4c) cannot transition through it afterwards.
//   Legitimate flows never carry this evidence: an ordinary retry allocates a
//   fresh synthetic owner (SessionCompaction.create) and Session.fork clones
//   preallocate fresh owners in a new session aggregate, neither of which
//   carries this aggregate's removal evidence.
//
// Owner uniqueness (R4c): one compaction operation is owned by U.id. A new
// compaction-part row (or an ordinary row retyped into one) may not be
// created while another compaction part already exists under the same owner,
// so an illegitimate second part cannot exist to survive a later authorized
// deletion. Strict legacy and upgraded-legacy records each hold exactly one
// compaction part per owner, and every legitimate writer (create, process,
// fork) updates a single part in place under a fresh owner, so the creation
// boundary is the narrowest safe enforcement point. Same-row lifecycle
// transitions of a persisted compaction part skip this check.
//
// Cost: ordinary text PartUpdated returns before any query; only proposals
// of type "compaction" run these bounded, aggregate/owner-indexed lookups
// inside the existing per-event transaction.
function guardRemovedPartRecreation(
  db: DatabaseService,
  row: PartRow | undefined,
  part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"],
) {
  if (part.type !== "compaction") return Effect.void
  const persisted = row === undefined ? undefined : (row.data as StoredPart)
  const persistedCompaction = persisted?.type === "compaction"
  return Effect.gen(function* () {
    if (!persistedCompaction) {
      const removed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, part.sessionID),
            eq(EventTable.type, EventV2.versionedType(SessionV1.Event.PartRemoved.type, 1)),
            eq(sql`json_extract(${EventTable.data}, '$.partID')`, part.id),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (removed !== undefined)
        yield* Effect.die(
          new StalePublicationUpdateError("compaction part conflict: part id was previously removed"),
        )
    }
    const ownerRemoved = yield* removalEvidence(
      db,
      part.sessionID,
      EventV2.versionedType(SessionV1.Event.MessageRemoved.type, 1),
      part.messageID,
    )
    if (ownerRemoved !== undefined)
      yield* Effect.die(
        new StalePublicationUpdateError("compaction part conflict: owner message was previously removed"),
      )
    const ownerPublicationRemoved = yield* removalEvidence(
      db,
      part.sessionID,
      EventV2.versionedType(SessionV1.Event.PartRemoved.type, 1),
      part.messageID,
    )
    if (ownerPublicationRemoved !== undefined)
      yield* Effect.die(
        new StalePublicationUpdateError("compaction part conflict: owner publication was previously removed"),
      )
    if (!persistedCompaction) {
      const sibling = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, part.sessionID),
            eq(PartTable.message_id, part.messageID),
            eq(sql`json_extract(${PartTable.data}, '$.type')`, "compaction"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (sibling !== undefined)
        yield* Effect.die(
          new StalePublicationUpdateError("compaction part conflict: owner already owns a compaction part"),
        )
    }
  })
}

// T021: published compaction publication is absorbing for ordinary part
// updates. Reads the CURRENT persisted row inside the event transaction and
// rejects downgrades, summaryID rebinding, tail-boundary changes, and type or
// owner replacement; an identical published binding stays idempotent. Persisted
// parts without publication metadata (legacy) and pre-publication states
// (queued/preparing/abandoned) remain unrestricted.
function guardPartPublication(row: PartRow | undefined, part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]) {
  if (row === undefined) return Effect.void
  const persisted = row.data as StoredPart
  if (persisted.type !== "compaction") return Effect.void
  const publication = persisted.publication
  if (publication === undefined || publication.state !== "published") return Effect.void
  const reject = (reason: string) =>
    Effect.die(new StalePublicationUpdateError(`compaction publication conflict: ${reason}`))
  if (part.type !== "compaction") return reject(`part type changed to ${part.type}`)
  if (part.messageID !== row.message_id || part.sessionID !== row.session_id)
    return reject("owner binding changed")
  const proposed = part.publication
  if (proposed === undefined) return reject("publication metadata removed")
  if (proposed.state !== "published") return reject(`publication downgraded to ${proposed.state}`)
  if (proposed.summaryID !== publication.summaryID) return reject("summaryID changed")
  if (part.tail_start_id !== persisted.tail_start_id) return reject("published tail boundary changed")
  return Effect.void
}

// Gap B: entering `published` is the publication linearization point, so it
// must carry already-verified durable evidence. Every transition into
// `published` — whether a fresh compaction part is created as published or an
// existing queued/preparing part is updated — re-reads the persisted owner,
// summary identity, successful finish, absence of error, and readable summary
// content inside the same per-event transaction. This rejects premature
// publication (missing/incomplete/unreadable S) and blocks both late-activation
// repairs and legacy-pair migration; an already-published part is handled by
// the absorbing guard above and stays idempotent without re-verification.
function guardPublicationTransition(
  db: DatabaseService,
  row: PartRow | undefined,
  part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"],
) {
  if (part.type !== "compaction") return Effect.void
  const proposed = part.publication
  if (proposed === undefined || proposed.state !== "published") return Effect.void
  if (row !== undefined) {
    const persisted = row.data as StoredPart
    if (persisted.type === "compaction" && persisted.publication?.state === "published") return Effect.void
    if (persisted.type === "compaction") {
      const source = persisted.publication?.state
      const rejectSource = (reason: string) =>
        Effect.die(new StalePublicationUpdateError(`premature publication rejected: ${reason}`))
      if (source !== "queued" && source !== "preparing")
        return rejectSource(`cannot publish from ${source ?? "legacy"} compaction state`)
      if (part.messageID !== row.message_id || part.sessionID !== row.session_id)
        return rejectSource("owner binding changed")
    }
  }
  return Effect.gen(function* () {
    const reject = (reason: string) =>
      Effect.die(new StalePublicationUpdateError(`premature publication rejected: ${reason}`))
    const owner = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.id, part.messageID))
      .get()
      .pipe(Effect.orDie)
    if (owner === undefined) return yield* reject("publication owner missing")
    if (owner.session_id !== part.sessionID) return yield* reject("publication owner session mismatch")
    if ((owner.data as StoredMessage).role !== "user") return yield* reject("owner is not a user message")
    const summary = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.id, proposed.summaryID))
      .get()
      .pipe(Effect.orDie)
    if (summary === undefined) return yield* reject("summary is missing")
    if (summary.session_id !== part.sessionID) return yield* reject("summary session mismatch")
    const info = summary.data as StoredMessage
    if (info.role !== "assistant" || info.summary !== true) return yield* reject("summary identity mismatch")
    if (info.parentID !== part.messageID) return yield* reject("summary parent mismatch")
    if (!info.finish || info.finish === "error" || info.error !== undefined)
      return yield* reject("summary is not successful")
    const readable = yield* summaryHasReadableText(db, proposed.summaryID)
    if (!readable) return yield* reject("summary has no readable content")
  })
}

// T022 (message): a stale MessageUpdated must not demote a successfully
// completed summary that a published part binds. The message row is read by
// primary key; the publication binding is only queried when the update would
// actually demote that persisted success, so ordinary and pre-publication
// summary updates are unaffected.
//
// Deletion resurrection gap: a published binding also forbids recreating the
// bound summary under the same message ID after an authorized MessageRemoved,
// or completing an unfinished bound summary, so stale writes from an older
// publication attempt cannot silently restore a deleted published pair.
//
// Ordinary-assistant-state resurrection (R1): after MessageRemoved(S) the
// published part still references S, so any recreation of the S message ID is
// a stale write against the authorized deletion regardless of the proposed
// shape. Guarding only summary-flagged proposals left a bypass: recreate S as
// a plain (non-summary) assistant, stream readable text under it, then flip it
// to summary:true/finish:stop — the early returns for non-summary proposals
// and non-summary persisted rows never rechecked the binding, and the
// still-persisted published part became authoritative again. Durable
// MessageRemoved evidence now freezes the removed ID for EVERY recreation
// (checked after the binding-specific reason so existing messages stay
// stable), while genuinely new message IDs — which never collide with a
// removed one — keep unconditional upsert semantics, including pre-publication
// summary streaming. The lookup cost is the aggregate+type-indexed
// removalEvidence scan documented above, paid once per new message row.
function guardSummaryUpdate(
  db: DatabaseService,
  row: MessageRow | undefined,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
) {
  const proposesSummary = info.role === "assistant" && info.summary === true
  const proposesSuccess =
    proposesSummary && Boolean(info.finish) && info.finish !== "error" && info.error === undefined
  if (row === undefined) {
    return Effect.gen(function* () {
      if (proposesSummary) {
        const binding = yield* publishedSummaryBinding(db, sessionID, info.id)
        if (binding !== undefined)
          yield* Effect.die(
            new StalePublicationUpdateError("published summary conflict: recreation of a deleted published summary"),
          )
      }
      const removed = yield* removalEvidence(
        db,
        sessionID,
        EventV2.versionedType(SessionV1.Event.MessageRemoved.type, 1),
        info.id,
      )
      if (removed !== undefined)
        yield* Effect.die(new StalePublicationUpdateError("message conflict: previously removed"))
    })
  }
  const persisted = row.data as StoredMessage
  if (persisted.role !== "assistant") return Effect.void
  if (persisted.summary !== true) return Effect.void
  if (!persisted.finish || persisted.finish === "error" || persisted.error !== undefined) {
    if (!proposesSuccess) return Effect.void
    return Effect.gen(function* () {
      const binding = yield* publishedSummaryBinding(db, row.session_id, row.id)
      if (binding === undefined) return
      yield* Effect.die(
        new StalePublicationUpdateError("published summary conflict: stale completion of a bound summary"),
      )
    })
  }
  let reason: string | undefined
  if (info.sessionID !== row.session_id || sessionID !== row.session_id) reason = "session binding changed"
  else if (info.role !== "assistant") reason = "role changed"
  else if (info.summary !== true) reason = "summary flag removed"
  else if (!info.finish) reason = "successful finish removed"
  else if (info.finish === "error") reason = "finish changed to error"
  else if (info.error !== undefined) reason = "failure recorded"
  else if (info.parentID !== persisted.parentID) reason = "parentID changed"
  if (reason === undefined) return Effect.void
  return Effect.gen(function* () {
    const binding = yield* publishedSummaryBinding(db, row.session_id, row.id)
    if (binding === undefined) return
    yield* Effect.die(new StalePublicationUpdateError(`published summary conflict: ${reason}`))
  })
}

// Gap B: a stale MessageUpdated must not invalidate the identity of a user
// message that currently owns a published compaction. The cheap persisted
// checks come first — an ordinary user update that preserves role, origin, and
// session never reaches a query — and only a threatened owner pays for the
// narrow owner-keyed publication lookup. Messages with no published compaction
// (including every legacy pair and every ordinary user) keep their existing
// unconditional upsert semantics.
function guardOwnerUpdate(
  db: DatabaseService,
  row: MessageRow | undefined,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
) {
  if (row === undefined) return Effect.void
  const persisted = row.data as StoredMessage
  if (persisted.role !== "user") return Effect.void
  let reason: string | undefined
  if (info.sessionID !== row.session_id || sessionID !== row.session_id) reason = "session binding changed"
  else if (info.role !== "user") reason = "role changed"
  else if (info.origin !== persisted.origin)
    reason =
      persisted.origin === undefined
        ? "synthetic origin added"
        : info.origin === undefined
          ? "synthetic origin removed"
          : "synthetic origin changed"
  if (reason === undefined) return Effect.void
  return Effect.gen(function* () {
    const binding = yield* publishedOwnerBinding(db, row.session_id, row.id)
    if (binding === undefined) return
    yield* Effect.die(new StalePublicationUpdateError(`published compaction owner conflict: ${reason}`))
  })
}

// Gap A / T022 (content): a published summary is immutable for ordinary part
// updates. Once any published compaction part binds the owning summary, no
// later PartUpdated may add a new part to it or change any hosted part's
// payload — regardless of whether the previous part was empty, readable, or
// another type — while an exact identical replay stays idempotent. The cheap
// persisted-part comparison runs first; only a divergent update of a hosted
// part pays for the message-row read, and the narrow publication-binding
// lookup is reached only from persisted message state that already identifies
// a successfully completed summary. Incomplete (pre-publication) summaries and
// ordinary messages keep their existing unconditional upsert semantics, so
// ordinary streaming deltas never scan compaction parts.
function guardSummaryContent(
  db: DatabaseService,
  row: PartRow | undefined,
  part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"],
) {
  if (row === undefined) {
    // A part id that does not exist yet. Ordinary part creation reads one
    // message row and stops; only a new part aimed at an already completed and
    // published summary reaches the publication lookup, because publication
    // itself already required durable readable content. A part aimed at a
    // missing message that a published binding still references is a stale
    // write against an authorized MessageRemoved and must not contribute
    // resurrected content.
    return Effect.gen(function* () {
      const message = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.id, part.messageID))
        .get()
        .pipe(Effect.orDie)
      if (message === undefined) {
        const binding = yield* publishedSummaryBinding(db, part.sessionID, part.messageID)
        if (binding === undefined) return
        return yield* Effect.die(
          new StalePublicationUpdateError("published summary content conflict: content for a deleted summary"),
        )
      }
      const info = message.data as StoredMessage
      if (info.role !== "assistant" || info.summary !== true) return
      if (!info.finish || info.finish === "error" || info.error !== undefined) return
      const binding = yield* publishedSummaryBinding(db, part.sessionID, part.messageID)
      if (binding === undefined) return
      yield* Effect.die(
        new StalePublicationUpdateError("published summary content conflict: new part after publication"),
      )
    })
  }
  const persisted = row.data as StoredPart
  const ownerChanged = part.messageID !== row.message_id || part.sessionID !== row.session_id
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...proposedData } = part as Record<string, unknown>
  const contentChanged = !partDataEquals(persisted, proposedData)
  if (!ownerChanged && !contentChanged) return Effect.void
  return Effect.gen(function* () {
    const message = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.id, row.message_id))
      .get()
      .pipe(Effect.orDie)
    if (message === undefined) return
    const info = message.data as StoredMessage
    if (info.role !== "assistant" || info.summary !== true) return
    if (!info.finish || info.finish === "error" || info.error !== undefined) return
    const binding = yield* publishedSummaryBinding(db, row.session_id, row.message_id)
    if (binding === undefined) return
    yield* Effect.die(
      new StalePublicationUpdateError(
        ownerChanged
          ? "published summary content conflict: owner binding changed"
          : "published summary content conflict: content changed",
      ),
    )
  })
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        const row = yield* db.select().from(MessageTable).where(eq(MessageTable.id, id)).get().pipe(Effect.orDie)
        yield* guardSummaryUpdate(db, row, sessionID, event.data.info)
        yield* guardOwnerUpdate(db, row, sessionID, event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* guardRemovedPartRecreation(db, row, event.data.part)
        yield* guardPartPublication(row, event.data.part)
        yield* guardPublicationTransition(db, row, event.data.part)
        yield* guardSummaryContent(db, row, event.data.part)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
