import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      MessageV2.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})

describe("Session.fork compaction publication", () => {
  const provider = ProviderV2.ID.make("test")
  const modelID = ModelV2.ID.make("test")

  const pubUser = Effect.fn("test.forkUser")(function* (sessionID: SessionID, created: number, origin?: string) {
    const session = yield* SessionNs.Service
    return yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agent: "build",
      model: { providerID: provider, modelID },
      time: { created },
      ...(origin !== undefined ? { origin } : {}),
    } as SessionV1.User)
  })

  const pubAssistant = Effect.fn("test.forkAssistant")(function* (
    sessionID: SessionID,
    parentID: MessageID,
    created: number,
    input: { summary?: boolean } = {},
  ) {
    const session = yield* SessionNs.Service
    return yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID,
      mode: "default",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID,
      providerID: provider,
      parentID,
      time: { created },
      finish: "end_turn",
      ...(input.summary === true ? { summary: true } : {}),
    } as unknown as SessionV1.Info)
  })

  const pubText = Effect.fn("test.forkText")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
    const session = yield* SessionNs.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "text" as const,
      text: content,
    })
  })

  const compactionPart = Effect.fn("test.forkCompactionPart")(function* (
    sessionID: SessionID,
    messageID: MessageID,
    input: { publication?: SessionV1.CompactionPart["publication"]; tail?: MessageID } = {},
  ) {
    const session = yield* SessionNs.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "compaction" as const,
      auto: true,
      ...(input.tail !== undefined ? { tail_start_id: input.tail } : {}),
      ...(input.publication !== undefined ? { publication: input.publication } : {}),
    } as SessionV1.Part)
  })

  const projectionIDs = (msgs: SessionV1.WithParts[]) => msgs.map((msg) => msg.info.id)
  const projectionText = (msgs: SessionV1.WithParts[]) =>
    msgs
      .flatMap((msg) => msg.parts)
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")

  const compactionOf = (msg: SessionV1.WithParts | undefined) =>
    msg?.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

  const assistantInfoOf = (msg: SessionV1.WithParts | undefined) => msg?.info as SessionV1.Assistant | undefined

  const summaryChildren = (msgs: SessionV1.WithParts[], parentID: MessageID) =>
    msgs.filter(
      (msg) => msg.info.role === "assistant" && msg.info.summary === true && msg.info.parentID === parentID,
    )

  const expectNoForeignRefs = (forked: SessionV1.WithParts[], sourceIDs: Set<string>, sourceSession: SessionID) => {
    const serialized = JSON.stringify(forked)
    expect(serialized).not.toContain(sourceSession)
    for (const id of sourceIDs) expect(serialized).not.toContain(id)
  }

  const snapshotIDs = (msgs: SessionV1.WithParts[]) => new Set(msgs.map((msg) => msg.info.id))

  it.instance("clones a complete new-format published full summary with remapped references", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const head = yield* pubUser(source.id, 10)
      yield* pubText(source.id, head.id, "head question")
      const headReply = yield* pubAssistant(source.id, head.id, 20)
      yield* pubText(source.id, headReply.id, "head reply")

      const owner = yield* pubUser(source.id, 100, "compaction")
      const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "summary one")
      yield* session.updatePart({
        ...queued,
        publication: { state: "published", summaryID: summary.id },
      } as SessionV1.CompactionPart)
      const later = yield* pubUser(source.id, 200)
      yield* pubText(source.id, later.id, "later genuine question")

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("summary one")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Source remains byte-identical.
      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id})
      const clonedOwner = forked.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
      expect(clonedOwner).toBeDefined()
      const clonedPart = compactionOf(clonedOwner)
      expect(clonedPart?.publication?.state).toBe("published")
      const summaryID = clonedPart?.publication?.state === "published" ? clonedPart.publication.summaryID : undefined
      expect(summaryID).toBeDefined()
      const clonedSummary = forked.find((msg) => msg.info.id === summaryID)
      expect(clonedSummary).toBeDefined()
      expect(clonedSummary?.info.role === "assistant" && clonedSummary.info.summary).toBe(true)
      expect(assistantInfoOf(clonedSummary)?.parentID).toBe(clonedOwner?.info.id)
      expect(assistantInfoOf(clonedSummary)?.finish).toBe("end_turn")
      // Full summary: deliberate absence of a tail marker.
      expect(clonedPart?.tail_start_id).toBeUndefined()
      // Complete readable persisted text exists before the published part was
      // accepted (the projector rejects premature publication otherwise).
      expect(
        clonedSummary?.parts.some((part) => part.type === "text" && part.text === "summary one"),
      ).toBe(true)

      // Semantically equivalent model history through the real persisted reader.
      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("summary one")
      expect(projectionText(forkProjection)).toContain("later genuine question")
      expect(projectionText(forkProjection)).not.toContain("head question")
      expect(projectionText(forkProjection).match(/summary one/g)).toHaveLength(1)
      expect(projectionIDs(forkProjection)).toHaveLength(projectionIDs(sourceProjection).length)
      expect(forkProjection.map((msg) => msg.info.role)).toEqual(sourceProjection.map((msg) => msg.info.role))

      // No foreign source-session IDs remain.
      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)

      // No runnable work is scheduled after reopen.
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
    }),
    { timeout: 30000 },
  )

  it.instance("clones a complete new-format published tailed summary with remapped tail", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const head = yield* pubUser(source.id, 10)
      yield* pubText(source.id, head.id, "head question")
      const tail = yield* pubAssistant(source.id, head.id, 20)
      yield* pubText(source.id, tail.id, "retained reply")
      const owner = yield* pubUser(source.id, 100, "compaction")
      const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "summary one")
      yield* session.updatePart({
        ...queued,
        publication: { state: "published", summaryID: summary.id },
        tail_start_id: tail.id,
      } as SessionV1.CompactionPart)
      const later = yield* pubUser(source.id, 200)
      yield* pubText(source.id, later.id, "later genuine question")

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("retained reply")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id })
      const clonedOwner = forked.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
      const clonedPart = compactionOf(clonedOwner)
      expect(clonedPart?.publication?.state).toBe("published")
      const summaryID = clonedPart?.publication?.state === "published" ? clonedPart.publication.summaryID : undefined
      const clonedSummary = forked.find((msg) => msg.info.id === summaryID)
      expect(assistantInfoOf(clonedSummary)?.parentID).toBe(clonedOwner?.info.id)
      // Remapped tail references the cloned retained message, never the source.
      expect(clonedPart?.tail_start_id).toBeDefined()
      const clonedTail = forked.find((msg) => msg.info.id === clonedPart?.tail_start_id)
      expect(clonedTail).toBeDefined()
      expect(clonedTail?.parts.some((part) => part.type === "text" && part.text === "retained reply")).toBe(true)

      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("summary one")
      expect(projectionText(forkProjection)).toContain("retained reply")
      expect(projectionText(forkProjection)).toContain("later genuine question")
      expect(projectionText(forkProjection)).not.toContain("head question")
      expect(projectionText(forkProjection).match(/summary one/g)).toHaveLength(1)

      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
    }),
    { timeout: 30000 },
  )

  it.instance("preserves multiple successive published compactions and their order", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const head = yield* pubUser(source.id, 10)
      yield* pubText(source.id, head.id, "head question")

      const owner1 = yield* pubUser(source.id, 100, "compaction")
      const queued1 = yield* compactionPart(source.id, owner1.id, { publication: { state: "queued" } })
      const summary1 = yield* pubAssistant(source.id, owner1.id, 110, { summary: true })
      yield* pubText(source.id, summary1.id, "summary one")
      yield* session.updatePart({
        ...queued1,
        publication: { state: "published", summaryID: summary1.id },
      } as SessionV1.CompactionPart)

      const between = yield* pubUser(source.id, 150)
      yield* pubText(source.id, between.id, "between turn")

      const owner2 = yield* pubUser(source.id, 200, "compaction")
      const queued2 = yield* compactionPart(source.id, owner2.id, { publication: { state: "queued" } })
      const summary2 = yield* pubAssistant(source.id, owner2.id, 210, { summary: true })
      yield* pubText(source.id, summary2.id, "summary two")
      yield* session.updatePart({
        ...queued2,
        publication: { state: "published", summaryID: summary2.id },
        tail_start_id: between.id,
      } as SessionV1.CompactionPart)
      const later = yield* pubUser(source.id, 300)
      yield* pubText(source.id, later.id, "later genuine question")

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("summary two")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id })
      const publishedParts = forked
        .map(compactionOf)
        .filter((part): part is SessionV1.CompactionPart => part?.publication?.state === "published")
      expect(publishedParts).toHaveLength(2)
      for (const part of publishedParts) {
        const bound = forked.find((msg) => msg.info.id === (part.publication as { summaryID: MessageID }).summaryID)
        expect(bound).toBeDefined()
        expect(assistantInfoOf(bound)?.parentID).toBe(part.messageID)
      }
      // Chained order is preserved: the newest pair remains authoritative.
      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("summary two")
      expect(projectionText(forkProjection)).toContain("between turn")
      expect(projectionText(forkProjection)).toContain("later genuine question")
      expect(projectionText(forkProjection)).not.toContain("summary one")
      expect(projectionText(forkProjection)).not.toContain("head question")
      expect(projectionIDs(forkProjection).length).toBe(projectionIDs(sourceProjection).length)
      expect(forkProjection.map((msg) => msg.info.role)).toEqual(sourceProjection.map((msg) => msg.info.role))

      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
    }),
    { timeout: 30000 },
  )

  it.instance("preserves an upgraded legacy-shaped owner with explicit published metadata", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Absent U.origin, part upgraded through preparing to published.
      const owner = yield* pubUser(source.id, 100)
      const legacyPart = yield* compactionPart(source.id, owner.id)
      yield* session.updatePart({
        ...legacyPart,
        publication: { state: "preparing" },
      } as SessionV1.CompactionPart)
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "upgraded summary")
      yield* session.updatePart({
        ...legacyPart,
        publication: { state: "published", summaryID: summary.id },
      } as SessionV1.CompactionPart)

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("upgraded summary")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id })
      const clonedOwner = forked.find((msg) => compactionOf(msg) !== undefined)
      // Synthetic operation identity is preserved even without an explicit origin.
      expect(clonedOwner?.info.role).toBe("user")
      expect((clonedOwner?.info as SessionV1.User).origin).toBeUndefined()
      const clonedPart = compactionOf(clonedOwner)
      expect(clonedPart?.publication?.state).toBe("published")
      const summaryID = clonedPart?.publication?.state === "published" ? clonedPart.publication.summaryID : undefined
      const clonedSummary = forked.find((msg) => msg.info.id === summaryID)
      expect(assistantInfoOf(clonedSummary)?.parentID).toBe(clonedOwner?.info.id)

      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("upgraded summary")
      expect(projectionText(forkProjection).match(/upgraded summary/g)).toHaveLength(1)

      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
    }),
    { timeout: 30000 },
  )

  it.instance("preserves a strict historical legacy full pair", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const head = yield* pubUser(source.id, 10)
      yield* pubText(source.id, head.id, "legacy head question")
      const owner = yield* pubUser(source.id, 100)
      yield* compactionPart(source.id, owner.id)
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "legacy full summary")

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("legacy full summary")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id })
      const clonedOwner = forked.find((msg) => compactionOf(msg) !== undefined)
      const clonedPart = compactionOf(clonedOwner)
      // Strict legacy identity survives the clone: no origin, no publication.
      expect((clonedOwner?.info as SessionV1.User).origin).toBeUndefined()
      expect(clonedPart?.publication).toBeUndefined()
      expect(clonedPart?.tail_start_id).toBeUndefined()
      const clonedSummary = summaryChildren(forked, clonedOwner?.info.id as MessageID)[0]
      expect(clonedSummary).toBeDefined()
      expect(assistantInfoOf(clonedSummary)?.finish).toBe("end_turn")

      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("legacy full summary")
      expect(projectionText(forkProjection)).not.toContain("legacy head question")

      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
    }),
    { timeout: 30000 },
  )

  it.instance("fork cutoffs around a published pair keep complete clones and abandon partial ones", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const build = Effect.fn("test.forkCutoffSource")(function* () {
        const source = yield* session.create({})
        const head = yield* pubUser(source.id, 10)
        yield* pubText(source.id, head.id, "head question")
        const owner = yield* pubUser(source.id, 100, "compaction")
        const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
        const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
        yield* pubText(source.id, summary.id, "summary one")
        yield* session.updatePart({
          ...queued,
          publication: { state: "published", summaryID: summary.id },
        } as SessionV1.CompactionPart)
        const later = yield* pubUser(source.id, 200)
        yield* pubText(source.id, later.id, "later genuine question")
        return { source, head, owner, summary, later }
      })

      // 6: cutoff before U — only genuine history is cloned.
      const before = yield* build()
      const beforeFork = yield* Effect.acquireRelease(
        session.fork({ sessionID: before.source.id, messageID: before.owner.id }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const beforeMsgs = yield* session.messages({ sessionID: beforeFork.id })
      expect(beforeMsgs.map((msg) => msg.info.time.created)).toEqual([10])
      expect(beforeMsgs[0]?.parts.some((part) => part.type === "text" && part.text === "head question")).toBe(true)
      expect(beforeMsgs.some((msg) => compactionOf(msg) !== undefined)).toBe(false)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(beforeFork.id)).tasks).toEqual([])
      yield* session.remove(before.source.id)

      // 7: cutoff between U and S — partial candidate is abandoned.
      const between = yield* build()
      const betweenFork = yield* Effect.acquireRelease(
        session.fork({ sessionID: between.source.id, messageID: between.summary.id }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const betweenMsgs = yield* session.messages({ sessionID: betweenFork.id })
      const partialOwner = betweenMsgs.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
      // U's synthetic operation identity is retained.
      expect(partialOwner).toBeDefined()
      expect((partialOwner?.info as SessionV1.User).origin).toBe("compaction")
      const partialPart = compactionOf(partialOwner)
      // Persisted as explicitly non-authoritative; no dangling published binding.
      expect(partialPart?.publication?.state).toBe("abandoned")
      // No S is fabricated for the partial pair.
      expect(summaryChildren(betweenMsgs, partialOwner?.info.id as MessageID)).toHaveLength(0)
      // No pending ordinary compaction is created and the real head turn stays genuine.
      expect(MessageV2.pendingWork(yield* MessageV2.stream(betweenFork.id)).tasks).toEqual([])
      const betweenProjection = yield* MessageV2.filterCompactedEffect(betweenFork.id)
      expect(projectionText(betweenProjection)).toContain("head question")
      expect(projectionIDs(betweenProjection)).not.toContain(partialOwner?.info.id as string)
      expectNoForeignRefs(betweenMsgs, snapshotIDs(yield* session.messages({ sessionID: between.source.id })), between.source.id)
      yield* session.remove(between.source.id)

      // 8: cutoff after S — the complete pair survives, later turn excluded.
      const after = yield* build()
      const afterFork = yield* Effect.acquireRelease(
        session.fork({ sessionID: after.source.id, messageID: after.later.id }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterMsgs = yield* session.messages({ sessionID: afterFork.id })
      expect(afterMsgs.map((msg) => msg.info.time.created)).toEqual([10, 100, 110])
      const clonedOwner = afterMsgs.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
      const clonedPart = compactionOf(clonedOwner)
      expect(clonedPart?.publication?.state).toBe("published")
      const summaryID = clonedPart?.publication?.state === "published" ? clonedPart.publication.summaryID : undefined
      const clonedSummary = afterMsgs.find((msg) => msg.info.id === summaryID)
      expect((clonedSummary?.info as SessionV1.Assistant | undefined)?.parentID).toBe(clonedOwner?.info.id)
      expect(clonedSummary?.parts.some((part) => part.type === "text" && part.text === "summary one")).toBe(true)
      const afterProjection = yield* MessageV2.filterCompactedEffect(afterFork.id)
      expect(projectionText(afterProjection)).toContain("summary one")
      expect(projectionText(afterProjection)).not.toContain("later genuine question")
      expectNoForeignRefs(afterMsgs, snapshotIDs(yield* session.messages({ sessionID: after.source.id })), after.source.id)
      yield* session.remove(after.source.id)
    }),
    { timeout: 30000 },
  )

  it.instance("fork cutoff between a completed legacy owner and its summary does not introduce runnable work", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const owner = yield* pubUser(source.id, 100)
      yield* compactionPart(source.id, owner.id)
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "legacy full summary")

      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("legacy full summary")

      const fork = yield* Effect.acquireRelease(
        session.fork({ sessionID: source.id, messageID: summary.id }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      const forked = yield* session.messages({ sessionID: fork.id })
      const partialOwner = forked.find((msg) => msg.info.role === "user")
      expect(partialOwner).toBeDefined()
      const partialPart = compactionOf(partialOwner)
      // The partial clone is explicitly non-authoritative rather than an
      // accidentally runnable strict-legacy pending compaction.
      expect(partialPart?.publication?.state).toBe("abandoned")
      expect(summaryChildren(forked, partialOwner?.info.id as MessageID)).toHaveLength(0)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionIDs(forkProjection)).toHaveLength(0)
    }),
    { timeout: 30000 },
  )

  it.instance("keeps an earlier valid pair authoritative when a newer unpublished candidate is cloned", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const owner1 = yield* pubUser(source.id, 100, "compaction")
      const queued1 = yield* compactionPart(source.id, owner1.id, { publication: { state: "queued" } })
      const summary1 = yield* pubAssistant(source.id, owner1.id, 110, { summary: true })
      yield* pubText(source.id, summary1.id, "summary one")
      yield* session.updatePart({
        ...queued1,
        publication: { state: "published", summaryID: summary1.id },
      } as SessionV1.CompactionPart)

      const owner2 = yield* pubUser(source.id, 200, "compaction")
      yield* compactionPart(source.id, owner2.id, { publication: { state: "preparing" } })
      const summary2 = yield* pubAssistant(source.id, owner2.id, 210, { summary: true })
      yield* pubText(source.id, summary2.id, "unpublished summary two")

      const sourceBefore = yield* session.messages({ sessionID: source.id })
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionText(sourceProjection)).toContain("summary one")
      expect(projectionText(sourceProjection)).not.toContain("unpublished summary two")

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      const forked = yield* session.messages({ sessionID: fork.id })
      const clonedOwner2 = forked.find((msg) => msg.info.role === "user" && msg.info.time.created === 200)
      // The newer candidate keeps its explicit non-published identity.
      expect(compactionOf(clonedOwner2)?.publication?.state).toBe("preparing")

      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      expect(projectionText(forkProjection)).toContain("summary one")
      expect(projectionText(forkProjection)).not.toContain("unpublished summary two")
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])

      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
    }),
    { timeout: 30000 },
  )

  it.instance(
    "negative control 10: incremental fork cannot remap a forward publication.summaryID",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const source = yield* Effect.acquireRelease(session.create({}), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        const owner = yield* pubUser(source.id, 100, "compaction")
        const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
        const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
        yield* pubText(source.id, summary.id, "summary one")
        yield* session.updatePart({
          ...queued,
          publication: { state: "published", summaryID: summary.id },
        } as SessionV1.CompactionPart)

        // Mutation-free test-local defective strategy: allocate IDs
        // incrementally while cloning oldest-first, exactly like the pre-T032
        // fork. Production source is untouched.
        const defective = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const dest = yield* session.create({})
            const msgs = yield* session.messages({ sessionID: source.id })
            const idMap = new Map<string, MessageID>()
            for (const msg of msgs) {
              const newID = MessageID.ascending()
              idMap.set(msg.info.id, newID)
              // At the owner message the forward summaryID is not yet mapped.
              if (msg.info.id === owner.id) {
                expect(idMap.has(summary.id)).toBe(false)
              }
              const parentID =
                msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
              yield* session.updateMessage({
                ...msg.info,
                sessionID: dest.id,
                id: newID,
                ...(parentID && { parentID }),
              })
              for (const part of msg.parts) {
                const cloned = { ...part, id: PartID.ascending(), messageID: newID, sessionID: dest.id }
                if (cloned.type === "compaction" && cloned.tail_start_id) {
                  cloned.tail_start_id = idMap.get(cloned.tail_start_id)
                }
                if (cloned.type === "compaction" && cloned.publication?.state === "published") {
                  // The one-pass map cannot resolve the forward reference, so
                  // the defective clone carries the source summaryID and is
                  // persisted before any summary exists in the destination.
                  const premature = yield* session.updatePart(cloned as SessionV1.Part).pipe(Effect.exit)
                  expect(Exit.isSuccess(premature)).toBe(false)
                  continue
                }
                yield* session.updatePart(cloned as SessionV1.Part)
              }
            }
            return dest
          }),
          (info) => session.remove(info.id).pipe(Effect.ignore),
        )

        const defectiveMsgs = yield* session.messages({ sessionID: defective.id })
        const defectivePart = compactionOf(
          defectiveMsgs.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction"),
        )
        // The premature published part was rejected before event-log
        // insertion, so the destination never forms a published binding and
        // the owner's compaction part is lost entirely by the defective
        // one-pass strategy.
        expect(defectivePart).toBeUndefined()
        const defectiveProjection = yield* MessageV2.filterCompactedEffect(defective.id)
        expect(projectionText(defectiveProjection)).not.toContain("summary one")

        // The actual production fork, run separately on the same source,
        // succeeds with fully remapped references.
        const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )
        const forked = yield* session.messages({ sessionID: fork.id })
        const clonedOwner = forked.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
        const clonedPart = compactionOf(clonedOwner)
        expect(clonedPart?.publication?.state).toBe("published")
        const summaryID = clonedPart?.publication?.state === "published" ? clonedPart.publication.summaryID : undefined
        expect(summaryID).toBeDefined()
        expect(summaryID).not.toBe(summary.id)
        const clonedSummary = forked.find((msg) => msg.info.id === summaryID)
        expect((clonedSummary?.info as SessionV1.Assistant | undefined)?.parentID).toBe(clonedOwner?.info.id)
        expect(clonedSummary?.parts.some((part) => part.type === "text" && part.text === "summary one")).toBe(true)
        expect(JSON.stringify(forked)).not.toContain(source.id)
        expect(JSON.stringify(forked)).not.toContain(summary.id)
      }),
    { timeout: 30000 },
  )

  it.instance(
    "deletion gate D1: fork after a published summary lost its last readable part stays non-authoritative",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const source = yield* Effect.acquireRelease(session.create({}), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        // 1. Genuine historical head X/B.
        const head = yield* pubUser(source.id, 10)
        yield* pubText(source.id, head.id, "head question")
        yield* pubAssistant(source.id, head.id, 20)

        // 2. Older complete published U1/P1/S1 with readable text.
        const owner1 = yield* pubUser(source.id, 100, "compaction")
        const queued1 = yield* compactionPart(source.id, owner1.id, { publication: { state: "queued" } })
        const summary1 = yield* pubAssistant(source.id, owner1.id, 110, { summary: true })
        yield* pubText(source.id, summary1.id, "summary one")
        yield* session.updatePart({
          ...queued1,
          publication: { state: "published", summaryID: summary1.id },
        } as SessionV1.CompactionPart)

        // 3. Newer complete published U2/P2/S2 with readable text.
        const owner2 = yield* pubUser(source.id, 200, "compaction")
        const queued2 = yield* compactionPart(source.id, owner2.id, { publication: { state: "queued" } })
        const summary2 = yield* pubAssistant(source.id, owner2.id, 210, { summary: true })
        const summary2Text = yield* pubText(source.id, summary2.id, "summary two")
        yield* session.updatePart({
          ...queued2,
          publication: { state: "published", summaryID: summary2.id },
        } as SessionV1.CompactionPart)

        // 4. Authorized PartRemoved deletes S2's LAST readable text part.
        yield* session.removePart({ sessionID: source.id, messageID: summary2.id, partID: summary2Text.id })

        // 5/6. P2 remains durably marked published, but the reader rejects it
        // as non-authoritative and the source projection falls back to U1/S1.
        const sourceBefore = yield* session.messages({ sessionID: source.id })
        const sourceOwner2 = sourceBefore.find((msg) => msg.info.id === owner2.id)
        expect(compactionOf(sourceOwner2)?.publication?.state).toBe("published")
        const orphanedSummary2 = summaryChildren(sourceBefore, owner2.id)
        expect(orphanedSummary2).toHaveLength(1)
        expect(orphanedSummary2[0]?.parts).toHaveLength(0)
        const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
        expect(projectionText(sourceProjection)).toContain("summary one")
        expect(projectionText(sourceProjection)).not.toContain("summary two")
        expect(projectionText(sourceProjection)).not.toContain("head question")

        // Real Session.fork on that source, including U2 and S2.
        const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        // Source session remains byte-identical.
        expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

        const forked = yield* session.messages({ sessionID: fork.id })

        // Cloned U2/P2 retains non-authoritative synthetic identity; the
        // invalid published binding is not re-published and no S2 content is
        // fabricated.
        const clonedOwner2 = forked.find((msg) => msg.info.role === "user" && msg.info.time.created === 200)
        expect((clonedOwner2?.info as SessionV1.User).origin).toBe("compaction")
        const clonedPart2 = compactionOf(clonedOwner2)
        expect(clonedPart2?.publication?.state).toBe("abandoned")
        const clonedSummary2 = forked.find((msg) => msg.info.role === "assistant" && msg.info.time.created === 210)
        expect(clonedSummary2).toBeDefined()
        expect(assistantInfoOf(clonedSummary2)?.parentID).toBe(clonedOwner2?.info.id)
        expect(clonedSummary2?.parts).toHaveLength(0)

        // Older complete U1/P1/S1 remains published and authoritative.
        const clonedOwner1 = forked.find((msg) => msg.info.role === "user" && msg.info.time.created === 100)
        const clonedPart1 = compactionOf(clonedOwner1)
        expect(clonedPart1?.publication?.state).toBe("published")
        const summaryID1 = clonedPart1?.publication?.state === "published" ? clonedPart1.publication.summaryID : undefined
        const clonedSummary1 = forked.find((msg) => msg.info.id === summaryID1)
        expect(clonedSummary1?.parts.some((part) => part.type === "text" && part.text === "summary one")).toBe(true)

        // Destination modelHistory falls back to the cloned U1/S1.
        const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
        expect(projectionText(forkProjection)).toContain("summary one")
        expect(projectionText(forkProjection)).not.toContain("summary two")
        expect(projectionText(forkProjection)).not.toContain("head question")
        expect(projectionIDs(forkProjection)).not.toContain(clonedSummary2?.info.id as string)

        // No orphan/new compaction task is introduced; no dangling refs.
        expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
        expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
        for (const msg of forked) {
          if (msg.info.role !== "assistant") continue
          const parentID = assistantInfoOf(msg)?.parentID
          expect(forked.some((candidate) => candidate.info.id === parentID)).toBe(true)
        }
      }),
    { timeout: 30000 },
  )

  it.instance(
    "deletion gate D1: a single published pair losing its final readable content forks as abandoned",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const source = yield* Effect.acquireRelease(session.create({}), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        const head = yield* pubUser(source.id, 10)
        yield* pubText(source.id, head.id, "head question")
        const headReply = yield* pubAssistant(source.id, head.id, 20)
        yield* pubText(source.id, headReply.id, "head reply")

        const owner = yield* pubUser(source.id, 100, "compaction")
        const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
        const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
        const summaryTextPart = yield* pubText(source.id, summary.id, "summary one")
        yield* session.updatePart({
          ...queued,
          publication: { state: "published", summaryID: summary.id },
        } as SessionV1.CompactionPart)

        // Authorized deletion removes the pair's only readable content.
        yield* session.removePart({ sessionID: source.id, messageID: summary.id, partID: summaryTextPart.id })

        const sourceBefore = yield* session.messages({ sessionID: source.id })
        const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
        expect(projectionText(sourceProjection)).toContain("head question")
        expect(projectionText(sourceProjection)).not.toContain("summary one")

        const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

        const forked = yield* session.messages({ sessionID: fork.id })
        const clonedOwner = forked.find((msg) => msg.info.role === "user" && msg.info.origin === "compaction")
        expect((clonedOwner?.info as SessionV1.User).origin).toBe("compaction")
        const clonedPart = compactionOf(clonedOwner)
        expect(clonedPart?.publication?.state).toBe("abandoned")
        const clonedSummary = forked.find((msg) => msg.info.role === "assistant" && msg.info.summary === true)
        expect(clonedSummary).toBeDefined()
        expect(clonedSummary?.parts).toHaveLength(0)

        // The genuine head survives; no publication and no runnable task.
        const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
        expect(projectionText(forkProjection)).toContain("head question")
        expect(projectionText(forkProjection)).toContain("head reply")
        expect(projectionText(forkProjection)).not.toContain("summary one")
        expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
        expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
        for (const msg of forked) {
          if (msg.info.role !== "assistant") continue
          expect(forked.some((candidate) => candidate.info.id === assistantInfoOf(msg)?.parentID)).toBe(true)
        }
      }),
    { timeout: 30000 },
  )

  it.instance("deletion gate D2: fork after removing a published pair's owner leaves no source parent reference", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Genuine remaining history.
      const head = yield* pubUser(source.id, 10)
      yield* pubText(source.id, head.id, "head question")
      const headReply = yield* pubAssistant(source.id, head.id, 20)
      yield* pubText(source.id, headReply.id, "head reply")

      // 1. Publish a valid U/P/S.
      const owner = yield* pubUser(source.id, 100, "compaction")
      const queued = yield* compactionPart(source.id, owner.id, { publication: { state: "queued" } })
      const summary = yield* pubAssistant(source.id, owner.id, 110, { summary: true })
      yield* pubText(source.id, summary.id, "summary one")
      yield* session.updatePart({
        ...queued,
        publication: { state: "published", summaryID: summary.id },
      } as SessionV1.CompactionPart)

      // 2. Explicitly remove the owner; S survives as an orphan summary still
      // carrying parentID = the deleted source U.id.
      yield* session.removeMessage({ sessionID: source.id, messageID: owner.id })

      // 3. The reader hides the orphan S from source modelHistory.
      const sourceBefore = yield* session.messages({ sessionID: source.id })
      expect(sourceBefore.some((msg) => msg.info.id === summary.id)).toBe(true)
      expect(sourceBefore.some((msg) => msg.info.id === owner.id)).toBe(false)
      const sourceProjection = yield* MessageV2.filterCompactedEffect(source.id)
      expect(projectionIDs(sourceProjection)).not.toContain(summary.id)
      expect(projectionText(sourceProjection)).toContain("head question")
      expect(MessageV2.pendingWork(sourceBefore).tasks).toEqual([])

      // 4. REAL Session.fork on the source.
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Source remains unchanged.
      expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

      // 5. Inspect all destination assistant parent IDs and structured refs:
      // no cloned record carries the removed source U.id, and every cloned
      // assistant parent exists in the destination.
      const forked = yield* session.messages({ sessionID: fork.id })
      const serialized = JSON.stringify(forked)
      expect(serialized).not.toContain(owner.id)
      for (const msg of forked) {
        if (msg.info.role !== "assistant") continue
        const parentID = assistantInfoOf(msg)?.parentID
        expect(parentID).toBeDefined()
        expect(forked.some((candidate) => candidate.info.id === parentID)).toBe(true)
      }

      // 6. The orphan summary cannot become currentResponse (same
      // modelVisible predicate lastAssistant uses), a valid publication, or
      // runnable work.
      const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
      const forkVisible = new Set(projectionIDs(forkProjection))
      const clonedSummary = forked.find(
        (msg) => msg.info.role === "assistant" && msg.info.summary === true && msg.info.time.created === 110,
      )
      if (clonedSummary) expect(forkVisible.has(clonedSummary.info.id)).toBe(false)
      expect(forked.map(compactionOf).filter((part) => part?.publication?.state === "published")).toHaveLength(0)
      expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])

      // The intended genuine remaining history is preserved.
      expect(projectionText(forkProjection)).toContain("head question")
      expect(projectionText(forkProjection)).toContain("head reply")

      // No foreign source-session IDs remain.
      expectNoForeignRefs(forked, snapshotIDs(sourceBefore), source.id)
    }),
    { timeout: 30000 },
  )

  it.instance(
    "deletion gate D2: ordinary orphan assistant content is preserved on fork without destructive truncation",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const source = yield* Effect.acquireRelease(session.create({}), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        // Genuine turn whose user is later explicitly removed, leaving an
        // ordinary (non-summary) orphan assistant.
        const user = yield* pubUser(source.id, 10)
        yield* pubText(source.id, user.id, "head question")
        const reply = yield* pubAssistant(source.id, user.id, 20)
        yield* pubText(source.id, reply.id, "head reply")

        yield* session.removeMessage({ sessionID: source.id, messageID: user.id })
        const sourceBefore = yield* session.messages({ sessionID: source.id })
        expect(sourceBefore.some((msg) => msg.info.id === reply.id)).toBe(true)

        const fork = yield* Effect.acquireRelease(session.fork({ sessionID: source.id }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )

        expect(JSON.stringify(yield* session.messages({ sessionID: source.id }))).toBe(JSON.stringify(sourceBefore))

        // Unlike an orphan summary, an ordinary orphan assistant is genuine
        // conversation content and is not destructively truncated by fork.
        const forked = yield* session.messages({ sessionID: fork.id })
        const clonedReply = forked.find((msg) => msg.info.role === "assistant")
        expect(clonedReply).toBeDefined()
        expect(clonedReply?.parts.some((part) => part.type === "text" && part.text === "head reply")).toBe(true)
        const forkProjection = yield* MessageV2.filterCompactedEffect(fork.id)
        expect(projectionText(forkProjection)).toContain("head reply")
        expect(MessageV2.pendingWork(yield* MessageV2.stream(fork.id)).tasks).toEqual([])
      }),
    { timeout: 30000 },
  )
})
