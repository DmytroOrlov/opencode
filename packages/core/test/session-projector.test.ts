import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { and, asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Location } from "@opencode-ai/core/location"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  it.effect("projects moved sessions without the transitional context epoch table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`DROP TABLE session_context_epoch`)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/project/subdir") }),
      })

      expect(yield* db.select({ directory: SessionTable.directory }).from(SessionTable).get()).toEqual({
        directory: "/project/subdir",
      })
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})

describe("SessionProjector compaction publication guards", () => {
  const guardSession = SessionV2.ID.make("ses_guard_pub")
  const u = SessionV1.MessageID.make("msg_guard_u")
  const p = SessionV1.PartID.make("prt_guard_p")
  const s = SessionV1.MessageID.make("msg_guard_s")
  const sText = SessionV1.PartID.make("prt_guard_s_text")
  const sText2 = SessionV1.PartID.make("prt_guard_s_text2")
  const tail = SessionV1.MessageID.make("msg_guard_tail")
  const otherTail = SessionV1.MessageID.make("msg_guard_other_tail")
  const y = SessionV1.MessageID.make("msg_guard_y")
  const yText = SessionV1.PartID.make("prt_guard_y_text")
  const otherS = SessionV1.MessageID.make("msg_guard_other_s")

  type StoredPartData = {
    type?: string
    auto?: boolean
    tail_start_id?: string
    publication?: { state?: string; summaryID?: string }
    text?: string
  }
  type StoredMessageData = {
    role?: string
    summary?: boolean
    finish?: string
    error?: unknown
    parentID?: string
  }

  const userInfo = (id: SessionV1.MessageID, input: { origin?: string } = {}): SessionV1.User =>
    ({
      id,
      sessionID: guardSession,
      role: "user",
      time: { created: 1 },
      agent: "user",
      model: { providerID: model.providerID, modelID: model.id },
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    }) as SessionV1.User

  const summaryInfo = (input: {
    id?: SessionV1.MessageID
    parentID: SessionV1.MessageID
    finish?: string
    error?: SessionV1.Assistant["error"]
    summary?: boolean
    completed?: number
  }): SessionV1.Assistant =>
    ({
      id: input.id ?? s,
      sessionID: guardSession,
      role: "assistant",
      time: { created: 2, ...(input.completed !== undefined ? { completed: input.completed } : {}) },
      ...(input.summary === false ? {} : { summary: true }),
      parentID: input.parentID,
      modelID: model.id,
      providerID: model.providerID,
      mode: "",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.finish !== undefined ? { finish: input.finish } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    }) as SessionV1.Assistant

  const abortError = { name: "MessageAbortedError", data: { message: "cancelled" } } as SessionV1.Assistant["error"]

  const compactionPart = (input: {
    id?: SessionV1.PartID
    publication?: NonNullable<SessionV1.CompactionPart["publication"]>
    tail?: SessionV1.MessageID
    messageID?: SessionV1.MessageID
  } = {}): SessionV1.CompactionPart => ({
    id: input.id ?? p,
    sessionID: guardSession,
    messageID: input.messageID ?? u,
    type: "compaction",
    auto: true,
    ...(input.tail !== undefined ? { tail_start_id: input.tail } : {}),
    ...(input.publication !== undefined ? { publication: input.publication } : {}),
  })

  const textPart = (input: {
    id?: SessionV1.PartID
    messageID?: SessionV1.MessageID
    text: string
  }): SessionV1.TextPart => ({
    id: input.id ?? sText,
    sessionID: guardSession,
    messageID: input.messageID ?? s,
    type: "text",
    text: input.text,
  })

  const setup = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: guardSession,
        project_id: Project.ID.global,
        slug: "guard",
        directory: "/project",
        title: "guard",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return { db, events }
  })

  const putMessage = (events: EventV2.Interface, info: SessionV1.Info) =>
    events.publish(SessionV1.Event.MessageUpdated, { sessionID: guardSession, info })

  const putPart = (events: EventV2.Interface, part: SessionV1.Part, time = 1) =>
    events.publish(SessionV1.Event.PartUpdated, { sessionID: guardSession, part, time })

  const storedPart = (db: Database.Interface["db"], id: SessionV1.PartID = p) =>
    Effect.gen(function* () {
      const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
      if (row === undefined) return yield* Effect.die(`persisted part row missing: ${id}`)
      return row
    })

  const storedMessage = (db: Database.Interface["db"], id: SessionV1.MessageID) =>
    Effect.gen(function* () {
      const row = yield* db.select().from(MessageTable).where(eq(MessageTable.id, id)).get().pipe(Effect.orDie)
      if (row === undefined) return yield* Effect.die(`persisted message row missing: ${id}`)
      return row
    })

  const aggregateEventIDs = (db: Database.Interface["db"]) =>
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, guardSession))
      .all()
      .pipe(Effect.orDie)

  const aggregateSeq = (db: Database.Interface["db"]) =>
    Effect.gen(function* () {
      const row = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, guardSession))
        .get()
        .pipe(Effect.orDie)
      return row?.seq ?? -1
    })

  const compactionPartsUnder = (db: Database.Interface["db"], owner: SessionV1.MessageID) =>
    db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(and(eq(PartTable.message_id, owner), eq(sql`json_extract(${PartTable.data}, '$.type')`, "compaction")))
      .all()
      .pipe(Effect.orDie)

  const expectRejected = <A, E>(exit: Exit.Exit<A, E>, reason: string) => {
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(String(exit)).toContain(reason)
  }

  const seedPublished = (input: { tail?: SessionV1.MessageID } = {}) =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, textPart({ text: "published summary content" }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(
        events,
        compactionPart({
          publication: { state: "published", summaryID: s },
          ...(input.tail !== undefined ? { tail: input.tail } : {}),
        }),
      )
      return { db, events }
    })

  it.effect("A: queued publication transitions to preparing", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))

      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "preparing" },
      })
    }),
  )

  it.effect("B: preparing transitions to published with exact summaryID and a tail", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, textPart({ text: "published summary content" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s }, tail }),
      )

      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
        tail_start_id: tail as unknown as string,
      })
    }),
  )

  it.effect("C: an identical published payload remains idempotent", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished({ tail })
      const before = (yield* storedPart(db)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s }, tail }))

      expect((yield* storedPart(db)).data).toEqual(before)
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore + 1)
    }),
  )

  const rejectedTransition = (
    reason: string,
    stale: SessionV1.CompactionPart,
    options: { tail?: SessionV1.MessageID } = {},
  ) =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished(options)
      const before = (yield* storedPart(db)).data
      const countBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(events, stale).pipe(Effect.exit)

      expectRejected(exit, reason)
      expect((yield* storedPart(db)).data).toEqual(before)
      expect((yield* aggregateEventIDs(db))).toHaveLength(countBefore)
    })

  it.effect("D: published to queued is rejected", () =>
    rejectedTransition("publication downgraded to queued", compactionPart({ publication: { state: "queued" } })),
  )

  it.effect("E: published to preparing is rejected", () =>
    rejectedTransition("publication downgraded to preparing", compactionPart({ publication: { state: "preparing" } })),
  )

  it.effect("F: published to abandoned is rejected", () =>
    rejectedTransition("publication downgraded to abandoned", compactionPart({ publication: { state: "abandoned" } })),
  )

  it.effect("G: published to missing publication metadata is rejected", () =>
    rejectedTransition("publication metadata removed", compactionPart({ tail })),
  )

  it.effect("H: published to a different summaryID is rejected", () =>
    rejectedTransition(
      "summaryID changed",
      compactionPart({ publication: { state: "published", summaryID: otherS } }),
    ),
  )

  it.effect("I: published tailed to a changed tail is rejected", () =>
    rejectedTransition(
      "published tail boundary changed",
      compactionPart({ publication: { state: "published", summaryID: s }, tail: otherTail }),
      { tail },
    ),
  )

  it.effect("J: published tailed to an omitted tail is rejected", () =>
    rejectedTransition(
      "published tail boundary changed",
      compactionPart({ publication: { state: "published", summaryID: s } }),
      { tail },
    ),
  )

  it.effect("K: published full to a newly introduced tail is rejected", () =>
    rejectedTransition(
      "published tail boundary changed",
      compactionPart({ publication: { state: "published", summaryID: s }, tail }),
    ),
  )

  it.effect("replacing a published compaction part with an incompatible type is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedPart(db)).data

      const exit = yield* putPart(events, textPart({ id: p, messageID: u, text: "not a compaction part" })).pipe(
        Effect.exit,
      )

      expectRejected(exit, "part type changed")
      expect((yield* storedPart(db)).data).toEqual(before)
    }),
  )

  it.effect("rebinding a published compaction part to another owner is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedPart(db)).data

      const exit = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s }, messageID: y }),
      ).pipe(Effect.exit)

      expectRejected(exit, "owner binding changed")
      expect((yield* storedPart(db)).data).toEqual(before)
    }),
  )

  it.effect("L: ordinary unrelated part updates remain allowed", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      yield* putMessage(events, userInfo(y))
      yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary content" }))
      yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary content updated" }))
      yield* putPart(events, textPart({ id: yText, messageID: y, text: "" }))

      expect((yield* storedPart(db, yText)).data as StoredPartData).toMatchObject({ text: "" })
      expect((yield* storedPart(db)).data).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
    }),
  )

  it.effect("M: a legacy compaction part without publication metadata stays backward-compatible", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u))
      yield* putPart(events, compactionPart())
      yield* putPart(events, compactionPart({ tail }))

      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        tail_start_id: tail as unknown as string,
      })
      expect(((yield* storedPart(db)).data as StoredPartData).publication).toBeUndefined()
    }),
  )

  it.effect("negative control 8: a mutation-free defective guard accepts a stale publication downgrade", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished({ tail })
      const persisted = (yield* storedPart(db)).data as StoredPartData
      const staleProposed = compactionPart({ publication: { state: "queued" } })

      // Production path: the stale event is rejected and the persisted
      // published binding survives for the acceptance assertion.
      const exit = yield* putPart(events, staleProposed).pipe(Effect.exit)
      expectRejected(exit, "compaction publication conflict")
      const afterRejected = (yield* storedPart(db)).data as StoredPartData

      const acceptance = (stored: StoredPartData) => {
        expect(stored.publication).toEqual({ state: "published", summaryID: s as unknown as string })
        expect(stored.tail_start_id).toBe(tail as unknown as string)
      }

      // Test-local defective guard: merges the stale payload without checking
      // publication monotonicity. Never touches production source.
      const defectiveGuard = (stored: StoredPartData, proposed: StoredPartData): StoredPartData => ({
        ...stored,
        ...proposed,
      })

      acceptance(afterRejected)
      const defectiveResult = defectiveGuard(persisted, staleProposed as unknown as StoredPartData)
      expect(defectiveResult.publication?.state).toBe("queued")
      expect(() => acceptance(defectiveResult)).toThrow()
    }),
  )

  it.effect("T022: a late failure finalizer cannot demote a published successful summary", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, s)).data

      const exit = yield* putMessage(
        events,
        summaryInfo({ parentID: u, finish: "error", error: abortError, completed: 9 }),
      ).pipe(Effect.exit)

      expectRejected(exit, "published summary conflict")
      expect((yield* storedMessage(db, s)).data).toEqual(before)
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({
        summary: true,
        finish: "stop",
        parentID: u as unknown as string,
      })
      expect(((yield* storedMessage(db, s)).data as StoredMessageData).error).toBeUndefined()
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
    }),
  )

  it.effect("T022: removing the successful finish of a published summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, s)).data

      const exit = yield* putMessage(events, summaryInfo({ parentID: u })).pipe(Effect.exit)

      expectRejected(exit, "successful finish removed")
      expect((yield* storedMessage(db, s)).data).toEqual(before)
    }),
  )

  it.effect("T022: removing summary identity or changing the parent of a published summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, s)).data

      const demoted = yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", summary: false })).pipe(
        Effect.exit,
      )
      expectRejected(demoted, "summary flag removed")

      const reparented = yield* putMessage(events, summaryInfo({ parentID: otherS, finish: "stop" })).pipe(
        Effect.exit,
      )
      expectRejected(reparented, "parentID changed")

      expect((yield* storedMessage(db, s)).data).toEqual(before)
    }),
  )

  it.effect("T022: changing the role of a published summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, s)).data

      const exit = yield* putMessage(events, userInfo(s)).pipe(Effect.exit)

      expectRejected(exit, "role changed")
      expect((yield* storedMessage(db, s)).data).toEqual(before)
    }),
  )

  it.effect("T022: ordinary assistant updates and pre-publication summary completion stay allowed", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, summary: false, id: y }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      // A still-streaming, not-yet-published summary may be inserted and gain
      // its successful finish before publication exists.
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 5 }))
      // An unrelated ordinary assistant keeps its existing update semantics.
      yield* putMessage(events, summaryInfo({ id: y, parentID: u, finish: "end_turn", completed: 6 }))

      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ finish: "stop" })
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "preparing" },
      })
      expect((yield* aggregateEventIDs(db))).toHaveLength(6)

      // Failure finalization before publication is still permitted: no binding
      // exists yet, so the writer may mark the candidate abandoned/failed.
      const prePublicationFailure = yield* putMessage(
        events,
        summaryInfo({ parentID: u, finish: "error", error: abortError, completed: 7 }),
      ).pipe(Effect.exit)
      expect(Exit.isSuccess(prePublicationFailure)).toBeTrue()
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ finish: "error" })
    }),
  )

  it.effect("T022: stale blank, whitespace, type and owner updates to published summary content are rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedPart(db, sText)).data

      const blank = yield* putPart(events, textPart({ text: "" })).pipe(Effect.exit)
      expectRejected(blank, "published summary content conflict: content changed")

      const whitespace = yield* putPart(events, textPart({ text: "  \n\t " })).pipe(Effect.exit)
      expectRejected(whitespace, "published summary content conflict: content changed")

      const typeChanged = yield* putPart(events, {
        id: sText,
        sessionID: guardSession,
        messageID: s,
        type: "reasoning",
        text: "repurposed",
        time: { start: 1 },
      } as SessionV1.Part).pipe(Effect.exit)
      expectRejected(typeChanged, "published summary content conflict: content changed")

      const ownerChanged = yield* putPart(events, textPart({ text: "published summary content", messageID: u })).pipe(
        Effect.exit,
      )
      expectRejected(ownerChanged, "owner binding changed")

      expect((yield* storedPart(db, sText)).data).toEqual(before)
    }),
  )

  it.effect(
    "T022: summary text parts stream before publication and every readable part is frozen after it",
    () =>
      Effect.gen(function* () {
        const { db, events } = yield* setup
        // Two readable text parts accumulate on a still-unpublished summary.
        yield* putMessage(events, userInfo(u, { origin: "compaction" }))
        yield* putMessage(events, summaryInfo({ parentID: u }))
        yield* putPart(events, textPart({ text: "first readable part" }))
        yield* putPart(events, textPart({ id: sText2, text: "second readable part" }))
        yield* putPart(events, textPart({ id: sText2, text: "second readable part extended" }))
        yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
        yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
        yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
        yield* putPart(
          events,
          compactionPart({ publication: { state: "published", summaryID: s } }),
        )
        const firstBefore = (yield* storedPart(db, sText)).data
        const secondBefore = (yield* storedPart(db, sText2)).data

        // A nonempty rewrite of finalized content is a stale mutation, not an
        // append: publication is complete-before-publish, so no later writer
        // may change what the published pair already says.
        const rewritten = yield* putPart(events, textPart({ text: "first readable part extended" })).pipe(
          Effect.exit,
        )
        expectRejected(rewritten, "published summary content conflict: content changed")
        const extendedSecond = yield* putPart(events, textPart({ id: sText2, text: "third wording" })).pipe(
          Effect.exit,
        )
        expectRejected(extendedSecond, "published summary content conflict: content changed")
        const blankSecond = yield* putPart(events, textPart({ id: sText2, text: "" })).pipe(Effect.exit)
        expectRejected(blankSecond, "published summary content conflict: content changed")

        expect((yield* storedPart(db, sText)).data).toEqual(firstBefore)
        expect((yield* storedPart(db, sText2)).data).toEqual(secondBefore)

        // Identical content replay stays idempotent.
        yield* putPart(events, textPart({ id: sText2, text: "second readable part extended" }))
        expect((yield* storedPart(db, sText2)).data).toEqual(secondBefore)
      }),
  )

  it.effect("A1: a stale nonempty replacement cannot overwrite a published text part", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedPart(db, sText)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(events, textPart({ text: "The verified project state is B." })).pipe(
        Effect.exit,
      )

      expectRejected(exit, "published summary content conflict: content changed")
      expect((yield* storedPart(db, sText)).data).toEqual(before)
      expect((yield* storedPart(db, sText)).data as StoredPartData).toMatchObject({
        text: "published summary content",
      })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("A2: a new text part cannot be appended to an already published summary", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const extra = SessionV1.PartID.make("prt_guard_s_extra")
      const before = (yield* storedPart(db, sText)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(events, textPart({ id: extra, text: "post-publication appendix" })).pipe(
        Effect.exit,
      )

      expectRejected(exit, "new part after publication")
      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, extra)).get().pipe(Effect.orDie)).toBeUndefined()
      expect((yield* storedPart(db, sText)).data).toEqual(before)
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("A2: a new non-text part cannot be inserted into a published summary", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const extra = SessionV1.PartID.make("prt_guard_s_reasoning")
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(
        events,
        {
          id: extra,
          sessionID: guardSession,
          messageID: s,
          type: "reasoning",
          text: "post-publication provenance",
          time: { start: 1 },
        } as SessionV1.Part,
      ).pipe(Effect.exit)

      expectRejected(exit, "new part after publication")
      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, extra)).get().pipe(Effect.orDie)).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect(
    "B2 boundary: a premature publication cannot be completed by late content",
    () =>
      Effect.gen(function* () {
        const { db, events } = yield* setup
        yield* putMessage(events, userInfo(u, { origin: "compaction" }))
        yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
        yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
        yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
        const eventsBefore = (yield* aggregateEventIDs(db)).length

        // Publication without durable readable content is rejected inside the
        // event transaction, so no published binding ever exists for late
        // content to activate.
        const premature = yield* putPart(
          events,
          compactionPart({ publication: { state: "published", summaryID: s } }),
        ).pipe(Effect.exit)
        expectRejected(premature, "summary has no readable content")

        yield* putPart(events, textPart({ text: "first readable part" }))
        expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
        expect((yield* aggregateEventIDs(db))).not.toHaveLength(eventsBefore)
      }),
  )

  it.effect("A1: a stale update cannot fill an empty published text part", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, textPart({ text: "" }))
      yield* putPart(events, textPart({ id: sText2, text: "readable summary content" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))
      const before = (yield* storedPart(db, sText)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(events, textPart({ text: "late filled content" })).pipe(Effect.exit)

      expectRejected(exit, "published summary content conflict: content changed")
      expect((yield* storedPart(db, sText)).data).toEqual(before)
      expect((yield* storedPart(db, sText)).data as StoredPartData).toMatchObject({ text: "" })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("A2: a stale update cannot retype a published reasoning part into text", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const reasoning = SessionV1.PartID.make("prt_guard_s_reasoning_existing")
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, {
        id: reasoning,
        sessionID: guardSession,
        messageID: s,
        type: "reasoning",
        text: "published reasoning",
        time: { start: 1 },
      } as SessionV1.Part)
      yield* putPart(events, textPart({ text: "readable summary content" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))
      const before = (yield* storedPart(db, reasoning)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(
        events,
        textPart({ id: reasoning, text: "repurposed into text" }),
      ).pipe(Effect.exit)

      expectRejected(exit, "published summary content conflict: content changed")
      expect((yield* storedPart(db, reasoning)).data).toEqual(before)
      expect((yield* storedPart(db, reasoning)).data as StoredPartData).toMatchObject({ type: "reasoning" })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("A positive controls: ordinary parts, pre-publication summaries, and identical replay stay allowed", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      // Ordinary text part of a genuine user: mutable throughout.
      yield* putMessage(events, userInfo(y))
      yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary" }))
      yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary updated" }))

      // Pre-publication summary content: streamable and rewritable.
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, textPart({ text: "draft" }))
      yield* putPart(events, textPart({ text: "draft extended" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))

      // Identical-content replay of published summary content stays idempotent.
      const before = (yield* storedPart(db, sText)).data
      yield* putPart(events, textPart({ text: "draft extended" }))
      expect((yield* storedPart(db, sText)).data).toEqual(before)
      expect((yield* storedPart(db, yText)).data as StoredPartData).toMatchObject({ text: "ordinary updated" })
    }),
  )

  it.effect("B1: publishing a summary without readable durable content is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      const before = (yield* storedPart(db)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      expectRejected(exit, "summary has no readable content")
      expect((yield* storedPart(db)).data).toEqual(before)
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("B1: publishing a whitespace-only summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, textPart({ text: "  \n\t " }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))

      const exit = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      expectRejected(exit, "summary has no readable content")
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
    }),
  )

  it.effect("D: Unicode whitespace-only summaries are rejected and do not advance the event log", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))

      for (const text of ["\u00A0", "\u2003", "\u2028"]) {
        yield* putPart(events, textPart({ text }))
        yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
        const eventsBefore = (yield* aggregateEventIDs(db)).length
        const seqBefore = yield* aggregateSeq(db)

        const exit = yield* putPart(
          events,
          compactionPart({ publication: { state: "published", summaryID: s } }),
        ).pipe(Effect.exit)

        expectRejected(exit, "summary has no readable content")
        expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
          publication: { state: "preparing" },
        })
        expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
        expect(yield* aggregateSeq(db)).toBe(seqBefore)
      }

      // The genuinely readable control publishes successfully.
      yield* putPart(events, textPart({ text: "genuinely readable summary" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
    }),
  )

  it.effect("B1: publishing a missing summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      expectRejected(exit, "summary is missing")
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("B1: publishing an unsuccessful or mismatched summary is rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))

      // Error-finalized summary with readable text is not publishable.
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "error", error: abortError, completed: 3 }))
      yield* putPart(events, textPart({ text: "failed summary content" }))
      const failed = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(failed, "summary is not successful")

      // A summary owned by a different user cannot bind this publication.
      yield* putMessage(events, summaryInfo({ id: otherS, parentID: y, finish: "stop", completed: 4 }))
      yield* putPart(events, textPart({ id: sText2, messageID: otherS, text: "other summary content" }))
      const mismatched = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: otherS } }),
      ).pipe(Effect.exit)
      expectRejected(mismatched, "summary parent mismatch")

      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
    }),
  )

  it.effect("B2: late content cannot rescue a rejected premature publication", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))

      // The real gap-B trace: publish while S has no readable content.
      const premature = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(premature, "summary has no readable content")

      // Adding the first readable content afterwards must not create authority.
      yield* putPart(events, textPart({ text: "first readable part" }))
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "preparing" } })
      expect(
        yield* db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(sql`json_extract(${PartTable.data}, '$.publication.state') = 'published'`)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("B1: abandoned and legacy compaction parts cannot enter published", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, textPart({ text: "published summary content" }))

      yield* putPart(events, compactionPart({ publication: { state: "abandoned" } }))
      const abandoned = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(abandoned, "cannot publish from abandoned")
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({ publication: { state: "abandoned" } })

      // A legacy part (no publication metadata) is never migrated to published.
      yield* putPart(events, compactionPart())
      const legacy = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(legacy, "cannot publish from legacy")
      expect(((yield* storedPart(db)).data as StoredPartData).publication).toBeUndefined()
    }),
  )

  it.effect("B: a stale MessageUpdated cannot change the role of a published compaction owner", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, u)).data
      const eventsBefore = (yield* aggregateEventIDs(db)).length

      const exit = yield* putMessage(
        events,
        summaryInfo({ id: u, parentID: y, summary: false, finish: "stop", completed: 9 }),
      ).pipe(Effect.exit)

      expectRejected(exit, "published compaction owner conflict")
      expect((yield* storedMessage(db, u)).data).toEqual(before)
      expect((yield* storedMessage(db, u)).data as StoredMessageData).toMatchObject({ role: "user" })
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsBefore)
    }),
  )

  it.effect("B: stale synthetic-origin changes to a published compaction owner are rejected", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const before = (yield* storedMessage(db, u)).data

      const removed = yield* putMessage(events, userInfo(u)).pipe(Effect.exit)
      expectRejected(removed, "synthetic origin removed")

      const reclassified = yield* putMessage(events, userInfo(u, { origin: "recovery-preparation" })).pipe(
        Effect.exit,
      )
      expectRejected(reclassified, "synthetic origin changed")

      expect((yield* storedMessage(db, u)).data).toEqual(before)
      expect((yield* storedMessage(db, u)).data as StoredMessageData).toMatchObject({ role: "user" })
    }),
  )

  it.effect(
    "B: identical owner updates, unrelated users, and pre-publication owner updates stay allowed",
    () =>
      Effect.gen(function* () {
        const { db, events } = yield* seedPublished()
        const ownerBefore = (yield* storedMessage(db, u)).data

        // Exact same-record idempotent owner update.
        yield* putMessage(events, userInfo(u, { origin: "compaction" }))
        expect((yield* storedMessage(db, u)).data).toEqual(ownerBefore)

        // A user message that owns no published compaction keeps existing semantics.
        yield* putMessage(events, userInfo(y))
        const unrelated = yield* putMessage(
          events,
          summaryInfo({ id: y, parentID: u, summary: false, finish: "stop", completed: 4 }),
        ).pipe(Effect.exit)
        expect(Exit.isSuccess(unrelated)).toBeTrue()

        // Ordinary streaming text updates on an ordinary message stay allowed.
        yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary" }))
        yield* putPart(events, textPart({ id: yText, messageID: y, text: "ordinary updated" }))
        expect((yield* storedPart(db, yText)).data as StoredPartData).toMatchObject({ text: "ordinary updated" })
      }),
  )

  it.effect("B: pre-publication owner updates are not blocked by the owner guard", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))

      const exit = yield* putMessage(
        events,
        summaryInfo({ id: u, parentID: y, summary: false, finish: "stop", completed: 4 }),
      ).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBeTrue()
      expect((yield* storedMessage(db, u)).data as StoredMessageData).toMatchObject({ role: "assistant" })
    }),
  )

  it.effect("negative control 9: a mutation-free defective finalizer fails the published-summary acceptance", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const persisted = (yield* storedMessage(db, s)).data as StoredMessageData
      const staleFinalizer = summaryInfo({ parentID: u, finish: "error", error: abortError, completed: 9 })

      const exit = yield* putMessage(events, staleFinalizer).pipe(Effect.exit)
      expectRejected(exit, "published summary conflict")
      const afterRejected = (yield* storedMessage(db, s)).data as StoredMessageData

      const acceptance = (stored: StoredMessageData) => {
        expect(stored.summary).toBe(true)
        expect(stored.finish).toBe("stop")
        expect(stored.error).toBeUndefined()
        expect(stored.parentID).toBe(u as unknown as string)
      }

      // Test-local defective finalizer: overwrites stored S with the stale
      // payload the way an unguarded upsert would.
      const defectiveFinalizer = (stored: StoredMessageData, stale: StoredMessageData): StoredMessageData => ({
        ...stored,
        ...stale,
      })

      acceptance(afterRejected)
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      const defectiveResult = defectiveFinalizer(persisted, staleFinalizer as unknown as StoredMessageData)
      expect(defectiveResult.finish).toBe("error")
      expect(() => acceptance(defectiveResult)).toThrow()
    }),
  )

  it.effect("R-B: stale writes cannot recreate or complete a deleted published summary", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()

      // Authorized deletion of the published summary S.
      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID: guardSession, messageID: s })
      expect(
        yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.id, s))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      // The published compaction part remains persisted as published.
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // B1: a stale MessageUpdated recreates S with the same ID and no finish.
      const b1 = yield* putMessage(events, summaryInfo({ parentID: u })).pipe(Effect.exit)
      expectRejected(b1, "recreation of a deleted published summary")
      expect(
        yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.id, s))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // B2: a stale PartUpdated inserts text for the still-missing S.
      const b2 = yield* putPart(events, textPart({ text: "resurrected summary content" })).pipe(Effect.exit)
      expect(Exit.isFailure(b2)).toBeTrue()
      expect(
        yield* db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(eq(PartTable.message_id, s))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // B3: a stale MessageUpdated tries to complete the still-missing S.
      const b3 = yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 })).pipe(
        Effect.exit,
      )
      expectRejected(b3, "recreation of a deleted published summary")
      expect(
        yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.id, s))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)
    }),
  )

  it.effect("R-B2: an ordinary unbound summary keeps create/complete/content semantics", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      // A brand-new summary with no published binding: create, stream content,
      // and complete exactly as before the deletion guards.
      yield* putMessage(events, userInfo(y))
      yield* putMessage(events, summaryInfo({ id: otherS, parentID: y }))
      yield* putPart(events, textPart({ id: sText2, messageID: otherS, text: "ordinary summary content" }))
      yield* putMessage(events, summaryInfo({ id: otherS, parentID: y, finish: "stop", completed: 4 }))
      expect((yield* storedMessage(db, otherS)).data as StoredMessageData).toMatchObject({
        summary: true,
        finish: "stop",
      })
      expect((yield* storedPart(db, sText2)).data as StoredPartData).toMatchObject({
        text: "ordinary summary content",
      })
    }),
  )

  it.effect("R-C: a deleted published compaction part cannot be reinserted by a stale update", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const publishedPayload = compactionPart({ publication: { state: "published", summaryID: s } })

      // Authorized deletion of the published compaction part P.
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: guardSession,
        messageID: u,
        partID: p,
      })
      expect(
        yield* db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(eq(PartTable.id, p))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // A stale producer resubmits the exact deleted published part with a
      // fresh durable event ID and the next valid sequence.
      const stale = yield* putPart(events, publishedPayload).pipe(Effect.exit)
      expectRejected(stale, "previously removed")
      expect(
        yield* db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(eq(PartTable.id, p))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R3: a NEW part ID under the SAME owner is also rejected — the
      // authorized PartRemoved deleted the owner's publication operation, not
      // just one row. Legitimate fresh-owner publication (compaction retry,
      // fork clone in a new aggregate) is covered by the R3 test.
      const p2 = SessionV1.PartID.make("prt_guard_p2")
      const newID = yield* putPart(events, { ...publishedPayload, id: p2 }).pipe(Effect.exit)
      expectRejected(newID, "owner publication was previously removed")
      expect(
        yield* db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(eq(PartTable.id, p2))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)
    }),
  )

  // R1: The prior R-B guard rejected only a *direct* summary-flagged
  // recreation. This pins the "ordinary assistant state" bypass: a stale
  // writer recreates the deleted summary ID as a NON-summary assistant, adds
  // readable text, then flips it to summary:true/finish:stop — making the
  // still-persisted published part authoritative again. It also pins the
  // role-flip variant (create as user, then change role to assistant).
  it.effect("R1: a deleted published summary cannot be resurrected through ordinary assistant state", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup

      // Older applicable publication (U0 -> P0 -> S0), so the reader has a
      // genuine fallback target once S is deleted.
      const u0 = SessionV1.MessageID.make("msg_guard_u0")
      const p0 = SessionV1.PartID.make("prt_guard_p0")
      const s0 = SessionV1.MessageID.make("msg_guard_s0")
      const s0Text = SessionV1.PartID.make("prt_guard_s0_text")
      yield* putMessage(events, userInfo(u0, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ id: s0, parentID: u0, finish: "stop", completed: 1 }))
      yield* putPart(events, textPart({ id: s0Text, messageID: s0, text: "older published summary" }))
      yield* putPart(events, compactionPart({ id: p0, messageID: u0, publication: { state: "published", summaryID: s0 } }))

      // Completed published U/P/S.
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, textPart({ text: "published summary content" }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))

      // Authorized MessageRemoved(S). The newer published part stays persisted
      // (dangling) while the older publication remains the fallback target.
      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID: guardSession, messageID: s })
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, s)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      expect((yield* storedPart(db, p0)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s0 as unknown as string },
      })
      expect((yield* storedMessage(db, s0)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // R1.1: recreate as a plain (non-summary) assistant.
      const r1 = yield* putMessage(events, summaryInfo({ parentID: u, summary: false })).pipe(Effect.exit)
      expectRejected(r1, "message conflict: previously removed")
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, s)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R1.2: add readable text under the still-missing summary.
      const r2 = yield* putPart(events, textPart({ text: "resurrected summary content" })).pipe(Effect.exit)
      expect(Exit.isFailure(r2)).toBeTrue()
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.message_id, s)).all().pipe(Effect.orDie),
      ).toEqual([])
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R1.3: flip the (still-missing) row into a successful summary.
      const r3 = yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 })).pipe(Effect.exit)
      expectRejected(r3, "published summary conflict: recreation of a deleted published summary")
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, s)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R1-alt: recreate as a user first, then change role to a successful
      // assistant summary.
      const r4 = yield* putMessage(events, userInfo(s)).pipe(Effect.exit)
      expectRejected(r4, "message conflict: previously removed")
      const r5 = yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 })).pipe(Effect.exit)
      expectRejected(r5, "published summary conflict: recreation of a deleted published summary")
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, s)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // The newer published part is still dangling (non-authoritative) and the
      // older publication is untouched, so the reader keeps its fallback.
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      expect((yield* storedPart(db, p0)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s0 as unknown as string },
      })
      expect((yield* storedMessage(db, s0)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
    }),
  )

  // R2: MessageRemoved(U) cascades the compaction part away WITHOUT a
  // PartRemoved event, so guardRemovedPartRecreation's explicit-PartRemoved
  // lookup sees nothing. A stale writer that reuses the same synthetic U and P
  // ids must not resurrect the deleted pair. A genuinely NEW owner keeps working.
  it.effect("R2: a deleted owner and its cascade-deleted part cannot be recreated by stale ids", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()

      // Authorized deletion of the published owner U (cascades P away).
      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID: guardSession, messageID: u })
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, u)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      // S remains an orphaned, completed, readable summary.
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
      expect((yield* storedPart(db, sText)).data as StoredPartData).toMatchObject({ text: "published summary content" })
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // R2.1: recreate the same synthetic owner U.
      const r1 = yield* putMessage(events, userInfo(u, { origin: "compaction" })).pipe(Effect.exit)
      expectRejected(r1, "message conflict: previously removed")
      expect(
        yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, u)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R2.2: recreate the cascade-deleted compaction part under the SAME
      // deleted owner id, queued.
      const r2 = yield* putPart(events, compactionPart({ publication: { state: "queued" } })).pipe(Effect.exit)
      expectRejected(r2, "compaction part conflict: owner message was previously removed")
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()

      // R2.3: transition the SAME deleted part id to published, binding the
      // surviving orphan summary.
      const r3 = yield* putPart(
        events,
        compactionPart({ publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(r3, "compaction part conflict: owner message was previously removed")
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // Positive control: a genuinely NEW synthetic owner with its own queued
      // part (a fresh compaction attempt) is unaffected.
      const freshOwner = SessionV1.MessageID.make("msg_guard_u_fresh")
      const freshPart = SessionV1.PartID.make("prt_guard_fresh")
      yield* putMessage(events, userInfo(freshOwner, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ id: freshPart, messageID: freshOwner, publication: { state: "queued" } }))
      expect((yield* storedPart(db, freshPart)).data as StoredPartData).toMatchObject({
        publication: { state: "queued" },
      })
    }),
  )

  // R3: PartRemoved(P) leaves durable removal evidence for the owner's
  // publication operation. A NEW part id under the SAME owner must not
  // re-bind the same summary (or restart a queued attempt) and revive the
  // explicitly removed publication. Legitimate flows — SessionCompaction.create
  // and Session.fork — always use a fresh synthetic owner (in a fresh
  // session/aggregate for fork), which stays allowed below.
  it.effect("R3: a new part id under the same owner cannot revive an explicitly removed publication", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()

      // Authorized PartRemoved of the published compaction part P.
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: guardSession,
        messageID: u,
        partID: p,
      })
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      // U and S survive; only the publication binding was deleted.
      expect((yield* storedMessage(db, u)).data as StoredMessageData).toMatchObject({ role: "user" })
      expect((yield* storedMessage(db, s)).data as StoredMessageData).toMatchObject({ summary: true, finish: "stop" })
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // R3.1: directly publish a NEW part id P2 under the SAME owner, same S.
      const p2 = SessionV1.PartID.make("prt_guard_p2")
      const r1 = yield* putPart(
        events,
        compactionPart({ id: p2, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expectRejected(r1, "compaction part conflict: owner publication was previously removed")
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p2)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // R3.2: queue a NEW part id P3 under the SAME owner.
      const p3 = SessionV1.PartID.make("prt_guard_p3")
      const r2 = yield* putPart(events, compactionPart({ id: p3, publication: { state: "queued" } })).pipe(Effect.exit)
      expectRejected(r2, "compaction part conflict: owner publication was previously removed")
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p3)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect((yield* aggregateEventIDs(db))).toHaveLength(eventsAfterDeletion)
      expect(yield* aggregateSeq(db)).toBe(seqAfterDeletion)

      // Positive control: a genuinely NEW synthetic owner can run the full
      // queued -> published lifecycle with a fresh part binding the SAME
      // surviving summary content shape (fresh S).
      const freshOwner = SessionV1.MessageID.make("msg_guard_r3_u2")
      const freshSummary = SessionV1.MessageID.make("msg_guard_r3_s2")
      const freshText = SessionV1.PartID.make("prt_guard_r3_s2_text")
      const freshPart = SessionV1.PartID.make("prt_guard_r3_p2")
      yield* putMessage(events, userInfo(freshOwner, { origin: "compaction" }))
      yield* putPart(events, compactionPart({ id: freshPart, messageID: freshOwner, publication: { state: "queued" } }))
      yield* putMessage(events, summaryInfo({ id: freshSummary, parentID: freshOwner, finish: "stop", completed: 9 }))
      yield* putPart(events, textPart({ id: freshText, messageID: freshSummary, text: "fresh summary content" }))
      yield* putPart(
        events,
        compactionPart({ id: freshPart, messageID: freshOwner, publication: { state: "preparing" } }),
      )
      yield* putPart(
        events,
        compactionPart({
          id: freshPart,
          messageID: freshOwner,
          publication: { state: "published", summaryID: freshSummary },
        }),
      )
      expect((yield* storedPart(db, freshPart)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: freshSummary as unknown as string },
      })
    }),
  )

  // Positive control for R1: a genuinely NEW message ID is never confused
  // with a removed one — ordinary assistants, users, and pre-publication
  // summary streaming keep their existing semantics.
  it.effect("R1 control: new message ids are unaffected by removal evidence", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* putMessage(events, userInfo(y))
      yield* putMessage(events, summaryInfo({ id: otherS, parentID: y, summary: false }))
      yield* putPart(events, textPart({ id: sText2, messageID: otherS, text: "ordinary" }))
      yield* putMessage(events, summaryInfo({ id: otherS, parentID: y, finish: "stop", completed: 4 }))
      expect((yield* storedMessage(db, otherS)).data as StoredMessageData).toMatchObject({ finish: "stop" })
      expect((yield* storedPart(db, sText2)).data as StoredPartData).toMatchObject({ text: "ordinary" })
    }),
  )

  // R4a: guardRemovedPartRecreation previously ran ONLY when the part row did
  // not exist, so owner-level deletion evidence was checked only for a brand
  // new compaction part id. A stale writer could insert an ordinary text part
  // under the deleted publication's owner and then retype that EXISTING row
  // into a compaction part — bypassing every removal guard, committing durable
  // events, and restoring the authorized-deleted publication. The probes below
  // walk both the direct retype and the queued -> preparing -> published path.
  it.effect("R4a: an ordinary part retyped to compaction cannot revive a deleted publication", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup

      // Prior applicable publication (U0 -> P0 -> S0), the fallback target.
      const u0 = SessionV1.MessageID.make("msg_guard_u0")
      const p0 = SessionV1.PartID.make("prt_guard_p0")
      const s0 = SessionV1.MessageID.make("msg_guard_s0")
      const s0Text = SessionV1.PartID.make("prt_guard_s0_text")
      yield* putMessage(events, userInfo(u0, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ id: s0, parentID: u0, finish: "stop", completed: 1 }))
      yield* putPart(events, textPart({ id: s0Text, messageID: s0, text: "older published summary" }))
      yield* putPart(events, compactionPart({ id: p0, messageID: u0, publication: { state: "published", summaryID: s0 } }))

      // Completed published U/P1/S.
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, textPart({ text: "published summary content" }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))

      // Authorized PartRemoved of the publication binding. U and S survive;
      // only the binding row is deleted.
      yield* events.publish(SessionV1.Event.PartRemoved, { sessionID: guardSession, messageID: u, partID: p })
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()

      // An ordinary text part under the SAME owner remains ordinary work.
      const t = SessionV1.PartID.make("prt_guard_r4a_t")
      yield* putPart(events, textPart({ id: t, messageID: u, text: "ordinary under owner" }))
      const eventsAfterText = (yield* aggregateEventIDs(db)).length
      const seqAfterText = yield* aggregateSeq(db)

      // Probe 1: retype the existing row directly into a published compaction
      // bound to the removed publication's exact summary.
      const direct = yield* putPart(
        events,
        compactionPart({ id: t, messageID: u, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)
      expect((yield* aggregateEventIDs(db)).length).toBe(eventsAfterText)
      expect(yield* aggregateSeq(db)).toBe(seqAfterText)

      // Probe 2: a second fresh ordinary row walked through the full writer
      // lifecycle: queued -> preparing -> published. The ordinary text insert
      // itself stays allowed and commits one event.
      const t2 = SessionV1.PartID.make("prt_guard_r4a_t2")
      yield* putPart(events, textPart({ id: t2, messageID: u, text: "ordinary path two" }))
      const eventsAfterT2 = (yield* aggregateEventIDs(db)).length
      const seqAfterT2 = yield* aggregateSeq(db)
      const queued = yield* putPart(events, compactionPart({ id: t2, messageID: u, publication: { state: "queued" } })).pipe(
        Effect.exit,
      )
      const preparing = yield* putPart(
        events,
        compactionPart({ id: t2, messageID: u, publication: { state: "preparing" } }),
      ).pipe(Effect.exit)
      const published = yield* putPart(
        events,
        compactionPart({ id: t2, messageID: u, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      // One observed-outcome record: pre-fix every probe commits (events and
      // sequence advance, the deleted publication returns); post-fix every
      // probe is rejected inside the per-event transaction and the deletion
      // remains authoritative.
      expect({
        directRejected: Exit.isFailure(direct),
        queuedRejected: Exit.isFailure(queued),
        preparingRejected: Exit.isFailure(preparing),
        publishedRejected: Exit.isFailure(published),
        compactionPartsUnderOwner: (yield* compactionPartsUnder(db, u)).map((row) => row.id).sort(),
        events: (yield* aggregateEventIDs(db)).length,
        seq: yield* aggregateSeq(db),
      }).toEqual({
        directRejected: true,
        queuedRejected: true,
        preparingRejected: true,
        publishedRejected: true,
        compactionPartsUnderOwner: [],
        events: eventsAfterT2,
        seq: seqAfterT2,
      })

      // Deletion remains authoritative: no compaction part survives under U,
      // the ordinary text rows are unchanged, and the prior applicable
      // publication is untouched.
      expect((yield* storedPart(db, p0)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s0 as unknown as string },
      })
      expect((yield* storedPart(db, t)).data as StoredPartData).toMatchObject({
        type: "text",
        text: "ordinary under owner",
      })
      expect((yield* storedPart(db, t2)).data as StoredPartData).toMatchObject({ type: "text" })
      expect((yield* storedPart(db, sText)).data as StoredPartData).toMatchObject({
        text: "published summary content",
      })
    }),
  )

  // R4b: the key boundary missing from guardRemovedPartRecreation — the
  // persisted row for the ordinary part EXISTS before the stale update. An
  // ordinary part already present under the owner must not be repurposed into
  // the removed publication after an authorized PartRemoved, and the exact
  // removed part id must not re-enter through an ordinary-text reinsertion
  // followed by a retype.
  it.effect("R4b: an existing ordinary part under the owner cannot be repurposed after deletion", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup

      // Published U/P1/S plus two ordinary text parts already present under U.
      yield* putMessage(events, userInfo(u, { origin: "compaction" }))
      yield* putMessage(events, summaryInfo({ parentID: u, finish: "stop", completed: 3 }))
      yield* putPart(events, textPart({ text: "published summary content" }))
      yield* putPart(events, compactionPart({ publication: { state: "queued" } }))
      yield* putPart(events, compactionPart({ publication: { state: "preparing" } }))
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))
      const t1 = SessionV1.PartID.make("prt_guard_r4b_t1")
      const t2 = SessionV1.PartID.make("prt_guard_r4b_t2")
      yield* putPart(events, textPart({ id: t1, messageID: u, text: "ordinary one" }))
      yield* putPart(events, textPart({ id: t2, messageID: u, text: "ordinary two" }))

      // Authorized PartRemoved(P1): both ordinary rows already exist.
      yield* events.publish(SessionV1.Event.PartRemoved, { sessionID: guardSession, messageID: u, partID: p })
      expect(
        yield* db.select({ id: PartTable.id }).from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      const eventsAfterDeletion = (yield* aggregateEventIDs(db)).length
      const seqAfterDeletion = yield* aggregateSeq(db)

      // Probe A: retype the pre-existing row T1 directly to published.
      const direct = yield* putPart(
        events,
        compactionPart({ id: t1, messageID: u, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      // Probe B: the pre-existing row T2 walks queued -> preparing -> published.
      const queued = yield* putPart(events, compactionPart({ id: t2, messageID: u, publication: { state: "queued" } })).pipe(
        Effect.exit,
      )
      const preparing = yield* putPart(
        events,
        compactionPart({ id: t2, messageID: u, publication: { state: "preparing" } }),
      ).pipe(Effect.exit)
      const published = yield* putPart(
        events,
        compactionPart({ id: t2, messageID: u, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      // Probe C: reinsert the EXACT removed P1 id as ordinary text first —
      // ordinary text part updates are never scanned, so this stays allowed.
      const reinsert = yield* putPart(events, textPart({ id: p, messageID: u, text: "reinserted as ordinary" })).pipe(
        Effect.exit,
      )
      const eventsAfterReinsert = (yield* aggregateEventIDs(db)).length
      const seqAfterReinsert = yield* aggregateSeq(db)

      // Probe D: retype the reinserted removed id into a compaction part.
      const retypeRemoved = yield* putPart(
        events,
        compactionPart({ id: p, messageID: u, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      // One observed-outcome record: pre-fix probes A/B/D commit and restore
      // the deleted publication under surviving ordinary rows; post-fix only
      // probe C (ordinary text) commits and the deletion stands.
      expect({
        directRejected: Exit.isFailure(direct),
        queuedRejected: Exit.isFailure(queued),
        preparingRejected: Exit.isFailure(preparing),
        publishedRejected: Exit.isFailure(published),
        reinsertAccepted: Exit.isSuccess(reinsert),
        retypeRemovedRejected: Exit.isFailure(retypeRemoved),
        t1Type: ((yield* storedPart(db, t1)).data as StoredPartData).type,
        t2Type: ((yield* storedPart(db, t2)).data as StoredPartData).type,
        pType: ((yield* storedPart(db, p)).data as StoredPartData).type,
        compactionPartsUnderOwner: (yield* compactionPartsUnder(db, u)).map((row) => row.id).sort(),
        events: (yield* aggregateEventIDs(db)).length,
        seq: yield* aggregateSeq(db),
      }).toEqual({
        directRejected: true,
        queuedRejected: true,
        preparingRejected: true,
        publishedRejected: true,
        reinsertAccepted: true,
        retypeRemovedRejected: true,
        t1Type: "text",
        t2Type: "text",
        pType: "text",
        compactionPartsUnderOwner: [],
        events: eventsAfterReinsert,
        seq: seqAfterReinsert,
      })

      // No pending or published compaction survives under the original owner.
      expect(eventsAfterReinsert).toBe(eventsAfterDeletion + 1)
      expect(seqAfterReinsert).toBe(seqAfterDeletion + 1)
      expect((yield* storedPart(db, p)).data as StoredPartData).toMatchObject({ text: "reinserted as ordinary" })
    }),
  )

  // R4c: the projector previously allowed a second compaction part under one
  // owner while the first was still published. Such a duplicate could then
  // survive an authorized PartRemoved of the original publication and regain
  // runnable/authoritative state. A single compaction operation is owned by
  // U.id (SessionCompaction.create and Session.fork always allocate fresh
  // owners), so duplicate-owner creation is blocked at the creation boundary.
  it.effect("R4c: a second compaction part cannot be created under an owner that already has one", () =>
    Effect.gen(function* () {
      const { db, events } = yield* seedPublished()
      const eventsBefore = (yield* aggregateEventIDs(db)).length
      const seqBefore = yield* aggregateSeq(db)

      // Probe 1: distinct part id, same owner, queued while P1 is published.
      const p2 = SessionV1.PartID.make("prt_guard_r4c_p2")
      const duplicateQueued = yield* putPart(
        events,
        compactionPart({ id: p2, publication: { state: "queued" } }),
      ).pipe(Effect.exit)

      // Probe 2: distinct part id, same owner, directly published with exact S.
      const p3 = SessionV1.PartID.make("prt_guard_r4c_p3")
      const duplicatePublished = yield* putPart(
        events,
        compactionPart({ id: p3, publication: { state: "published", summaryID: s } }),
      ).pipe(Effect.exit)

      expect({
        duplicateQueuedRejected: Exit.isFailure(duplicateQueued),
        duplicatePublishedRejected: Exit.isFailure(duplicatePublished),
        compactionPartsUnderOwner: (yield* compactionPartsUnder(db, u)).map((row) => row.id).sort(),
        events: (yield* aggregateEventIDs(db)).length,
        seq: yield* aggregateSeq(db),
      }).toEqual({
        duplicateQueuedRejected: true,
        duplicatePublishedRejected: true,
        compactionPartsUnderOwner: [p],
        events: eventsBefore,
        seq: seqBefore,
      })

      // The legitimate same-row lifecycle of the single part is unaffected.
      yield* putPart(events, compactionPart({ publication: { state: "published", summaryID: s } }))
      expect((yield* storedPart(db)).data as StoredPartData).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      expect((yield* compactionPartsUnder(db, u)).map((row) => row.id)).toEqual([p])
    }),
  )
})
