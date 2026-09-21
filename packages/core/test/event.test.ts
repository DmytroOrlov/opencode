import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)
const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventV2.define({
  type: "test.sent",
  durable: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventV2.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventV2.define({
  type: "test.versioned",
  durable: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)
const itWithoutLocation = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))
const itProjected = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

describe("EventV2", () => {
  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceV2.ID.make("wrk_test"),
      })
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(VersionedMessage, { id: "one", text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.durable?.version).toBe(2)
    }),
  )

  it.effect("selects the latest durable definition independent of declaration order", () =>
    Effect.sync(() => {
      const latest = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      const historical = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(Event.latest([latest, historical]).get("test.out-of-order")).toBe(latest)
      expect(Event.latest([historical, latest]).get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ id: "one", text: "after unsubscribe" })
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a durable event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("notifies global listeners only after a durable event is committed", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed = new Array<{ id: string; seq: number }>()
      yield* events.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: EventTable.id, seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.id, event.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.tap((row) =>
                  Effect.sync(() => {
                    if (row) observed.push(row)
                  }),
                ),
                Effect.asVoid,
              ),
      )

      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "committed" })
      if (!event.durable) throw new Error("Expected durable event metadata")

      expect(observed).toEqual([{ id: event.id, seq: event.durable.seq }])
    }),
  )

  it.effect("ends only an overflowing bounded subscriber without blocking other listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const consuming = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const slowStream = yield* EventV2.allBounded(events, 1)
      const fastStream = yield* EventV2.allBounded(events, 8)
      const slow = yield* slowStream.pipe(
        Stream.runForEach(() => Deferred.succeed(consuming, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.forkScoped,
      )
      const fast = yield* fastStream.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(Message, { text: "one" })
      yield* Deferred.await(consuming)
      yield* events.publish(Message, { text: "two" })
      yield* events.publish(Message, { text: "overflow" })
      const last = yield* events.publish(Message, { text: "still delivered" })
      yield* Deferred.succeed(release, undefined)

      const slowExit = yield* Fiber.await(slow)
      expect(Exit.findErrorOption(slowExit).pipe(Option.getOrUndefined)).toBeInstanceOf(EventV2.SubscriberOverflowError)
      expect(Array.from(yield* Fiber.join(fast))).toEqual([
        expect.objectContaining({ data: { text: "one" } }),
        expect.objectContaining({ data: { text: "two" } }),
        expect.objectContaining({ data: { text: "overflow" } }),
        last,
      ])
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventV2.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))
      const fiber = yield* events
        .durable({ aggregateID, after: 0 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(DurableMessage, durableData(aggregateID, "two"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(DurableMessage, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const count = 64
      const fiber = yield* events
        .durable({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(DurableMessage, durableData(aggregateID, "durable"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("replays durable events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "hello"),
      })

      expect(received[0]?.type).toBe(DurableMessage.type)
      expect(received[0]?.data).toEqual(durableData(aggregateID, "hello"))
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = Session.ID.create()
        const payloadAggregateID = Session.ID.create()
        const received = new Array<EventV2.Payload>()
        yield* events.publish(DurableMessage, durableData(payloadAggregateID, "seed"))
        yield* events.project(DurableMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: durableData(payloadAggregateID, "replayed"),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 5,
          aggregateID,
          data: durableData(aggregateID, "bad"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const received = new Array<typeof SessionEvent.ContextUpdated.Type>()
      yield* events.project(SessionEvent.ContextUpdated, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SessionEvent.ContextUpdated.type, 1),
        seq: 0,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_context", timestamp: 0, text: "context" },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventV2.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "three"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 3,
          aggregateID,
          data: durableData(aggregateID, "four"),
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner fences exact replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      const replayed = {
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "owned"),
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      const exit = yield* events.replay(replayed, { ownerID: "owner-b", strictOwner: true }).pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "owned"))
      const replayed = {
        id: published.id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row?.ownerID).toBe("owner-a")
      const exit = yield* events
        .replay(
          { ...replayed, id: EventV2.ID.create(), seq: 1, data: durableData(aggregateID, "conflict") },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "owned"),
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "local"))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "fenced"),
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([{ id: replayed.id, durable: { seq: 0, version: 1 }, data: replayed.data }])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "original"),
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: durableData(aggregateID, "divergent") }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      yield* events.replay({
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })

      const exit = yield* events
        .replay({
          id,
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "second"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "first"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2" })
    }),
  )

  it.effect("remove clears durable event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.remove(aggregateID)
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })

      expect(received[0]?.data).toEqual(durableData(aggregateID, "replayed"))
    }),
  )
})

describe("EventV2 publication guard transactions", () => {
  const guardModel = { id: ModelV2.ID.make("t23_model"), providerID: ProviderV2.ID.make("t23_provider") }
  const u = SessionV1.MessageID.make("msg_t23_u")
  const s = SessionV1.MessageID.make("msg_t23_s")
  const y = SessionV1.MessageID.make("msg_t23_y")
  const tail = SessionV1.MessageID.make("msg_t23_tail")
  const p = SessionV1.PartID.make("prt_t23_p")
  const sText = SessionV1.PartID.make("prt_t23_text")
  const sText2 = SessionV1.PartID.make("prt_t23_text2")

  const userMsg = (sessionID: Session.ID, id: SessionV1.MessageID, input: { origin?: string } = {}) =>
    ({
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "user",
      model: { providerID: guardModel.providerID, modelID: guardModel.id },
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    }) as SessionV1.User

  const summaryMsg = (
    sessionID: Session.ID,
    input: { finish?: string; error?: SessionV1.Assistant["error"]; completed?: number },
  ) =>
    ({
      id: s,
      sessionID,
      role: "assistant",
      time: { created: 2, ...(input.completed !== undefined ? { completed: input.completed } : {}) },
      summary: true,
      parentID: u,
      modelID: guardModel.id,
      providerID: guardModel.providerID,
      mode: "",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.finish !== undefined ? { finish: input.finish } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    }) as SessionV1.Assistant

  const ownerDemotion = (sessionID: Session.ID): SessionV1.Info =>
    ({
      id: u,
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 9 },
      parentID: s,
      modelID: guardModel.id,
      providerID: guardModel.providerID,
      mode: "",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }) as SessionV1.Info

  const compaction = (
    sessionID: Session.ID,
    input: {
      publication?: NonNullable<SessionV1.CompactionPart["publication"]>
      tail?: SessionV1.MessageID
      messageID?: SessionV1.MessageID
      id?: SessionV1.PartID
    } = {},
  ): SessionV1.CompactionPart => ({
    id: input.id ?? p,
    sessionID,
    messageID: input.messageID ?? u,
    type: "compaction",
    auto: true,
    ...(input.tail !== undefined ? { tail_start_id: input.tail } : {}),
    ...(input.publication !== undefined ? { publication: input.publication } : {}),
  })

  const textOf = (
    sessionID: Session.ID,
    input: { id?: SessionV1.PartID; text: string; messageID?: SessionV1.MessageID },
  ): SessionV1.TextPart => ({
    id: input.id ?? sText,
    sessionID,
    messageID: input.messageID ?? s,
    type: "text",
    text: input.text,
  })

  const setup = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessionID = Session.ID.create()
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
        slug: "t23",
        directory: "/project",
        title: "t23",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return { db, events, sessionID }
  })

  const seedPublication = (input: { readonly secondText?: boolean } = {}) =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* setup
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: userMsg(sessionID, u, { origin: "compaction" }) })
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: summaryMsg(sessionID, { finish: "stop", completed: 3 }) })
      const textEvent = yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: textOf(sessionID, { text: "published summary content" }), time: 1 })
      if (input.secondText) {
        yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: textOf(sessionID, { id: sText2, text: "second readable part" }), time: 1 })
      }
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: compaction(sessionID, { publication: { state: "queued" } }), time: 1 })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: compaction(sessionID, { publication: { state: "preparing" } }), time: 1 })
      const published = yield* events.publish(
        SessionV1.Event.PartUpdated,
        { sessionID, part: compaction(sessionID, { publication: { state: "published", summaryID: s }, tail }), time: 1 },
      )
      return { db, events, sessionID, textEvent, published }
    })

  const capture = (db: Database.Interface["db"], sessionID: Session.ID) =>
    Effect.gen(function* () {
      const partRow = yield* db.select().from(PartTable).where(eq(PartTable.id, p)).get().pipe(Effect.orDie)
      const messageRow = yield* db.select().from(MessageTable).where(eq(MessageTable.id, s)).get().pipe(Effect.orDie)
      const ownerRow = yield* db.select().from(MessageTable).where(eq(MessageTable.id, u)).get().pipe(Effect.orDie)
      const textRow = yield* db.select().from(PartTable).where(eq(PartTable.id, sText)).get().pipe(Effect.orDie)
      const summaryParts = yield* db
        .select({ id: PartTable.id, data: PartTable.data })
        .from(PartTable)
        .where(eq(PartTable.message_id, s))
        .orderBy(PartTable.id)
        .all()
        .pipe(Effect.orDie)
      const eventIDs = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const seq = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return {
        part: partRow?.data,
        message: messageRow?.data,
        owner: ownerRow?.data,
        text: textRow?.data,
        summaryParts,
        eventIDs: eventIDs.map((row) => row.id),
        seq: seq?.seq,
      }
    })

  const expectRollback = <A, E>(exit: Exit.Exit<A, E>, reason: string) => {
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(String(exit)).toContain(reason)
  }

  const publishNextValid = (events: EventV2.Interface, sessionID: Session.ID, expectedSeq: number | undefined) =>
    Effect.gen(function* () {
      const next = yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: userMsg(sessionID, y),
      })
      expect(next.durable?.seq).toBe((expectedSeq ?? -1) + 1)
      return next
    })

  itProjected.effect("a live stale PartUpdated rolls back projection, event log and sequence together", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)

      const exit = yield* events
        .publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: compaction(sessionID, { publication: { state: "queued" } }),
          time: 2,
        })
        .pipe(Effect.exit)

      expectRollback(exit, "compaction publication conflict")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      yield* publishNextValid(events, sessionID, baseline.seq)
      expect(((yield* capture(db, sessionID)).part as { publication?: { state?: string } } | undefined)?.publication)
        .toMatchObject({ state: "published", summaryID: s as unknown as string })
    }),
  )

  itProjected.effect("a live stale MessageUpdated failure finalizer rolls back the published summary", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)

      const exit = yield* events
        .publish(SessionV1.Event.MessageUpdated, {
          sessionID,
          info: summaryMsg(sessionID, {
            finish: "error",
            error: { name: "MessageAbortedError", data: { message: "cancelled" } } as SessionV1.Assistant["error"],
            completed: 9,
          }),
        })
        .pipe(Effect.exit)

      expectRollback(exit, "published summary conflict")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      yield* publishNextValid(events, sessionID, baseline.seq)
      const message = (yield* capture(db, sessionID)).message as
        | { finish?: string; summary?: boolean; error?: unknown }
        | undefined
      expect(message).toMatchObject({ summary: true, finish: "stop" })
      expect(message?.error).toBeUndefined()
    }),
  )

  itProjected.effect("a live stale blanking of published summary content rolls back the text part", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)

      const exit = yield* events
        .publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: textOf(sessionID, { text: "" }),
          time: 2,
        })
        .pipe(Effect.exit)

      expectRollback(exit, "published summary content conflict")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      yield* publishNextValid(events, sessionID, baseline.seq)
      expect((yield* capture(db, sessionID)).text).toMatchObject({ text: "published summary content" })
    }),
  )

  itProjected.effect("exact replay stays idempotent while conflicting replay is rejected at the next sequence", () =>
    Effect.gen(function* () {
      const { db, events, sessionID, published } = yield* seedPublication()
      yield* events.claim(sessionID, "owner-t23")
      const baseline = yield* capture(db, sessionID)
      const versioned = EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1)

      // 1. Exact identical replay of the committed publication is a no-op.
      yield* events.replay(
        {
          id: published.id,
          type: versioned,
          seq: published.durable!.seq,
          aggregateID: sessionID,
          data: published.data,
        },
        { ownerID: "owner-t23", strictOwner: true },
      )
      expect(yield* capture(db, sessionID)).toEqual(baseline)

      // 2. Owner fencing and sequence requirements stay EventV2's own and are
      //    distinct from the publication guard.
      const fenced = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: versioned,
            seq: (baseline.seq ?? -1) + 1,
            aggregateID: sessionID,
            data: { sessionID, part: compaction(sessionID, { publication: { state: "queued" } }), time: 3 },
          },
          { ownerID: "intruder", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(fenced)).toContain("Replay owner mismatch")
      expect(yield* capture(db, sessionID)).toEqual(baseline)

      const mismatch = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: versioned,
            seq: (baseline.seq ?? -1) + 5,
            aggregateID: sessionID,
            data: { sessionID, part: compaction(sessionID, { publication: { state: "queued" } }), time: 3 },
          },
          { ownerID: "owner-t23" },
        )
        .pipe(Effect.exit)
      expect(String(mismatch)).toContain("Sequence mismatch")
      expect(yield* capture(db, sessionID)).toEqual(baseline)

      // 3. A structurally valid stale contradictory publication submitted
      //    through supported replay at the next admissible sequence is
      //    rejected by the projector itself.
      const stale = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: versioned,
            seq: (baseline.seq ?? -1) + 1,
            aggregateID: sessionID,
            data: { sessionID, part: compaction(sessionID, { publication: { state: "queued" } }), time: 3 },
          },
          { ownerID: "owner-t23" },
        )
        .pipe(Effect.exit)
      expectRollback(stale, "compaction publication conflict")
      expect(yield* capture(db, sessionID)).toEqual(baseline)

      // 4. The next valid event still commits at the expected contiguous
      //    sequence, and the reopened projection keeps the published binding.
      yield* publishNextValid(events, sessionID, baseline.seq)
      expect(yield* capture(db, sessionID)).toMatchObject({
        part: { publication: { state: "published", summaryID: s as unknown as string } },
        message: { summary: true, finish: "stop" },
        text: { text: "published summary content" },
      })
    }),
  )

  itProjected.effect("MessageRemoved and PartRemoved remain explicit deletion operations", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication({ secondText: true })

      yield* events.publish(SessionV1.Event.PartRemoved, { sessionID, messageID: s, partID: sText })
      expect((yield* capture(db, sessionID)).text).toBeUndefined()
      expect((yield* capture(db, sessionID)).message).toBeDefined()

      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID, messageID: s })
      const after = yield* capture(db, sessionID)
      expect(after.message).toBeUndefined()
      expect(after.text).toBeUndefined()
      const second = yield* db.select().from(PartTable).where(eq(PartTable.id, sText2)).get().pipe(Effect.orDie)
      expect(second).toBeUndefined()
      expect(after.summaryParts).toEqual([])
      // Explicit deletion never fabricates, downgrades or rewrites the durable
      // compaction record; pair validity is a reader concern.
      expect(after.part).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
      expect(after.seq).toBe(8)
    }),
  )

  itProjected.effect("a live stale replacement of published summary text rolls back before notification", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)
      const notified = new Array<string>()
      const stop = yield* events.listen((event) =>
        Effect.sync(() => {
          notified.push(event.id)
        }),
      )

      const exit = yield* events
        .publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: textOf(sessionID, { text: "stale replacement" }),
          time: 2,
        })
        .pipe(Effect.exit)

      expectRollback(exit, "published summary content conflict: content changed")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      expect(notified).toEqual([])
      yield* stop

      yield* publishNextValid(events, sessionID, baseline.seq)
      expect((yield* capture(db, sessionID)).text).toMatchObject({ text: "published summary content" })
      expect((yield* capture(db, sessionID)).eventIDs).toHaveLength((baseline.eventIDs?.length ?? 0) + 1)
    }),
  )

  itProjected.effect("a live stale new part insertion into a published summary rolls back before notification", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)
      const notified = new Array<string>()
      const stop = yield* events.listen((event) =>
        Effect.sync(() => {
          notified.push(event.id)
        }),
      )
      const extra = SessionV1.PartID.make("prt_t23_extra")

      const exit = yield* events
        .publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: textOf(sessionID, { id: extra, text: "post-publication appendix" }),
          time: 2,
        })
        .pipe(Effect.exit)

      expectRollback(exit, "new part after publication")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      expect(notified).toEqual([])
      expect(
        yield* db.select().from(PartTable).where(eq(PartTable.id, extra)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      yield* stop

      yield* publishNextValid(events, sessionID, baseline.seq)
      expect((yield* capture(db, sessionID)).summaryParts).toHaveLength(1)
    }),
  )

  itProjected.effect("a live stale owner identity change rolls back the published compaction owner", () =>
    Effect.gen(function* () {
      const { db, events, sessionID } = yield* seedPublication()
      const baseline = yield* capture(db, sessionID)
      const notified = new Array<string>()
      const stop = yield* events.listen((event) =>
        Effect.sync(() => {
          notified.push(event.id)
        }),
      )

      const exit = yield* events
        .publish(SessionV1.Event.MessageUpdated, { sessionID, info: ownerDemotion(sessionID) })
        .pipe(Effect.exit)

      expectRollback(exit, "published compaction owner conflict")
      expect(yield* capture(db, sessionID)).toEqual(baseline)
      expect(notified).toEqual([])
      yield* stop

      yield* publishNextValid(events, sessionID, baseline.seq)
      const owner = (yield* capture(db, sessionID)).owner as { role?: string } | undefined
      expect(owner).toMatchObject({ role: "user" })
      expect((yield* capture(db, sessionID)).part).toMatchObject({
        publication: { state: "published", summaryID: s as unknown as string },
      })
    }),
  )

  itProjected.effect(
    "stale summary content and owner updates are rejected at a fresh replay sequence",
    () =>
      Effect.gen(function* () {
        const { db, events, sessionID, textEvent } = yield* seedPublication()
        yield* events.claim(sessionID, "owner-t23-content")
        const baseline = yield* capture(db, sessionID)
        const versioned = EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1)
        const ownerVersioned = EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)

        // Exact committed-event replay of the summary content stays idempotent.
        yield* events.replay(
          {
            id: textEvent.id,
            type: versioned,
            seq: textEvent.durable!.seq,
            aggregateID: sessionID,
            data: textEvent.data,
          },
          { ownerID: "owner-t23-content", strictOwner: true },
        )
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // A conflicting content replacement at the next admissible sequence is
        // rejected by the projector, not by EventV2 deduplication or fencing.
        const staleContent = yield* events
          .replay(
            {
              id: EventV2.ID.create(),
              type: versioned,
              seq: (baseline.seq ?? -1) + 1,
              aggregateID: sessionID,
              data: { sessionID, part: textOf(sessionID, { text: "stale replacement" }), time: 3 },
            },
            { ownerID: "owner-t23-content" },
          )
          .pipe(Effect.exit)
        expectRollback(staleContent, "published summary content conflict: content changed")
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // A conflicting owner identity change at the next admissible sequence
        // is likewise rejected by the projector.
        const staleOwner = yield* events
          .replay(
            {
              id: EventV2.ID.create(),
              type: ownerVersioned,
              seq: (baseline.seq ?? -1) + 1,
              aggregateID: sessionID,
              data: { sessionID, info: ownerDemotion(sessionID) },
            },
            { ownerID: "owner-t23-content" },
          )
          .pipe(Effect.exit)
        expectRollback(staleOwner, "published compaction owner conflict")
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // A new part inserted into the published summary at the next admissible
        // sequence is rejected too.
        const staleInsert = yield* events
          .replay(
            {
              id: EventV2.ID.create(),
              type: versioned,
              seq: (baseline.seq ?? -1) + 1,
              aggregateID: sessionID,
              data: { sessionID, part: textOf(sessionID, { id: sText2, text: "appendix" }), time: 3 },
            },
            { ownerID: "owner-t23-content" },
          )
          .pipe(Effect.exit)
        expectRollback(staleInsert, "new part after publication")
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // The next legitimate event still commits at the contiguous sequence.
        yield* publishNextValid(events, sessionID, baseline.seq)
        expect(yield* capture(db, sessionID)).toMatchObject({
          part: { publication: { state: "published", summaryID: s as unknown as string } },
          owner: { role: "user" },
          message: { summary: true, finish: "stop" },
          text: { text: "published summary content" },
        })
      }),
  )

  // R4: the type-transition bypasses must roll back inside the same durable
  // event transaction, both live and when replayed through the supported
  // replay path at the next admissible sequence.
  itProjected.effect(
    "R4: duplicate-owner creation and deleted-owner retyping roll back live and at replay",
    () =>
      Effect.gen(function* () {
        const { db, events, sessionID } = yield* seedPublication()
        yield* events.claim(sessionID, "owner-t24")
        const baseline = yield* capture(db, sessionID)
        const versioned = EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1)
        const p2 = SessionV1.PartID.make("prt_t24_p2")
        const t = SessionV1.PartID.make("prt_t24_t")

        // 1. Duplicate compaction part under the SAME owner while P1 is still
        //    published: rejected live, projection/log/sequence roll back.
        const liveDuplicate = yield* events
          .publish(SessionV1.Event.PartUpdated, {
            sessionID,
            part: compaction(sessionID, { id: p2, publication: { state: "queued" } }),
            time: 2,
          })
          .pipe(Effect.exit)
        expectRollback(liveDuplicate, "owner already owns a compaction part")
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // 2. The same stale duplicate through supported replay at the next
        //    admissible sequence is rejected by the projector itself.
        const replayDuplicate = yield* events
          .replay(
            {
              id: EventV2.ID.create(),
              type: versioned,
              seq: (baseline.seq ?? -1) + 1,
              aggregateID: sessionID,
              data: { sessionID, part: compaction(sessionID, { id: p2, publication: { state: "queued" } }), time: 3 },
            },
            { ownerID: "owner-t24" },
          )
          .pipe(Effect.exit)
        expectRollback(replayDuplicate, "owner already owns a compaction part")
        expect(yield* capture(db, sessionID)).toEqual(baseline)

        // 3. Authorized PartRemoved of the published binding.
        yield* events.publish(SessionV1.Event.PartRemoved, { sessionID, messageID: u, partID: p })
        expect((yield* capture(db, sessionID)).part).toBeUndefined()

        // 4. An ordinary text part under the owner stays ordinary work.
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: textOf(sessionID, { id: t, messageID: u, text: "ordinary under owner" }),
          time: 2,
        })
        const afterText = yield* capture(db, sessionID)

        // 5. Live retype of the EXISTING ordinary row into the deleted
        //    publication: rejected, nothing durable changes.
        const liveRetype = yield* events
          .publish(SessionV1.Event.PartUpdated, {
            sessionID,
            part: compaction(sessionID, { id: t, publication: { state: "published", summaryID: s } }),
            time: 2,
          })
          .pipe(Effect.exit)
        expectRollback(liveRetype, "owner publication was previously removed")
        expect(yield* capture(db, sessionID)).toEqual(afterText)

        // 6. The same stale retype through replay at the next admissible
        //    sequence is likewise rejected by the projector.
        const replayRetype = yield* events
          .replay(
            {
              id: EventV2.ID.create(),
              type: versioned,
              seq: (afterText.seq ?? -1) + 1,
              aggregateID: sessionID,
              data: {
                sessionID,
                part: compaction(sessionID, { id: t, publication: { state: "published", summaryID: s } }),
                time: 3,
              },
            },
            { ownerID: "owner-t24" },
          )
          .pipe(Effect.exit)
        expectRollback(replayRetype, "owner publication was previously removed")
        expect(yield* capture(db, sessionID)).toEqual(afterText)

        // 7. The next legitimate event commits at the contiguous sequence and
        //    the reopened projection keeps the authorized deletion.
        yield* publishNextValid(events, sessionID, afterText.seq)
        const final = yield* capture(db, sessionID)
        expect(final.part).toBeUndefined()
        expect(final.owner).toMatchObject({ role: "user" })
        expect(final.message).toMatchObject({ summary: true, finish: "stop" })
        const tRow = yield* db.select().from(PartTable).where(eq(PartTable.id, t)).get().pipe(Effect.orDie)
        expect(tRow?.data).toMatchObject({ type: "text" })
      }),
  )
})

describe("EventV2 crash-window negative controls (T036)", () => {
  const model = { id: ModelV2.ID.make("t36_model"), providerID: ProviderV2.ID.make("t36_provider") }
  const u = SessionV1.MessageID.make("msg_t36_u")
  const p = SessionV1.PartID.make("prt_t36_p")

  const orphanOwner = (sessionID: Session.ID): SessionV1.User =>
    ({
      id: u,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "user",
      model: { providerID: model.providerID, modelID: model.id },
      origin: "compaction",
    }) as SessionV1.User

  const queuedPart = (sessionID: Session.ID): SessionV1.CompactionPart => ({
    id: p,
    sessionID,
    messageID: u,
    type: "compaction",
    auto: true,
    publication: { state: "queued" },
  })

  itProjected.effect(
    "T036 negative control 5: an interrupted synthetic U write persists as a tagged orphan, not an atomic U/P pair",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const sessionID = Session.ID.create()
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
            slug: "t36",
            directory: "/project",
            title: "t36",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        // 1. Commit MessageUpdated(U) with origin:"compaction".
        const uEvent = yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID,
          info: orphanOwner(sessionID),
        })
        expect(uEvent.durable?.seq).toBe(0)

        // 2. The process is interrupted BEFORE PartUpdated(P): the paired
        // part write never commits. EventV2's per-event transaction model is
        // unchanged — one event, one sequence step, nothing else durable.
        const eventRows = yield* db
          .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()
          .pipe(Effect.orDie)
        expect(eventRows).toHaveLength(1)
        expect(eventRows[0]?.seq).toBe(0)
        const seqRow = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(seqRow?.seq).toBe(0)

        // 3. Reopen the durable projection with fresh reads.
        const ownerRow = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, u))
          .get()
          .pipe(Effect.orDie)
        const partRows = yield* db
          .select({ id: PartTable.id, data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.message_id, u))
          .all()
          .pipe(Effect.orDie)

        // 4. U still exists as an orphan synthetic record.
        expect(ownerRow).toBeDefined()
        expect(ownerRow?.data).toMatchObject({ role: "user", origin: "compaction" })

        // 5. No compaction P exists.
        expect(partRows).toHaveLength(0)

        // 6. No runnable pending task is created: runnable new-format work
        // requires origin "compaction" AND a compaction part whose
        // publication.state is "queued". With no part rows the durable state
        // cannot satisfy that contract.
        const origin = (ownerRow?.data as { origin?: string } | undefined)?.origin
        const runnableNewFormat =
          origin === "compaction" &&
          partRows.some(
            (row) =>
              (row.data as { type?: string; publication?: { state?: string } }).type === "compaction" &&
              (row.data as { publication?: { state?: string } }).publication?.state === "queued",
          )
        expect(runnableNewFormat).toBe(false)

        // 7. U never becomes a genuine user prompt or current answer: the
        // durable record carries a synthetic origin, and the reader contract
        // classifies only origin-absent users as genuine (the last-resort
        // user-response rule also requires an absent origin).
        expect(origin === undefined).toBe(false)
        const assistants = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        // Only the orphan U row exists in the projection — no assistant row
        // that could be confused with a completed answer.
        expect(assistants.map((row) => row.id)).toEqual([u])

        // Test-local defective atomic-pair assumption, kept out of
        // production source: treating MessageUpdated(U)+PartUpdated(P) as one
        // atomic transaction predicts the interrupted write left EITHER no
        // durable U at all OR a complete durable U/P pair.
        const defectivePredictsNoU = ownerRow === undefined
        const defectivePredictsCompletePair = partRows.length > 0
        expect(defectivePredictsNoU).toBe(false)
        expect(defectivePredictsCompletePair).toBe(false)
        // The actual persisted state is strictly in between: orphan U only.
        expect(ownerRow?.data).toMatchObject({ role: "user", origin: "compaction" })
        expect(partRows).toHaveLength(0)

        // The next legitimate durable event continues the sequence from the
        // committed orphan U.
        const next = yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID,
          info: {
            ...orphanOwner(sessionID),
            id: SessionV1.MessageID.make("msg_t36_y"),
          } as SessionV1.User,
        })
        expect(next.durable?.seq).toBe(1)
      }),
  )
})
