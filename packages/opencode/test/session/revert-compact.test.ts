import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit } from "effect"
import { Session } from "@/session/session"

import { SessionRevert } from "../../src/session/revert"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionRevert.node,
      Snapshot.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      MessageV2.node,
    ]),
  ),
)

const user = Effect.fn("test.user")(function* (sessionID: SessionID, agent = "default") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent,
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const userAt = Effect.fn("test.userAt")(function* (sessionID: SessionID, id: string, created: number) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.make(id),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created },
  })
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
  })
})

const tool = Effect.fn("test.tool")(function* (sessionID: SessionID, messageID: MessageID) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool" as const,
    tool: "bash",
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: {},
      output: "done",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  })
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

describe("revert + compact workflow", () => {
  it.live(
    "should properly handle compact command after revert",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg1 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg1.id,
            sessionID,
            type: "text",
            text: "Hello, please help me",
          })

          const assistantMsg1: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: userMsg1.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg1)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg1.id,
            sessionID,
            type: "text",
            text: "Sure, I'll help you!",
          })

          const userMsg2 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg2.id,
            sessionID,
            type: "text",
            text: "What's the capital of France?",
          })

          const assistantMsg2: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: userMsg2.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg2)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg2.id,
            sessionID,
            type: "text",
            text: "The capital of France is Paris.",
          })

          let messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)
          const messageIds = messages.map((m) => m.info.id)
          expect(messageIds).toContain(userMsg1.id)
          expect(messageIds).toContain(userMsg2.id)
          expect(messageIds).toContain(assistantMsg1.id)
          expect(messageIds).toContain(assistantMsg2.id)

          yield* revert.revert({
            sessionID,
            messageID: userMsg2.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()
          expect(sessionInfo.revert?.messageID).toBeDefined()

          messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)

          yield* revert.cleanup(sessionInfo)

          messages = yield* session.messages({ sessionID })
          const remainingIds = messages.map((m) => m.info.id)
          expect(messages.length).toBeLessThan(4)
          expect(remainingIds).not.toContain(userMsg2.id)
          expect(remainingIds).not.toContain(assistantMsg2.id)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "should properly clean up revert state before creating compaction message",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg.id,
            sessionID,
            type: "text",
            text: "Hello",
          })

          const assistantMsg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: userMsg.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg.id,
            sessionID,
            type: "text",
            text: "Hi there!",
          })

          yield* revert.revert({
            sessionID,
            messageID: userMsg.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()

          yield* revert.cleanup(sessionInfo)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          const messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(0)

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup with partID removes parts from the revert point onward",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          const p1 = yield* text(sid, u1.id, "first part")
          const p2 = yield* tool(sid, u1.id)
          yield* text(sid, u1.id, "third part")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, partID: p2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
          expect(msgs[0].parts.length).toBe(1)
          expect(msgs[0].parts[0].id).toBe(p1.id)

          const cleared = yield* session.get(sid)
          expect(cleared.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup removes messages after revert point but keeps earlier ones",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "hi back")

          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second question")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "second answer")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          const ids = msgs.map((m) => m.info.id)
          expect(ids).toContain(u1.id)
          expect(ids).toContain(a1.id)
          expect(ids).not.toContain(u2.id)
          expect(ids).not.toContain(a2.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "reverts chronological suffixes on both sides of mixed message ID ordering",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]

          const run = Effect.fn("test.mixedIDRevert")(function* (target: number) {
            const info = yield* session.create({})
            for (const [index, id] of ids.entries()) {
              const message = yield* userAt(info.id, id, index + 1)
              yield* text(info.id, message.id, id)
            }

            const reverted = yield* revert.revert({
              sessionID: info.id,
              messageID: MessageID.make(ids[target]!),
            })
            yield* revert.cleanup(reverted)
            const remaining = yield* session.messages({ sessionID: info.id })
            yield* session.remove(info.id)
            return remaining.map((msg) => msg.info.time.created)
          })

          expect(yield* run(1)).toEqual([1])
          expect(yield* run(2)).toEqual([1, 2])
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup is a no-op when session has no revert state",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")

          const state = yield* session.get(sid)
          expect(state.revert).toBeUndefined()
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live(
    "restore messages in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          yield* write(path.join(dir, "b.txt"), "b0")
          yield* write(path.join(dir, "c.txt"), "c0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turn")(function* (file: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `${file}:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, file), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a.txt", "a1")
          const second = yield* turn("b.txt", "b2")
          const third = yield* turn("c.txt", "c3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c3")
        }),
      { git: true },
    ),
  )

  it.live(
    "restore same file in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turnSame")(function* (next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, "a.txt"), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a1")
          const second = yield* turn("a2")
          const third = yield* turn("a3")
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a2")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")
        }),
      { git: true },
    ),
  )
})

describe("published compaction intentional deletion and revert", () => {
  const pubUser = Effect.fn("test.pubUser")(function* (sessionID: SessionID, created: number, origin?: string) {
    const session = yield* Session.Service
    return yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID,
      agent: "default",
      model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
      time: { created },
      ...(origin !== undefined ? { origin } : {}),
    } as SessionV1.User)
  })

  const pubAssistant = Effect.fn("test.pubAssistant")(function* (
    sessionID: SessionID,
    parentID: MessageID,
    created: number,
    input: { summary?: boolean } = {},
  ) {
    const session = yield* Session.Service
    return yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID,
      mode: "default",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("gpt-4"),
      providerID: ProviderV2.ID.make("openai"),
      parentID,
      time: { created },
      finish: "end_turn",
      ...(input.summary === true ? { summary: true } : {}),
    } as unknown as SessionV1.Info)
  })

  const pubText = Effect.fn("test.pubText")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
    const session = yield* Session.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "text" as const,
      text: content,
    })
  })

  // Mirrors the real writer: U with synthetic identity, queued part, completed
  // readable S, then the single publication transition.
  const publishedPair = Effect.fn("test.publishedPair")(function* (
    sessionID: SessionID,
    created: { owner: number; summary: number },
    input: { text: string; origin?: string; tail?: MessageID },
  ) {
    const session = yield* Session.Service
    const owner = yield* pubUser(sessionID, created.owner, input.origin ?? "compaction")
    const queued = yield* session.updatePart({
      id: PartID.ascending(),
      messageID: owner.id,
      sessionID,
      type: "compaction" as const,
      auto: true,
      publication: { state: "queued" },
    } as SessionV1.Part)
    const summary = yield* pubAssistant(sessionID, owner.id, created.summary, { summary: true })
    const summaryText = yield* pubText(sessionID, summary.id, input.text)
    yield* session.updatePart({
      ...queued,
      publication: { state: "published", summaryID: summary.id },
      ...(input.tail !== undefined ? { tail_start_id: input.tail } : {}),
    } as SessionV1.CompactionPart)
    return { owner, summary, summaryText, partID: queued.id }
  })

  const legacyFullPair = Effect.fn("test.legacyFullPair")(function* (
    sessionID: SessionID,
    created: { owner: number; summary: number },
    summaryText: string,
  ) {
    const session = yield* Session.Service
    const owner = yield* pubUser(sessionID, created.owner)
    const part = yield* session.updatePart({
      id: PartID.ascending(),
      messageID: owner.id,
      sessionID,
      type: "compaction" as const,
      auto: true,
    } as SessionV1.Part)
    const summary = yield* pubAssistant(sessionID, owner.id, created.summary, { summary: true })
    const text = yield* pubText(sessionID, summary.id, summaryText)
    return { owner, summary, summaryText: text, partID: part.id }
  })

  const projectionIDs = (msgs: SessionV1.WithParts[]) => msgs.map((msg) => msg.info.id)
  const projectionText = (msgs: SessionV1.WithParts[]) =>
    msgs
      .flatMap((msg) => msg.parts)
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")

  it.live(
    "deleting a newer published summary falls back to the older applicable pair and preserves raw records",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const head = yield* pubUser(sid, 50)
          yield* pubText(sid, head.id, "head question")
          const headReply = yield* pubAssistant(sid, head.id, 60)
          yield* pubText(sid, headReply.id, "head reply")

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          const later = yield* pubUser(sid, 300)
          yield* pubText(sid, later.id, "later genuine question")

          const before = yield* session.messages({ sessionID: sid })
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
            later.id,
          ])

          // Authorized MessageRemoved of the published summary S.
          yield* session.removeMessage({ sessionID: sid, messageID: second.summary.id })

          const after = yield* session.messages({ sessionID: sid })
          const remainingIDs = after.map((msg) => msg.info.id)
          expect(remainingIDs).not.toContain(second.summary.id)
          expect(remainingIDs).toContain(second.owner.id)
          expect(remainingIDs).toContain(first.summary.id)
          expect(JSON.stringify(after)).toBe(JSON.stringify(before.filter((msg) => msg.info.id !== second.summary.id)))

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toEqual([first.owner.id, first.summary.id, later.id])
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")
          expect(projectionText(filtered)).not.toContain("head question")

          // The dangling published part is not runnable work.
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "a deleted published summary cannot be resurrected through ordinary assistant state",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const head = yield* pubUser(sid, 50)
          yield* pubText(sid, head.id, "head question")
          const headReply = yield* pubAssistant(sid, head.id, 60)
          yield* pubText(sid, headReply.id, "head reply")

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          const later = yield* pubUser(sid, 300)
          yield* pubText(sid, later.id, "later genuine question")

          // Authorized MessageRemoved of the newer published summary.
          yield* session.removeMessage({ sessionID: sid, messageID: second.summary.id })
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            first.owner.id,
            first.summary.id,
            later.id,
          ])

          // R1.1: a stale writer recreates the deleted S id as a NON-summary
          // assistant with the correct parent.
          const plain = yield* session
            .updateMessage({
              id: second.summary.id,
              role: "assistant" as const,
              sessionID: sid,
              mode: "default",
              agent: "default",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("gpt-4"),
              providerID: ProviderV2.ID.make("openai"),
              parentID: second.owner.id,
              time: { created: 211 },
            } as unknown as SessionV1.Info)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(plain)).toBe(false)

          // R1.2: readable text under the still-missing summary.
          const text = yield* session
            .updatePart({
              id: PartID.ascending(),
              messageID: second.summary.id,
              sessionID: sid,
              type: "text" as const,
              text: "resurrected summary content",
            })
            .pipe(Effect.exit)
          expect(Exit.isSuccess(text)).toBe(false)

          // R1.3: flip the still-missing row into a successful summary.
          const flip = yield* session
            .updateMessage({
              id: second.summary.id,
              role: "assistant" as const,
              sessionID: sid,
              mode: "default",
              agent: "default",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("gpt-4"),
              providerID: ProviderV2.ID.make("openai"),
              parentID: second.owner.id,
              time: { created: 212, completed: 212 },
              summary: true,
              finish: "end_turn",
            } as unknown as SessionV1.Info)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(flip)).toBe(false)

          // The deleted summary never reappears and the older publication is
          // still the authoritative fallback.
          const after = yield* session.messages({ sessionID: sid })
          expect(projectionIDs(after)).not.toContain(second.summary.id)
          expect(
            after.some((msg) => JSON.stringify(msg.parts).includes("resurrected summary content")),
          ).toBe(false)
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            first.owner.id,
            first.summary.id,
            later.id,
          ])
          expect(projectionText(yield* MessageV2.filterCompactedEffect(sid))).toContain("summary one")
          expect(projectionText(yield* MessageV2.filterCompactedEffect(sid))).not.toContain("summary two")
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "removing required readable summary content falls back without resurrecting it through a stale part update",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const tail = yield* pubUser(sid, 150)
          yield* pubText(sid, tail.id, "retained turn")
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two", tail: tail.id })

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
            tail.id,
          ])

          // B/G: authorized PartRemoved of the final required readable S text.
          yield* session.removePart({
            sessionID: sid,
            messageID: second.summary.id,
            partID: second.summaryText.id,
          })

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toEqual([first.owner.id, first.summary.id, tail.id])
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")
          expect(projectionText(filtered)).toContain("retained turn")
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          // Deleted summary content cannot be resurrected through an ordinary
          // stale part update while the published binding still exists.
          const resurrect = yield* session
            .updatePart({
              id: second.summaryText.id,
              messageID: second.summary.id,
              sessionID: sid,
              type: "text",
              text: "summary two",
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(resurrect)).toBe(false)

          const after = yield* session.messages({ sessionID: sid })
          expect(
            after
              .find((msg) => msg.info.id === second.summary.id)
              ?.parts.some((part) => part.type === "text" && part.text === "summary two"),
          ).toBeFalsy()
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            first.owner.id,
            first.summary.id,
            tail.id,
          ])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "removing the published owner or its compaction part leaves no synthetic orphan as current user",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service

          // C: MessageRemoved of the published owner.
          const c = yield* Effect.acquireRelease(
            session.create({}).pipe(
              Effect.flatMap((created) =>
                Effect.gen(function* () {
                  const sid = created.id
                  const prior = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
                  const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
                  yield* session.removeMessage({ sessionID: sid, messageID: second.owner.id })
                  return { sid, prior, second }
                }),
              ),
            ),
            ({ sid }) => session.remove(sid).pipe(Effect.ignore),
          )
          const filteredC = yield* MessageV2.filterCompactedEffect(c.sid)
          expect(projectionIDs(filteredC)).toEqual([c.prior.owner.id, c.prior.summary.id])
          expect(projectionText(filteredC)).toContain("summary one")
          // The surviving orphan summary cannot become the current assistant.
          expect(projectionIDs(filteredC)).not.toContain(c.second.summary.id)
          expect(MessageV2.pendingWork(yield* MessageV2.stream(c.sid)).tasks).toEqual([])

          // D: PartRemoved of the published compaction part.
          const d = yield* Effect.acquireRelease(
            session.create({}).pipe(
              Effect.flatMap((created) =>
                Effect.gen(function* () {
                  const sid = created.id
                  const prior = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
                  const pair = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
                  yield* session.removePart({ sessionID: sid, messageID: pair.owner.id, partID: pair.partID })
                  return { sid, prior, pair }
                }),
              ),
            ),
            ({ sid }) => session.remove(sid).pipe(Effect.ignore),
          )
          const filteredD = yield* MessageV2.filterCompactedEffect(d.sid)
          // The orphan synthetic U cannot become the current user.
          expect(projectionIDs(filteredD)).toEqual([d.prior.owner.id, d.prior.summary.id])
          expect(projectionIDs(filteredD)).not.toContain(d.pair.owner.id)
          expect(projectionIDs(filteredD)).not.toContain(d.pair.summary.id)
          expect(MessageV2.pendingWork(yield* MessageV2.stream(d.sid)).tasks).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live(
    "stale owner and part id reuse cannot revive a deleted publication",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service

          // R2: authorized MessageRemoved of the published owner cascades the
          // compaction part away with no PartRemoved event.
          const r2 = yield* Effect.acquireRelease(
            session.create({}).pipe(
              Effect.flatMap((created) =>
                Effect.gen(function* () {
                  const sid = created.id
                  const pair = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
                  yield* session.removeMessage({ sessionID: sid, messageID: pair.owner.id })
                  return { sid, pair }
                }),
              ),
            ),
            ({ sid }) => session.remove(sid).pipe(Effect.ignore),
          )
          const recreateOwner = yield* session.updateMessage({ ...r2.pair.owner, sessionID: r2.sid }).pipe(Effect.exit)
          expect(Exit.isSuccess(recreateOwner)).toBe(false)
          const recreateQueued = yield* session
            .updatePart({
              id: r2.pair.partID,
              messageID: r2.pair.owner.id,
              sessionID: r2.sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "queued" },
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(recreateQueued)).toBe(false)
          const recreatePublished = yield* session
            .updatePart({
              id: r2.pair.partID,
              messageID: r2.pair.owner.id,
              sessionID: r2.sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: r2.pair.summary.id },
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(recreatePublished)).toBe(false)
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(r2.sid))).toEqual([])
          expect(MessageV2.pendingWork(yield* MessageV2.stream(r2.sid)).tasks).toEqual([])

          // R3: authorized PartRemoved of the published compaction part. A NEW
          // part id under the SAME owner must not revive it, while a genuine
          // fresh-owner publication keeps working.
          const r3 = yield* Effect.acquireRelease(
            session.create({}).pipe(
              Effect.flatMap((created) =>
                Effect.gen(function* () {
                  const sid = created.id
                  const pair = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
                  yield* session.removePart({ sessionID: sid, messageID: pair.owner.id, partID: pair.partID })
                  return { sid, pair }
                }),
              ),
            ),
            ({ sid }) => session.remove(sid).pipe(Effect.ignore),
          )
          const newPublished = yield* session
            .updatePart({
              id: PartID.ascending(),
              messageID: r3.pair.owner.id,
              sessionID: r3.sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: r3.pair.summary.id },
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(newPublished)).toBe(false)
          const newQueued = yield* session
            .updatePart({
              id: PartID.ascending(),
              messageID: r3.pair.owner.id,
              sessionID: r3.sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "queued" },
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isSuccess(newQueued)).toBe(false)
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(r3.sid))).toEqual([])
          expect(MessageV2.pendingWork(yield* MessageV2.stream(r3.sid)).tasks).toEqual([])

          // Positive control: a genuinely new owner publishes normally.
          const fresh = yield* Effect.acquireRelease(
            session.create({}).pipe(
              Effect.flatMap((created) =>
                Effect.gen(function* () {
                  const sid = created.id
                  const prior = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
                  const next = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
                  return { sid, prior, next }
                }),
              ),
            ),
            ({ sid }) => session.remove(sid).pipe(Effect.ignore),
          )
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(fresh.sid))).toEqual([
            fresh.next.owner.id,
            fresh.next.summary.id,
          ])
        }),
      { git: true },
    ),
  )

  it.live(
    "deleting the only published pair preserves genuine un-compacted history",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const head = yield* pubUser(sid, 50)
          yield* pubText(sid, head.id, "genuine head question")
          const headReply = yield* pubAssistant(sid, head.id, 60)
          yield* pubText(sid, headReply.id, "genuine head reply")
          const pair = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const later = yield* pubUser(sid, 200)
          yield* pubText(sid, later.id, "genuine later question")

          yield* session.removeMessage({ sessionID: sid, messageID: pair.summary.id })

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toContain(head.id)
          expect(projectionIDs(filtered)).toContain(headReply.id)
          expect(projectionIDs(filtered)).toContain(later.id)
          expect(projectionIDs(filtered)).not.toContain(pair.summary.id)
          expect(projectionText(filtered)).toContain("genuine head question")
          expect(projectionText(filtered)).toContain("genuine later question")
          expect(projectionText(filtered)).not.toContain("summary one")
          // No pending ordinary compaction is fabricated from the remnant.
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "revert cleanup of a published compaction falls back to the preceding valid projection",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const between = yield* pubUser(sid, 150)
          yield* pubText(sid, between.id, "turn between pairs")
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
          ])

          // Authorized revert of the newer compaction turn, then cleanup.
          const marked = yield* revert.revert({ sessionID: sid, messageID: second.owner.id })
          yield* revert.cleanup(marked)

          const remaining = yield* session.messages({ sessionID: sid })
          const remainingIDs = remaining.map((msg) => msg.info.id)
          expect(remainingIDs).toContain(first.owner.id)
          expect(remainingIDs).toContain(first.summary.id)
          expect(remainingIDs).not.toContain(second.owner.id)
          expect(remainingIDs).not.toContain(second.summary.id)

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toEqual([first.owner.id, first.summary.id, between.id])
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "legacy full-summary deletion keeps raw history and does not fabricate a replacement",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const head = yield* pubUser(sid, 50)
          yield* pubText(sid, head.id, "legacy head question")
          const headReply = yield* pubAssistant(sid, head.id, 60)
          yield* pubText(sid, headReply.id, "legacy head reply")
          const legacy = yield* legacyFullPair(sid, { owner: 100, summary: 110 }, "legacy full summary")

          const before = yield* session.messages({ sessionID: sid })
          const projected = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionText(projected)).toContain("legacy full summary")
          expect(projectionText(projected)).not.toContain("legacy head question")

          yield* session.removeMessage({ sessionID: sid, messageID: legacy.summary.id })

          const after = yield* session.messages({ sessionID: sid })
          expect(JSON.stringify(after)).toBe(JSON.stringify(before.filter((msg) => msg.info.id !== legacy.summary.id)))

          // No replacement summary is fabricated and no stale record rewritten.
          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).not.toContain(legacy.summary.id)
          expect(projectionText(filtered)).not.toContain("legacy full summary")
          const remaining = after.find((msg) => msg.info.id === legacy.owner.id)
          expect(remaining?.info.role).toBe("user")
          expect(remaining?.parts.some((part) => part.type === "compaction")).toBe(true)

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "stale writes cannot resurrect a deleted published summary through the durable pipeline",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          const later = yield* pubUser(sid, 300)
          yield* pubText(sid, later.id, "later genuine question")

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
            later.id,
          ])

          // Authorized MessageRemoved of the published summary S.
          yield* session.removeMessage({ sessionID: sid, messageID: second.summary.id })

          const afterDeletion = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(afterDeletion)).toEqual([first.owner.id, first.summary.id, later.id])
          expect(projectionText(afterDeletion)).toContain("summary one")
          expect(projectionText(afterDeletion)).not.toContain("summary two")
          // P remains persisted as published; S and its content are removed.
          const rawAfterDeletion = yield* session.messages({ sessionID: sid })
          const ownerAfterDeletion = rawAfterDeletion.find((msg) => msg.info.id === second.owner.id)
          expect(ownerAfterDeletion?.parts.some((part) => part.type === "compaction")).toBeTrue()
          expect(rawAfterDeletion.some((msg) => msg.info.id === second.summary.id)).toBeFalse()

          // B1: a stale producer recreates S with the same ID, summary:true,
          // correct parent, and NO finish.
          const b1 = yield* session
            .updateMessage({
              id: second.summary.id,
              role: "assistant" as const,
              sessionID: sid,
              mode: "default",
              agent: "default",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("gpt-4"),
              providerID: ProviderV2.ID.make("openai"),
              parentID: second.owner.id,
              time: { created: 210 },
              summary: true,
            } as unknown as SessionV1.Info)
            .pipe(Effect.exit)
          expect(Exit.isFailure(b1)).toBeTrue()

          // B2: a stale producer inserts text for the still-missing S.
          const b2 = yield* session
            .updatePart({
              id: second.summaryText.id,
              messageID: second.summary.id,
              sessionID: sid,
              type: "text",
              text: "resurrected summary two",
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isFailure(b2)).toBeTrue()

          // B3: a stale producer completes the still-missing S with finish:"stop".
          const b3 = yield* session
            .updateMessage({
              id: second.summary.id,
              role: "assistant" as const,
              sessionID: sid,
              mode: "default",
              agent: "default",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("gpt-4"),
              providerID: ProviderV2.ID.make("openai"),
              parentID: second.owner.id,
              time: { created: 210, completed: 220 },
              summary: true,
              finish: "stop",
            } as unknown as SessionV1.Info)
            .pipe(Effect.exit)
          expect(Exit.isFailure(b3)).toBeTrue()

          // The authorized deletion stands: newest pair stays non-authoritative,
          // the previous pair stays authoritative, and no stale content appears.
          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toEqual([first.owner.id, first.summary.id, later.id])
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")
          expect(projectionText(filtered)).not.toContain("resurrected summary two")
          const raw = yield* session.messages({ sessionID: sid })
          expect(raw.some((msg) => msg.info.id === second.summary.id)).toBeFalse()
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "a deleted published compaction part cannot be reinserted by a stale producer",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const tail = yield* pubUser(sid, 150)
          yield* pubText(sid, tail.id, "retained turn")
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, {
            text: "summary two",
            tail: tail.id,
          })

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
            tail.id,
          ])

          // Authorized PartRemoved of the published compaction part P.
          yield* session.removePart({ sessionID: sid, messageID: second.owner.id, partID: second.partID })

          const afterRemoval = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(afterRemoval)).toEqual([first.owner.id, first.summary.id, tail.id])
          expect(projectionText(afterRemoval)).toContain("summary one")
          expect(projectionText(afterRemoval)).not.toContain("summary two")
          const rawAfterRemoval = yield* session.messages({ sessionID: sid })
          expect(
            rawAfterRemoval.find((msg) => msg.info.id === second.owner.id)?.parts.some((part) => part.type === "compaction"),
          ).toBeFalsy()

          // A stale producer resubmits the exact deleted published part — same
          // part ID, same owner, same summaryID, published state, same tail —
          // under a fresh durable event ID and the next valid sequence.
          const stale = yield* session
            .updatePart({
              id: second.partID,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction",
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
              tail_start_id: tail.id,
            } as SessionV1.Part)
            .pipe(Effect.exit)
          expect(Exit.isFailure(stale)).toBeTrue()

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          expect(projectionIDs(filtered)).toEqual([first.owner.id, first.summary.id, tail.id])
          expect(projectionText(filtered)).not.toContain("summary two")
          const raw = yield* session.messages({ sessionID: sid })
          expect(
            raw.find((msg) => msg.info.id === second.owner.id)?.parts.some((part) => part.type === "compaction"),
          ).toBeFalsy()
          expect(MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks).toEqual([])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "R4a: retyping a fresh ordinary part under a deleted publication owner cannot restore authority",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const head = yield* pubUser(sid, 50)
          yield* pubText(sid, head.id, "head question")
          const headReply = yield* pubAssistant(sid, head.id, 60)
          yield* pubText(sid, headReply.id, "head reply")

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          const later = yield* pubUser(sid, 300)
          yield* pubText(sid, later.id, "later genuine question")

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
            later.id,
          ])

          // Authorized PartRemoved of the published publication binding.
          yield* session.removePart({ sessionID: sid, messageID: second.owner.id, partID: second.partID })
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            first.owner.id,
            first.summary.id,
            later.id,
          ])

          // An ordinary text part under the SAME owner stays ordinary work.
          const t = yield* pubText(sid, second.owner.id, "ordinary under owner")

          // Probe 1: retype the fresh row directly into a published compaction
          // bound to the removed publication's exact summary.
          const direct = yield* session
            .updatePart({
              id: t.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          // Probe 2: a second fresh row walked through queued -> preparing ->
          // published.
          const t2 = yield* pubText(sid, second.owner.id, "ordinary path two")
          const queued = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "queued" },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)
          const preparing = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "preparing" },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)
          const published = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          const raw = yield* session.messages({ sessionID: sid })
          const ownerParts = raw.find((msg) => msg.info.id === second.owner.id)?.parts ?? []

          // Observed outcomes: pre-fix every probe commits, the deleted
          // publication becomes authoritative again, and no durable rollback
          // happens; post-fix every probe is rejected inside the durable
          // event transaction and the deletion remains authoritative.
          expect({
            directRejected: Exit.isFailure(direct),
            queuedRejected: Exit.isFailure(queued),
            preparingRejected: Exit.isFailure(preparing),
            publishedRejected: Exit.isFailure(published),
            projection: projectionIDs(filtered),
            ownerCompactionParts: ownerParts.filter((part) => part.type === "compaction").length,
            pendingTasks: MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks.length,
          }).toEqual({
            directRejected: true,
            queuedRejected: true,
            preparingRejected: true,
            publishedRejected: true,
            projection: [first.owner.id, first.summary.id, later.id],
            ownerCompactionParts: 0,
            pendingTasks: 0,
          })
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "R4b: an existing ordinary part under the deleted publication owner cannot be repurposed",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          // Two ordinary text parts already present under the owner.
          const t1 = yield* pubText(sid, second.owner.id, "ordinary one")
          const t2 = yield* pubText(sid, second.owner.id, "ordinary two")

          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
          ])

          // Authorized PartRemoved: both ordinary rows already exist, which is
          // the exact boundary the removal guard previously skipped.
          yield* session.removePart({ sessionID: sid, messageID: second.owner.id, partID: second.partID })
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            first.owner.id,
            first.summary.id,
          ])

          // Probe A: retype the pre-existing T1 directly to published.
          const direct = yield* session
            .updatePart({
              id: t1.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          // Probe B: the pre-existing T2 walks queued -> preparing -> published.
          const queued = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "queued" },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)
          const preparing = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "preparing" },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)
          const published = yield* session
            .updatePart({
              id: t2.id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          // Probe C: reinsert the EXACT removed part id as ordinary text —
          // ordinary text part updates are never scanned, so this stays
          // allowed before and after the correction.
          const reinsert = yield* session
            .updatePart({
              id: second.partID,
              messageID: second.owner.id,
              sessionID: sid,
              type: "text" as const,
              text: "reinserted as ordinary",
            })
            .pipe(Effect.exit)

          // Probe D: retype the reinserted removed id into a compaction part.
          const retypeRemoved = yield* session
            .updatePart({
              id: second.partID,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "published", summaryID: second.summary.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          const raw = yield* session.messages({ sessionID: sid })
          const ownerParts = raw.find((msg) => msg.info.id === second.owner.id)?.parts ?? []

          expect({
            directRejected: Exit.isFailure(direct),
            queuedRejected: Exit.isFailure(queued),
            preparingRejected: Exit.isFailure(preparing),
            publishedRejected: Exit.isFailure(published),
            reinsertAccepted: Exit.isSuccess(reinsert),
            retypeRemovedRejected: Exit.isFailure(retypeRemoved),
            ownerCompactionParts: ownerParts.filter((part) => part.type === "compaction").length,
            projection: projectionIDs(filtered),
            pendingTasks: MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks.length,
          }).toEqual({
            directRejected: true,
            queuedRejected: true,
            preparingRejected: true,
            publishedRejected: true,
            reinsertAccepted: true,
            retypeRemovedRejected: true,
            ownerCompactionParts: 0,
            projection: [first.owner.id, first.summary.id],
            pendingTasks: 0,
          })
          // The owner retains exactly the three ordinary text parts and no
          // compaction binding; the deleted publication stays deleted.
          expect(ownerParts).toHaveLength(3)
          expect(ownerParts.every((part) => part.type === "text")).toBeTrue()
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "R4c: a duplicate compaction part under one owner cannot be created, run, or regain authority",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({})
          const sid = info.id

          const first = yield* publishedPair(sid, { owner: 100, summary: 110 }, { text: "summary one" })
          const second = yield* publishedPair(sid, { owner: 200, summary: 210 }, { text: "summary two" })
          expect(projectionIDs(yield* MessageV2.filterCompactedEffect(sid))).toEqual([
            second.owner.id,
            second.summary.id,
          ])

          // Probe: a distinct compaction part under the SAME owner while the
          // original publication is still published.
          const p2id = PartID.ascending()
          const duplicate = yield* session
            .updatePart({
              id: p2id,
              messageID: second.owner.id,
              sessionID: sid,
              type: "compaction" as const,
              auto: true,
              publication: { state: "queued" },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)

          // Authorized PartRemoved of the ORIGINAL publication binding.
          yield* session.removePart({ sessionID: sid, messageID: second.owner.id, partID: second.partID })

          // Runnable-work discovery on persisted history immediately after
          // the authorized deletion.
          const pendingAfterRemoval = MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks.length

          // If the duplicate was accepted (the pre-fix bypass), walk the rest
          // of the exploit chain so the recorded outcome shows whether a
          // surviving duplicate can execute or regain publication authority.
          let prepared: Exit.Exit<SessionV1.CompactionPart, unknown> | undefined
          let republished: Exit.Exit<SessionV1.CompactionPart, unknown> | undefined
          if (Exit.isSuccess(duplicate)) {
            prepared = yield* session
              .updatePart({
                id: p2id,
                messageID: second.owner.id,
                sessionID: sid,
                type: "compaction" as const,
                auto: true,
                publication: { state: "preparing" },
              } as SessionV1.CompactionPart)
              .pipe(Effect.exit)
            republished = yield* session
              .updatePart({
                id: p2id,
                messageID: second.owner.id,
                sessionID: sid,
                type: "compaction" as const,
                auto: true,
                publication: { state: "published", summaryID: second.summary.id },
              } as SessionV1.CompactionPart)
              .pipe(Effect.exit)
          }

          const filtered = yield* MessageV2.filterCompactedEffect(sid)
          const raw = yield* session.messages({ sessionID: sid })
          const ownerParts = raw.find((msg) => msg.info.id === second.owner.id)?.parts ?? []

          expect({
            duplicateRejected: Exit.isFailure(duplicate),
            pendingAfterRemoval,
            duplicatePrepared: prepared === undefined ? undefined : Exit.isSuccess(prepared),
            duplicateRepublished: republished === undefined ? undefined : Exit.isSuccess(republished),
            projection: projectionIDs(filtered),
            ownerCompactionParts: ownerParts.filter((part) => part.type === "compaction").length,
            pendingFinal: MessageV2.pendingWork(yield* MessageV2.stream(sid)).tasks.length,
          }).toEqual({
            duplicateRejected: true,
            pendingAfterRemoval: 0,
            duplicatePrepared: undefined,
            duplicateRepublished: undefined,
            projection: [first.owner.id, first.summary.id],
            ownerCompactionParts: 0,
            pendingFinal: 0,
          })
          expect(projectionText(filtered)).toContain("summary one")
          expect(projectionText(filtered)).not.toContain("summary two")

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )
})
