import { afterEach, describe, expect, mock, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { asc, eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import { Plugin } from "../../src/plugin"
import { Agent } from "@/agent/agent"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

const basicUsage = () => usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  id?: string
  providerID?: string
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: opts.id ?? "test-model",
    providerID: opts.providerID ?? "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function providerFor(...models: Provider.Model[]) {
  const available = Object.fromEntries(models.map((model) => [model.id, model]))
  const first = models[0]!
  return ProviderTest.fake({
    model: first,
    info: ProviderTest.info({ models: available }, first),
    getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
      const model = providerID === first.providerID ? available[modelID] : undefined
      return model ? Effect.succeed(model) : Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
    }),
  })
}

function compactionAgent(model: Provider.Model) {
  const info = {
    name: "compaction",
    mode: "primary",
    options: {},
    permission: [],
    model: { providerID: model.providerID, modelID: model.id },
  } as Agent.Info
  return Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      get: () => Effect.succeed(info),
      list: () => Effect.succeed([info]),
      defaultInfo: () => Effect.succeed(info),
      defaultAgent: () => Effect.succeed(info.name),
      generate: () => Effect.die(new Error("unused")),
    }),
  )
}

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function createCompactionMarker(sessionID: SessionID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
      })
    }),
  )
}

function createCompactionRequest(
  sessionID: SessionID,
  options?: {
    origin?: string
    publication?: SessionV1.CompactionPart["publication"]
    tailStartID?: MessageID
  },
) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
        ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
        ...(options?.tailStartID !== undefined ? { tail_start_id: options.tailStartID } : {}),
        ...(options?.publication !== undefined ? { publication: options.publication } : {}),
      })
      return msg
    }),
  )
}

function createPublishedCompaction(
  sessionID: SessionID,
  root: string,
  summaryText: string,
  options?: {
    origin?: string
    tailStartID?: MessageID
  },
) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
        ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      })
      const summary = yield* createSummaryAssistantMessage(sessionID, msg.id, root, summaryText)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "compaction",
        auto: false,
        ...(options?.tailStartID !== undefined ? { tail_start_id: options.tailStartID } : {}),
        publication: { state: "published", summaryID: summary.id },
      })
      return { user: msg, summary }
    }),
  )
}

function createFailedSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now(), completed: Date.now() },
        finish: "error",
        error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject(),
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    markToolExecutionStarted: Effect.fn("TestSessionProcessor.markToolExecutionStarted")(() => Effect.void),
    finalizeFailure: Effect.fn("TestSessionProcessor.finalizeFailure")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, compaction }) }))
}

const defaultProvider = wide()
const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const env = AppNodeBuilder.build(compactionTestNode, [
  [Provider.node, defaultProvider.layer],
  [SessionProcessorModule.SessionProcessor.node, processorLayer("continue")],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
])

const it = testEffect(env)

const compactionEnv = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const itCompaction = testEffect(compactionEnv)

type CompactionProcessOptions = {
  result?: "continue" | "compact"
  llm?: Layer.Layer<LLM.Service>
  plugin?: Layer.Layer<Plugin.Service>
  provider?: ReturnType<typeof wide>
  config?: Layer.Layer<Config.Service>
  agent?: Layer.Layer<Agent.Service>
  processor?: Layer.Layer<SessionProcessorModule.SessionProcessor.Service, never, SessionNs.Service>
}

function withCompaction(options?: CompactionProcessOptions) {
  return Effect.provide(compactionProcessLayer(options))
}

function compactionProcessLayer(options?: CompactionProcessOptions) {
  const replacements: LayerNode.Replacements = [
    [Provider.node, (options?.provider ?? wide()).layer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [SessionSummary.node, summary],
  ]
  const processorReplacement: LayerNode.Replacements[number] = [
    SessionProcessorModule.SessionProcessor.node,
    options?.processor ?? processorLayer(options?.result ?? "continue"),
  ]
  if (!options?.llm) {
    return AppNodeBuilder.build(compactionTestNode, [
      ...replacements,
      processorReplacement,
      ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
      ...(options?.config ? ([[Config.node, options.config]] as const) : []),
      ...(options?.agent ? ([[Agent.node, options.agent]] as const) : []),
    ])
  }
  return AppNodeBuilder.build(compactionTestNode, [
    ...replacements,
    [LLM.node, options.llm],
    ...(options?.processor ? [processorReplacement] : []),
    ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
    ...(options?.config ? ([[Config.node, options.config]] as const) : []),
    ...(options?.agent ? ([[Agent.node, options.agent]] as const) : []),
  ])
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.at(-2)?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

function readOwnedCompactionPart(sessionID: SessionID, ownerID: MessageID) {
  return SessionNs.use.messages({ sessionID }).pipe(
    Effect.map((messages) => {
      const owner = messages.find((msg) => msg.info.id === ownerID)
      return owner?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
    }),
  )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  > = []
  const inputs: LLM.StreamInput[] = []

  return {
    push(stream: Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)) {
      queue.push(stream)
    },
    llmLayer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          inputs.push(input)
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
    inputs,
  }
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: basicUsage(),
      }),
      LLMEvent.finish({
        reason: "stop",
        usage: basicUsage(),
      }),
    )
  }
}

function plugin(ready: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.as(output),
      )
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function compactionContext(context: string) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { context: string[] }).context.push(context)
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  it.live(
    "BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "BUG: without limit.input, same token count correctly triggers compaction",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = yield* compact.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      }),
    ),
  )

  it.live(
    "BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = yield* compact.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      }),
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )
})

describe("session.compaction.process", () => {
  it.instance(
    "throws when parent is not a user message",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const reply = yield* createAssistantMessage(session.id, msg.id, test.directory)
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: reply.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain(`Compaction parent must be a user message: ${reply.id}`)
        }
      }
    }),
  )

  itCompaction.instance(
    "publishes compacted event on continue",
    () => {
      const stub = llm()
      stub.push(reply("published summary content"))
      return Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "hello")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        const done = yield* Deferred.make<void, Error>()
        const seen: string[] = []
        const unsub = yield* events.listen((evt) => {
          seen.push(evt.type)
          if (evt.type !== SessionCompaction.Event.Compacted.type) return Effect.void
          if ((evt.data as typeof SessionCompaction.Event.Compacted.data.Type).sessionID !== session.id)
            return Effect.void
          Deferred.doneUnsafe(done, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        yield* Deferred.await(done).pipe(Effect.timeout("500 millis"))
        expect(result).toBe("continue")
        expect(seen).toContain(SessionCompaction.Event.Compacted.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
        // Compacted is published only after the single final publication event.
        const part = yield* readCompactionPart(session.id)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "marks summary message as errored on compact result",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (msg) => msg.info.role === "assistant" && msg.info.summary,
      )

      expect(result).toBe("stop")
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role === "assistant") {
        expect(summary.info.finish).toBe("error")
        expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
      }
    }).pipe(withCompaction({ result: "compact" })),
  )

  itCompaction.instance(
    "uses a larger fallback compaction model when the explicit compaction source budget is too small",
    () => {
      const source = createModel({ id: "compact-small", context: 2_000, output: 256 })
      const fallback = createModel({ id: "fallback-large", context: 10_000, output: 512 })
      const runtime = llm()
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        runtime.push(reply("summary from larger fallback"))
        const original = yield* createUserMessage(session.id, "x".repeat(16_000))
        yield* createSummaryCompaction(session.id)
        const messages = yield* ssn.messages({ sessionID: session.id })
        const parentID = messages.at(-1)!.info.id

        const result = yield* SessionCompaction.use.process({
          parentID,
          messages,
          sessionID: session.id,
          auto: false,
          resolveFallback: () =>
            Effect.succeed({
              reason: "available" as const,
              ref: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make(fallback.id) },
              model: fallback,
            }),
        })

        const stored = yield* ssn.messages({ sessionID: session.id })
        const summaryMessage = stored.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)
        expect(result).toBe("continue")
        expect(runtime.inputs.map((input) => input.model.id)).toEqual([fallback.id])
        expect(summaryMessage?.info.role).toBe("assistant")
        if (summaryMessage?.info.role === "assistant") {
          expect(summaryMessage.info.modelID).toBe(ModelV2.ID.make(fallback.id))
          expect(summaryMessage.info.providerID).toBe(ProviderV2.ID.make("test"))
          expect(
            summaryMessage.parts.some((part) => part.type === "text" && part.text === "summary from larger fallback"),
          ).toBe(true)
        }
        expect(stored.find((msg) => msg.info.id === original.id)?.parts[0]).toMatchObject({
          type: "text",
          text: "x".repeat(16_000),
        })
        const continuation = yield* MessageV2.filterCompactedEffect(session.id)
        expect(continuation.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      }).pipe(
        withCompaction({
          provider: providerFor(source, fallback),
          agent: compactionAgent(source),
          llm: runtime.llmLayer,
        }),
      )
    },
  )

  {
    const source = createModel({ id: "compact-large", context: 20_000, output: 512 })
    const fallback = createModel({ id: "fallback-smaller", context: 12_000, output: 512 })
    const runtime = llm()
    itCompaction.instance("completes fallback compaction when the history fits its smaller effective budget", () => {
      return Effect.gen(function* () {
        runtime.push(Stream.make(LLMEvent.providerError({ message: "primary stream failed" })))
        runtime.push(reply("fallback summary"))
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const original = yield* createUserMessage(session.id, "x".repeat(16_000))
        yield* createSummaryCompaction(session.id)
        const messages = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: messages.at(-1)!.info.id,
          messages,
          sessionID: session.id,
          auto: false,
          resolveFallback: () =>
            Effect.succeed({
              reason: "available" as const,
              ref: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make(fallback.id) },
              model: fallback,
            }),
        })
        const stored = yield* ssn.messages({ sessionID: session.id })
        const summaryMessage = stored.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)

        expect(result).toBe("continue")
        expect(runtime.inputs.map((input) => input.model.id)).toEqual([source.id, fallback.id])
        expect(stored.find((msg) => msg.info.id === original.id)?.parts[0]).toMatchObject({
          type: "text",
          text: "x".repeat(16_000),
        })
        expect(summaryMessage?.info.role).toBe("assistant")
        if (summaryMessage?.info.role === "assistant") {
          expect(summaryMessage.info.modelID).toBe(ModelV2.ID.make(fallback.id))
          expect(summaryMessage.info.providerID).toBe(ProviderV2.ID.make("test"))
          expect(summaryMessage.parts.some((part) => part.type === "text" && part.text === "fallback summary")).toBe(
            true,
          )
        }
      }).pipe(
        withCompaction({
          provider: providerFor(source, fallback),
          llm: runtime.llmLayer,
          agent: compactionAgent(source),
        }),
      )
    })
  }

  {
    const source = createModel({ id: "compact-million-class", context: 20_000, output: 512 })
    const fallback = createModel({ id: "fallback-small", context: 2_000, output: 512 })
    const runtime = llm()
    itCompaction.instance(
      "does not dispatch oversized history to a smaller fallback and preserves prior conversation data",
      () => {
        return Effect.gen(function* () {
          runtime.push(Stream.make(LLMEvent.providerError({ message: "primary stream failed" })))
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          yield* createUserMessage(session.id, "earlier conversation")
          yield* createSummaryCompaction(session.id)
          const first = yield* ssn.messages({ sessionID: session.id })
          const priorMarker = first.at(-1)!
          yield* createSummaryAssistantMessage(
            session.id,
            priorMarker.info.id as MessageID,
            "/tmp",
            "prior saved summary",
          )
          const oversized = yield* createUserMessage(session.id, "z".repeat(40_000))
          yield* createSummaryCompaction(session.id)
          const messages = yield* ssn.messages({ sessionID: session.id })
          const result = yield* SessionCompaction.use.process({
            parentID: messages.at(-1)!.info.id,
            messages,
            sessionID: session.id,
            auto: false,
            resolveFallback: () =>
              Effect.succeed({
                reason: "available" as const,
                ref: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make(fallback.id) },
                model: fallback,
              }),
          })
          const stored = yield* ssn.messages({ sessionID: session.id })
          const priorSummary = stored.find(
            (msg) =>
              msg.info.role === "assistant" &&
              msg.parts.some((part) => part.type === "text" && part.text === "prior saved summary"),
          )
          const failure = stored.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)
          expect(result).toBe("stop")
          expect(runtime.inputs.map((input) => input.model.id)).toEqual([source.id])
          expect(stored.find((msg) => msg.info.id === oversized.id)?.parts[0]).toMatchObject({
            type: "text",
            text: "z".repeat(40_000),
          })
          expect(priorSummary).toBeDefined()
          expect(failure?.info.role).toBe("assistant")
          if (failure?.info.role === "assistant") {
            expect(failure.info.finish).toBe("error")
            expect(JSON.stringify(failure.info.error)).toContain("effective input budget")
            expect(JSON.stringify(failure.info.error)).toContain(fallback.id)
          }
        }).pipe(
          withCompaction({
            provider: providerFor(source, fallback),
            llm: runtime.llmLayer,
            agent: compactionAgent(source),
          }),
        )
      },
    )
  }

  itCompaction.instance("dispatches small compaction requests when the source context ceiling is unknown", () => {
    const source = createModel({ id: "compact-unknown-context", context: 0, output: 512 })
    const runtime = llm()
    return Effect.gen(function* () {
      runtime.push(reply("summary with unknown context ceiling"))
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const original = yield* createUserMessage(session.id, "small conversation")
      yield* createSummaryCompaction(session.id)
      const before = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: before.at(-1)!.info.id,
        messages: before,
        sessionID: session.id,
        auto: false,
      })

      const stored = yield* ssn.messages({ sessionID: session.id })
      const summaryMessage = stored.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)
      expect(runtime.inputs.map((input) => input.model.id)).toEqual([source.id])
      expect(result).toBe("continue")
      expect(summaryMessage?.info.role).toBe("assistant")
      if (summaryMessage?.info.role === "assistant") {
        expect(summaryMessage.info.error).toBeUndefined()
        expect(
          summaryMessage.parts.some((part) => part.type === "text" && part.text === "summary with unknown context ceiling"),
        ).toBe(true)
      }
      // Historical messages are preserved verbatim; only the compaction
      // request's own publication metadata may advance through the writer
      // lifecycle (queued → preparing → published).
      const unchanged = (msg: (typeof stored)[number]) =>
        msg.parts.every((part) => part.type !== "compaction")
          ? msg
          : { ...msg, parts: msg.parts.filter((part) => part.type !== "compaction") }
      expect(stored.filter((msg) => before.some((previous) => previous.info.id === msg.info.id)).map(unchanged)).toEqual(
        before.map(unchanged),
      )
      expect(stored.find((msg) => msg.info.id === original.id)?.parts[0]).toMatchObject({
        type: "text",
        text: "small conversation",
      })
    }).pipe(
      withCompaction({
        provider: providerFor(source),
        agent: compactionAgent(source),
        llm: runtime.llmLayer,
      }),
    )
  })

  itCompaction.instance(
    "adds synthetic continue prompt when auto is enabled",
    () => {
      const stub = llm()
      stub.push(reply("auto summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "hello")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()

        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: true,
        })

        const all = yield* ssn.messages({ sessionID: session.id })
        const last = all.at(-1)

        expect(result).toBe("continue")
        expect(last?.info.role).toBe("user")
        expect(last?.parts[0]).toMatchObject({
          type: "text",
          synthetic: true,
          metadata: { compaction_continue: true },
        })
        // Autocontinue runs only after the publication event committed.
        const part = yield* readOwnedCompactionPart(session.id, parent!)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "persists tail_start_id for retained recent turns",
    () => {
      const stub = llm()
      stub.push(reply("summary with retained tail"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        const keep = yield* createUserMessage(session.id, "second")
        yield* createUserMessage(session.id, "third")
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const part = yield* readCompactionPart(session.id)
        expect(result).toBe("continue")
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        // The tail marker and the publication state are persisted together in
        // the single final publication event.
        expect(part?.publication?.state).toBe("published")
      }).pipe(
        withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }),
      )
    },
  )

  itCompaction.instance(
    "shrinks retained tail to fit preserve token budget",
    () => {
      const stub = llm()
      stub.push(reply("summary with shrunk tail"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "x".repeat(2_000))
        const keep = yield* createUserMessage(session.id, "tiny")
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(part?.publication?.state).toBe("published")
      }).pipe(
        withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 100 }) }),
      )
    },
  )

  itCompaction.instance(
    "falls back to full summary when even one recent turn exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "y".repeat(2_000))
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("yyyy")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "falls back to full summary when retained tail media exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent image turn")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("recent image turn")
        expect(captured).toContain("Attached image/png: big.png")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "retains a split turn suffix when a later message fits the preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent turn")
        const large = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(captured).toContain("zzzz")
        expect(captured).not.toContain("keep tail")

        const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(filtered.map((msg) => msg.info.id).slice(0, 3)).toEqual([parent!, expect.any(String), keep.id])
        expect(filtered[1]?.info.role).toBe("assistant")
        expect(filtered[1]?.info.role === "assistant" ? filtered[1].info.summary : false).toBe(true)
        expect(filtered.map((msg) => msg.info.id)).not.toContain(large.id)
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "allows plugins to disable synthetic continue prompt",
    () => {
      const stub = llm()
      stub.push(reply("summary without continue"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "hello")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()

        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: true,
        })

        const all = yield* ssn.messages({ sessionID: session.id })
        const last = all.at(-1)

        expect(result).toBe("continue")
        expect(last?.info.role).toBe("assistant")
        expect(
          all.some(
            (msg) =>
              msg.info.role === "user" &&
              msg.parts.some(
                (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
              ),
          ),
        ).toBe(false)
        const part = yield* readOwnedCompactionPart(session.id, parent!)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer, plugin: autocontinue(false) }))
    },
  )

  itCompaction.instance(
    "replays the prior user turn on overflow when earlier context exists",
    () => {
      const stub = llm()
      stub.push(reply("overflow summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "root")
        const replay = yield* createUserMessage(session.id, "image")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: replay.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "cat.png",
          url: "https://example.com/cat.png",
        })
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()

        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: true,
          overflow: true,
        })

        const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

        expect(result).toBe("continue")
        expect(last?.info.role).toBe("user")
        expect(last?.parts.some((part) => part.type === "file")).toBe(false)
        expect(
          last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
        ).toBe(true)
        // Overflow replay happens only after the publication event committed.
        const part = yield* readOwnedCompactionPart(session.id, parent!)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "falls back to overflow guidance when no replayable turn exists",
    () => {
      const stub = llm()
      stub.push(reply("overflow summary without replay"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "earlier")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()

        const result = yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: true,
          overflow: true,
        })

        const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

        expect(result).toBe("continue")
        expect(last?.info.role).toBe("user")
        if (last?.parts[0]?.type === "text") {
          expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
        }
        const part = yield* readOwnedCompactionPart(session.id, parent!)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "stops quickly when aborted during retry backoff",
    () => {
      const stub = llm()
      stub.push(
        Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              yield LLMEvent.stepStart({ index: 0 })
              throw new APICallError({
                message: "boom",
                url: "https://example.com/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10000" },
                responseBody: '{"error":"boom"}',
                isRetryable: true,
              })
            },
          },
          (err) => err,
        ),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const ready = yield* Deferred.make<void>()
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== session.id || data.status.type !== "retry") return Effect.void
          Deferred.doneUnsafe(ready, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        const fiber = yield* SessionCompaction.use
          .process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            auto: false,
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const start = Date.now()
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Date.now() - start).toBeLessThan(250)
        }
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
    { timeout: 10_000 },
  )

  itCompaction.instance(
    "does not leave a summary assistant when aborted before processor setup",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const msg = yield* createUserMessage(session.id, "hello")
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: msg.id,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "silently drops reasoning-delta arriving without prior reasoning-start",
    () => {
      // Regression: PR initially auto-created a reasoning Part for orphan deltas (no preceding
      // reasoning-start). Reverted to match dev — drop silently. Pinned here so any future
      // change to processor.ts reasoning-delta handling triggers this test.
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.reasoningDelta({ id: "orphan-1", text: "stray reasoning" }),
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: "summary" }),
          LLMEvent.textEnd({ id: "txt-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
          LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )
        expect(summary?.parts.some((part) => part.type === "reasoning")).toBe(false)
        // Sanity: the text part still got through.
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "does not allow tool calls while generating the summary",
    () => {
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.toolCall({ id: "call-1", name: "_noop", input: {} }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: basicUsage(),
          }),
          LLMEvent.finish({
            reason: "tool-calls",
            usage: basicUsage(),
          }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )

        expect(summary?.info.role).toBe("assistant")
        expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes only the head while keeping recent tail out of summary input",
    () => {
      const stub = llm()
      let messages: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary", (input) => {
          messages = input.messages
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const captured = JSON.stringify(messages)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.role).toBe("user")
        expect(captured).toContain("Here is the conversation so far:")
        expect(captured).toContain("<conversation>")
        expect(captured.indexOf("[User]: older context")).toBeLessThan(
          captured.indexOf("Create a new anchored summary"),
        )
        expect(captured).toContain("[User]: older context")
        expect(captured).not.toContain("keep this turn")
        expect(captured).not.toContain("and this one too")
        expect(captured).not.toContain("What did we do so far?")
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "anchors repeated compactions with the previous summary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary one"))
      stub.push(
        reply("summary two", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "latest turn")
        yield* createCompactionMarker(session.id)

        msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toContain("<prior-summary>")
        expect(captured).toContain("summary one")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured.indexOf("latest turn")).toBeLessThan(captured.indexOf("<prior-summary>"))
        expect(captured).toContain("summary of the conversation before the <conversation> above")
        expect(captured).toContain("## Important Details")
        expect(captured).toContain("## Work State")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "keeps plugin context outside the serialized conversation",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).toContain("Prioritize unresolved migration details")
        expect(captured.indexOf("</conversation>")).toBeLessThan(
          captured.indexOf("Prioritize unresolved migration details"),
        )
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          plugin: compactionContext("Prioritize unresolved migration details"),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "serializes repeated compaction history as one user message",
    () => {
      const stub = llm()
      let captured: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary two", (input) => {
          captured = input.messages
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const turn = yield* createUserMessage(session.id, "original request")
        const kept = yield* createAssistantMessage(session.id, turn.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: kept.id,
          sessionID: session.id,
          type: "tool",
          callID: "read-call",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/index.ts" },
            output: "file contents",
            title: "src/index.ts",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })

        const previous = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: previous.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
          tail_start_id: kept.id,
        })
        yield* createSummaryAssistantMessage(session.id, previous.id, test.directory, "summary one")
        yield* createCompactionMarker(session.id)

        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toHaveLength(1)
        expect(captured[0]?.role).toBe("user")
        expect(JSON.stringify(captured)).toContain('[Assistant tool call]: read({\\"filePath\\":\\"src/index.ts\\"})')
        expect(JSON.stringify(captured)).toContain("[Tool result]: file contents")
        expect(JSON.stringify(captured)).not.toContain('\\"role\\":\\"assistant\\"')
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 0 }) }))
    },
    { git: true },
  )

  itCompaction.instance("keeps recent pre-compaction turns across repeated compactions", () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* createUserMessage(session.id, "one")
      const u2 = yield* createUserMessage(session.id, "two")
      const u3 = yield* createUserMessage(session.id, "three")
      yield* createCompactionMarker(session.id)

      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const u4 = yield* createUserMessage(session.id, "four")
      yield* createCompactionMarker(session.id)

      msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const ids = filtered.map((msg) => msg.info.id)

      expect(ids).not.toContain(u1.id)
      expect(ids).not.toContain(u2.id)
      expect(ids).toContain(u3.id)
      expect(ids).toContain(u4.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      expect(
        filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
      ).toBe(true)
    }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
  })

  itCompaction.instance(
    "ignores previous summaries when sizing the retained tail",
    () => {
      const stub = llm()
      stub.push(reply("summary after large prior summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const keep = yield* createUserMessage(session.id, "keep this turn")
        const keepReply = yield* createAssistantMessage(session.id, keep.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keepReply.id,
          sessionID: session.id,
          type: "text",
          text: "keep reply",
        })

        yield* createCompactionMarker(session.id)
        const firstCompaction = (yield* ssn.messages({ sessionID: session.id })).at(-1)?.info.id
        expect(firstCompaction).toBeTruthy()
        yield* createSummaryAssistantMessage(session.id, firstCompaction!, test.directory, "summary ".repeat(800))

        const recent = yield* createUserMessage(session.id, "recent turn")
        const recentReply = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recentReply.id,
          sessionID: session.id,
          type: "text",
          text: "recent reply",
        })

        yield* createCompactionMarker(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(part?.publication?.state).toBe("published")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 500 }) }))
    },
  )

  itCompaction.instance("keeps a valid legacy full summary complete in the chain", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary two", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      yield* createUserMessage(session.id, "after first compaction")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      expect(captured).toContain("<prior-summary>")
      expect(captured).toContain("[User]: older context")
      expect(captured.indexOf("[User]: older context")).toBeLessThan(captured.indexOf("<prior-summary>"))
      expect(captured.match(/summary one/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("an empty legacy summary still completes the prior-summary chain", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary next", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary zero")
      const second = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, second.id, test.directory, "")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      expect(captured).toContain("[User]: older context")
      expect(captured).not.toContain("<prior-summary>")
      expect(captured).not.toContain("summary zero")
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("a newer complete-but-unpublished candidate never replaces the prior summary", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      const newer = yield* createCompactionRequest(session.id, {
        origin: "compaction",
        publication: { state: "preparing" },
      })
      yield* createSummaryAssistantMessage(session.id, newer.id, test.directory, "summary two")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary one")
      expect(prior).not.toContain("summary two")
      expect(captured.match(/summary one/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("a newer failed summary never replaces the prior summary", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      const newer = yield* createCompactionRequest(session.id)
      yield* createFailedSummaryAssistantMessage(session.id, newer.id, test.directory, "failed summary")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary one")
      expect(prior).not.toContain("failed summary")
      expect(captured.match(/summary one/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("a newer abandoned candidate never replaces the prior summary", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      const newer = yield* createCompactionRequest(session.id, {
        origin: "compaction",
        publication: { state: "abandoned" },
      })
      yield* createSummaryAssistantMessage(session.id, newer.id, test.directory, "summary two")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary one")
      expect(prior).not.toContain("summary two")
      expect(captured.match(/summary one/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("an upgraded legacy pair published without a tail chains as the prior summary", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      yield* createPublishedCompaction(session.id, test.directory, "summary two")
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary two")
      expect(prior).not.toContain("summary one")
      expect(captured).not.toContain("summary one")
      expect(captured.match(/summary two/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("an upgraded legacy pair published with a retained tail chains as the prior summary", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
      const retained = yield* createUserMessage(session.id, "retained tail")
      yield* createPublishedCompaction(session.id, test.directory, "summary two", {
        tailStartID: retained.id,
      })
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary two")
      expect(prior).not.toContain("summary one")
      expect(captured).not.toContain("summary one")
      expect(captured.match(/summary two/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })

  itCompaction.instance("multiple published summaries retain the established chain", () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary three", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      yield* createPublishedCompaction(session.id, test.directory, "summary one", { origin: "compaction" })
      yield* createPublishedCompaction(session.id, test.directory, "summary two", { origin: "compaction" })
      yield* createCompactionRequest(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
      expect(prior).toContain("summary two")
      expect(prior).not.toContain("summary one")
      expect(captured).not.toContain("summary one")
      expect(captured.match(/summary two/g)?.length).toBe(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("ignores malformed cost fields", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    })
    Object.assign(model.cost, { input: {} })

    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(1.5)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})

describe("session.compaction invalid-tail previousSummary selection", () => {
  function buildInvalidTailHistory() {
    return SessionNs.Service.use((ssn) =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const head = yield* createUserMessage(session.id, "older context")
        const first = yield* createCompactionRequest(session.id)
        const firstSummary = yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
        const middle = yield* createUserMessage(session.id, "middle turn")
        const newer = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
          origin: "compaction",
        })
        const newerSummary = yield* createSummaryAssistantMessage(session.id, newer.id, test.directory, "summary two")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: newer.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
          tail_start_id: newer.id,
          publication: { state: "published", summaryID: newerSummary.id },
        })
        const later = yield* createUserMessage(session.id, "later question")
        const marker = yield* createCompactionRequest(session.id)
        return { session, head, first, firstSummary, middle, newer, newerSummary, later, marker }
      }),
    )
  }

  itCompaction.instance(
    "the next compaction previousSummary comes from the applicable projection, not the rejected pair",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary next", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const built = yield* buildInvalidTailHistory()
        const session = built.session

        const rawBefore = JSON.stringify(yield* ssn.messages({ sessionID: session.id }))
        expect(rawBefore).toContain(built.newer.id)
        expect(rawBefore).toContain(built.newerSummary.id)

        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(JSON.stringify(yield* ssn.messages({ sessionID: session.id }))).toBe(rawBefore)

        expect(msgs.map((msg) => msg.info.id)).toEqual([
          built.first.id,
          built.firstSummary.id,
          built.middle.id,
          built.later.id,
          built.marker.id,
        ])
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newer.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newerSummary.id)

        const parent = msgs.at(-1)?.info.id
        expect(parent).toBe(built.marker.id)
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
        expect(prior).toContain("summary one")
        expect(prior).not.toContain("summary two")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured).toContain("middle turn")
        expect(captured).toContain("later question")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "unfiltered raw history counts the invalid-tail pair as previousSummary, which is why runLoop passes the projection",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary next", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const built = yield* buildInvalidTailHistory()
        const session = built.session

        const raw = yield* ssn.messages({ sessionID: session.id })
        expect(raw.some((msg) => msg.info.id === built.newer.id)).toBe(true)

        const parent = raw.at(-1)?.info.id
        expect(parent).toBe(built.marker.id)
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: raw,
          sessionID: session.id,
          auto: false,
        })

        const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
        expect(prior).toContain("summary two")
        expect(prior).not.toContain("summary one")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )
})

describe("session.compaction legacy invalid-tail previousSummary selection", () => {
  function buildLegacyInvalidTailHistory(options?: { previousPair?: boolean }) {
    const withPrevious = options?.previousPair ?? true
    return SessionNs.Service.use((ssn) =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const head = yield* createUserMessage(session.id, "older context")
        const first = withPrevious ? yield* createCompactionRequest(session.id) : undefined
        const firstSummary = first
          ? yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
          : undefined
        yield* createUserMessage(session.id, "middle turn")
        const newer = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
        })
        const newerSummary = yield* createSummaryAssistantMessage(session.id, newer.id, test.directory, "summary two")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: newer.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
          tail_start_id: newer.id,
        })
        yield* createUserMessage(session.id, "later question")
        const marker = yield* createCompactionRequest(session.id)
        return { session, head, first, firstSummary, newer, newerSummary, marker }
      }),
    )
  }

  itCompaction.instance(
    "a completed legacy invalid-tail pair does not become the next compaction previousSummary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary next", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const built = yield* buildLegacyInvalidTailHistory()
        const session = built.session
        const first = built.first
        const firstSummary = built.firstSummary
        if (first === undefined || firstSummary === undefined) throw new Error("expected previous pair")

        const rawBefore = JSON.stringify(yield* ssn.messages({ sessionID: session.id }))
        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(JSON.stringify(yield* ssn.messages({ sessionID: session.id }))).toBe(rawBefore)

        const parent = msgs.at(-1)?.info.id
        expect(parent).toBe(built.marker.id)
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
        expect(prior).toContain("summary one")
        expect(prior).not.toContain("summary two")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(msgs.map((msg) => msg.info.id)).toContain(first.id)
        expect(msgs.map((msg) => msg.info.id)).toContain(firstSummary.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.head.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newer.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newerSummary.id)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "an invalid-tail legacy candidate with no previous applicable pair contributes no previousSummary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary next", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const built = yield* buildLegacyInvalidTailHistory({ previousPair: false })
        const session = built.session

        const rawBefore = JSON.stringify(yield* ssn.messages({ sessionID: session.id }))
        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(JSON.stringify(yield* ssn.messages({ sessionID: session.id }))).toBe(rawBefore)

        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newer.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(built.newerSummary.id)
        expect(msgs.map((msg) => msg.info.id)).toContain(built.head.id)

        const parent = msgs.at(-1)?.info.id
        expect(parent).toBe(built.marker.id)
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).not.toContain("<prior-summary>")
        expect(captured).not.toContain("summary two")
        expect(captured).toContain("middle turn")
        expect(captured).toContain("later question")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )
})

describe("session.compaction hidden synthetic-tail previousSummary selection", () => {
  itCompaction.instance(
    "a legacy pair anchored on a hidden queued synthetic user does not become the next previousSummary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary next", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const head = yield* createUserMessage(session.id, "older context")
        const first = yield* createCompactionRequest(session.id)
        const firstSummary = yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "summary one")
        yield* createUserMessage(session.id, "middle turn")
        const queued = yield* createCompactionRequest(session.id, {
          origin: "compaction",
          publication: { state: "queued" },
        })
        const newer = yield* createCompactionRequest(session.id, { tailStartID: queued.id })
        const newerSummary = yield* createSummaryAssistantMessage(session.id, newer.id, test.directory, "summary two")
        yield* createUserMessage(session.id, "later question")
        const marker = yield* createCompactionRequest(session.id)

        const rawBefore = JSON.stringify(yield* ssn.messages({ sessionID: session.id }))
        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(JSON.stringify(yield* ssn.messages({ sessionID: session.id }))).toBe(rawBefore)

        expect(msgs.map((msg) => msg.info.id)).not.toContain(queued.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(newer.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(newerSummary.id)
        expect(msgs.map((msg) => msg.info.id)).not.toContain(head.id)
        expect(msgs.map((msg) => msg.info.id)).toContain(first.id)
        expect(msgs.map((msg) => msg.info.id)).toContain(firstSummary.id)

        const parent = msgs.at(-1)?.info.id
        expect(parent).toBe(marker.id)
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const prior = captured.match(/<prior-summary>([\s\S]*?)<\/prior-summary>/)?.[1] ?? ""
        expect(prior).toContain("summary one")
        expect(prior).not.toContain("summary two")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured).toContain("middle turn")
        expect(captured).toContain("later question")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )
})

describe("session.compaction writer lifecycle (T024-T029)", () => {
  type LoggedEvent = { seq: number; type: string; data: Record<string, unknown> }

  const compactionEventLog = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows as LoggedEvent[]
    })

  const messageInfo = (event: LoggedEvent) =>
    event.data as { info?: { id?: string; summary?: boolean; role?: string } }
  const partPayload = (event: LoggedEvent) =>
    event.data as {
      part?: {
        id?: string
        messageID?: string
        publication?: { state?: string; summaryID?: string }
        tail_start_id?: string
      }
    }
  // Durable event rows store versioned type strings (`${type}.${version}`).
  const isMessageUpdated = (event: LoggedEvent) =>
    event.type.startsWith(`${SessionV1.Event.MessageUpdated.type}.`)
  const isPartUpdated = (event: LoggedEvent) =>
    event.type.startsWith(`${SessionV1.Event.PartUpdated.type}.`)

  const summaryMessages = (messages: SessionV1.WithParts[]) =>
    messages.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true)

  const persistSummary = (
    ssn: SessionNs.Interface,
    message: SessionV1.Assistant,
    text: string,
    extra: { finish?: string; error?: SessionV1.Assistant["error"] } = {},
  ) =>
    Effect.gen(function* () {
      const stored: SessionV1.Assistant = {
        ...message,
        finish: extra.finish ?? "stop",
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        time: { ...message.time, completed: Date.now() },
      }
      yield* ssn.updateMessage(stored)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text,
      })
    })

  function stubProcessor(input: {
    process: (
      ssn: SessionNs.Interface,
      message: SessionV1.Assistant,
    ) => Effect.Effect<"continue" | "compact" | "stop", never, never>
  }) {
    return Layer.effect(
      SessionProcessorModule.SessionProcessor.Service,
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        return SessionProcessorModule.SessionProcessor.Service.of({
          create: Effect.fn("TestSessionProcessor.create")((options) => {
            const msg = options.assistantMessage
            return Effect.succeed({
              get message() {
                return msg
              },
              updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
              completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
              markToolExecutionStarted: Effect.fn("TestSessionProcessor.markToolExecutionStarted")(() => Effect.void),
              finalizeFailure: Effect.fn("TestSessionProcessor.finalizeFailure")(() => Effect.void),
              process: Effect.fn("TestSessionProcessor.process")(() => input.process(ssn, msg)),
            } satisfies SessionProcessorModule.SessionProcessor.Handle)
          }),
        })
      }),
    )
  }

  itCompaction.instance("T024: create persists synthetic origin and queued publication in order", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "context")
      yield* SessionCompaction.use.create({ sessionID: session.id, agent: "build", model: ref, auto: false })

      const messages = yield* ssn.messages({ sessionID: session.id })
      const owner = messages.at(-1)!
      expect(owner.info.role).toBe("user")
      if (owner.info.role === "user") expect(owner.info.origin).toBe("compaction")
      const part = owner.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
      expect(part?.publication).toEqual({ state: "queued" })
      // No summary work may exist before a queued durable request is established.
      expect(summaryMessages(messages)).toHaveLength(0)

      const log = yield* compactionEventLog(session.id)
      const uEvent = log.find(
        (event) =>
          isMessageUpdated(event) && messageInfo(event).info?.id === owner.info.id,
      )
      const pEvent = log.find(
        (event) => isPartUpdated(event) && partPayload(event).part?.id === part?.id,
      )
      expect(uEvent).toBeDefined()
      expect(pEvent).toBeDefined()
      expect(uEvent!.seq).toBeLessThan(pEvent!.seq)
    }).pipe(withCompaction()),
  )

  itCompaction.instance(
    "T025: preparing is persisted before the summary and the publication event follows durable success",
    () => {
      const stub = llm()
      stub.push(reply("ordered durable summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "context")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const ownerID = msgs.at(-1)!.info.id

        const result = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("continue")

        const part = yield* readOwnedCompactionPart(session.id, ownerID)
        const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
        expect(summaries).toHaveLength(1)
        expect(part?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })

        const log = yield* compactionEventLog(session.id)
        const preparing = log.find(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.id === part?.id &&
            partPayload(event).part?.publication?.state === "preparing",
        )
        const summaryCreated = log.find(
          (event) => isMessageUpdated(event) && messageInfo(event).info?.summary === true,
        )
        const published = log.filter(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.publication?.state === "published",
        )
        expect(preparing).toBeDefined()
        expect(summaryCreated).toBeDefined()
        expect(published).toHaveLength(1)
        expect(preparing!.seq).toBeLessThan(summaryCreated!.seq)
        expect(published[0]!.seq).toBeGreaterThan(summaryCreated!.seq)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance("T025: preparing, published and abandoned requests are never executed", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "context")
      const preparing = yield* createCompactionRequest(session.id, {
        origin: "compaction",
        publication: { state: "preparing" },
      })
      const abandoned = yield* createCompactionRequest(session.id, {
        origin: "compaction",
        publication: { state: "abandoned" },
      })
      const published = yield* createPublishedCompaction(session.id, "/tmp", "already published")
      const malformed = yield* createCompactionRequest(session.id, { origin: "compaction" })
      const recovery = yield* createCompactionRequest(session.id, {
        origin: "recovery-preparation",
        publication: { state: "queued" },
      })
      const unknown = yield* createCompactionRequest(session.id, {
        origin: "future-origin",
        publication: { state: "queued" },
      })

      for (const owner of [preparing, abandoned, published.user, malformed, recovery, unknown]) {
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: owner.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")
      }

      // No summary was generated for any refused request.
      expect(summaryMessages(yield* ssn.messages({ sessionID: session.id }))).toHaveLength(1)
      const parts = (yield* ssn.messages({ sessionID: session.id })).flatMap((msg) => msg.parts)
      const preparingPart = parts.find(
        (item): item is SessionV1.CompactionPart =>
          item.type === "compaction" && item.messageID === preparing.id,
      )
      expect(preparingPart?.publication).toEqual({ state: "preparing" })
      const abandonedPart = parts.find(
        (item): item is SessionV1.CompactionPart =>
          item.type === "compaction" && item.messageID === abandoned.id,
      )
      expect(abandonedPart?.publication).toEqual({ state: "abandoned" })
      const malformedPart = parts.find(
        (item): item is SessionV1.CompactionPart =>
          item.type === "compaction" && item.messageID === malformed.id,
      )
      expect(malformedPart?.publication).toBeUndefined()
    }).pipe(withCompaction()),
  )

  itCompaction.instance(
    "T025: an eligible legacy pending pair is upgraded to preparing before its new summary",
    () => {
      const stub = llm()
      stub.push(reply("legacy upgraded summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        const marker = yield* createCompactionRequest(session.id)
        const partBefore = (yield* readOwnedCompactionPart(session.id, marker.id))!
        expect(partBefore.publication).toBeUndefined()
        // Historical scheduling still discovers the strict legacy pair.
        const pendingBefore = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
        expect(
          pendingBefore.some((task) => task.type === "compaction" && task.messageID === marker.id),
        ).toBe(true)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: marker.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("continue")

        const part = yield* readOwnedCompactionPart(session.id, marker.id)
        const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
        expect(part?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })

        const log = yield* compactionEventLog(session.id)
        const preparing = log.find(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.id === part?.id &&
            partPayload(event).part?.publication?.state === "preparing",
        )
        const summaryCreated = log.find(
          (event) => isMessageUpdated(event) && messageInfo(event).info?.summary === true,
        )
        expect(preparing).toBeDefined()
        expect(summaryCreated).toBeDefined()
        expect(preparing!.seq).toBeLessThan(summaryCreated!.seq)

        // Once upgraded and published the pair is new-format and unschedulable.
        const pendingAfter = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
        expect(
          pendingAfter.some((task) => task.type === "compaction" && task.messageID === marker.id),
        ).toBe(false)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance("T025: a completed successful legacy pair is neither upgraded nor re-executed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createCompactionRequest(session.id)
      yield* createSummaryAssistantMessage(session.id, first.id, test.directory, "already summarized")
      const before = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: first.id,
        messages: before,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const after = yield* ssn.messages({ sessionID: session.id })
      expect(summaryMessages(after)).toHaveLength(1)
      const part = yield* readOwnedCompactionPart(session.id, first.id)
      // Strict legacy identity is preserved; no migration to new-format state.
      expect(part?.publication).toBeUndefined()
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    }).pipe(withCompaction()),
  )

  itCompaction.instance("T026: a compact result never publishes and abandons the ordinary request", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
      expect(summaries).toHaveLength(1)
      if (summaries[0]?.info.role === "assistant") expect(summaries[0].info.finish).toBe("error")
      const log = yield* compactionEventLog(session.id)
      expect(
        log.filter(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.publication?.state === "published",
        ),
      ).toEqual([])
    }).pipe(withCompaction({ result: "compact" })),
  )

  itCompaction.instance("T026: a stopped processor result never publishes and abandons the request", () => {
    const stopped = stubProcessor({
      process: () => Effect.succeed("stop" as const),
    })
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      const log = yield* compactionEventLog(session.id)
      expect(
        log.filter(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.publication?.state === "published",
        ),
      ).toEqual([])
    }).pipe(withCompaction({ processor: stopped }))
  })

  itCompaction.instance("T026: a capacity failure without fallback never publishes and abandons", () => {
    const tiny = createModel({ id: "compact-tiny", context: 1_000, output: 100 })
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "x".repeat(16_000))
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
      expect(summaries).toHaveLength(1)
      if (summaries[0]?.info.role === "assistant") {
        expect(summaries[0].info.finish).toBe("error")
        expect(JSON.stringify(summaries[0].info.error)).toContain("effective input budget")
      }
    }).pipe(
      withCompaction({
        provider: providerFor(tiny),
        agent: compactionAgent(tiny),
      }),
    )
  })

  itCompaction.instance(
    "T026: interruption before summary setup leaves preparing non-authoritative and unschedulable",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          yield* createUserMessage(session.id, "hello")
          yield* createSummaryCompaction(session.id)
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const ownerID = msgs.at(-1)!.info.id
          const fiber = yield* SessionCompaction.use
            .process({ parentID: ownerID, messages: msgs, sessionID: session.id, auto: false })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          const all = yield* ssn.messages({ sessionID: session.id })
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
          const part = yield* readOwnedCompactionPart(session.id, ownerID)
          expect(part?.publication).toEqual({ state: "preparing" })
          // Preparing is neither model context nor runnable pending work.
          const filtered = yield* MessageV2.filterCompactedEffect(session.id)
          expect(filtered.some((msg) => msg.info.id === ownerID)).toBe(false)
          const tasks = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
          expect(tasks.some((task) => task.type === "compaction" && task.messageID === ownerID)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "T026: a completed but unpublished candidate stays inactive after reopen",
    () => {
      const stub = llm()
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "prior context")
        // Crash between durable summary completion and publication.
        const u = yield* createCompactionRequest(session.id, {
          origin: "compaction",
          publication: { state: "preparing" },
        })
        const s = yield* createSummaryAssistantMessage(session.id, u.id, test.directory, "completed unpublished")
        const rawBefore = JSON.stringify(yield* MessageV2.stream(session.id))

        const filtered = yield* MessageV2.filterCompactedEffect(session.id)
        expect(filtered.some((msg) => msg.info.id === u.id || msg.info.id === s.id)).toBe(false)
        const tasks = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
        expect(tasks.some((task) => task.type === "compaction" && task.messageID === u.id)).toBe(false)

        // Re-execution refuses to resummarize or publish the completed S.
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: u.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")
        expect(stub.inputs).toHaveLength(0)
        expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBefore)
        const part = yield* readOwnedCompactionPart(session.id, u.id)
        expect(part?.publication).toEqual({ state: "preparing" })
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance("T027: in-memory success without durable persisted content never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      // The prior conversation stays the model-visible projection.
      const filtered = yield* MessageV2.filterCompactedEffect(session.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
      expect(filtered.some((msg) => msg.parts.some((p) => p.type === "text" && p.text === "hello"))).toBe(true)
      // Raw history is physically preserved.
      expect(JSON.stringify(yield* MessageV2.stream(session.id))).toContain("hello")
    }).pipe(withCompaction({ result: "continue" })),
  )

  itCompaction.instance("T027: a missing durable summary never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      expect(summaryMessages(yield* ssn.messages({ sessionID: session.id }))).toHaveLength(0)
    }    ).pipe(
      withCompaction({
        processor: stubProcessor({
          process: (ssn, message) =>
            Effect.gen(function* () {
              yield* ssn.removeMessage({ sessionID: message.sessionID, messageID: message.id })
              return "continue" as const
            }),
        }),
      }),
    ),
  )

  itCompaction.instance("T027: an error-finalized summary never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
    }).pipe(
      withCompaction({
        processor: stubProcessor({
          process: (ssn, message) =>
            persistSummary(ssn, message, "failed durable summary", {
              finish: "error",
              error: new SessionV1.AbortedError({ message: "cancelled" }).toObject(),
            }).pipe(Effect.as("continue" as const)),
        }),
      }),
    ),
  )

  itCompaction.instance("T027: a summary with whitespace-only durable text never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
    }).pipe(
      withCompaction({
        processor: stubProcessor({
          process: (ssn, message) => persistSummary(ssn, message, "   \n\t ").pipe(Effect.as("continue" as const)),
        }),
      }),
    ),
  )

  itCompaction.instance("T027: a successful summary with the wrong parent never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "other user")
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
    }).pipe(
      withCompaction({
        processor: stubProcessor({
          process: (ssn, message) =>
            Effect.gen(function* () {
              const other = yield* ssn
                .findMessage(message.sessionID, (msg) => msg.info.role === "user" && msg.info.id !== message.parentID)
                .pipe(Effect.orDie)
              if (other._tag !== "Some") return "stop" as const
              yield* persistSummary(ssn, { ...message, parentID: other.value.info.id }, "reparented durable summary")
              return "continue" as const
            }),
        }),
      }),
    ),
  )

  itCompaction.instance("T027: a summary persisted in another session never publishes", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "hello")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      expect(summaryMessages(yield* ssn.messages({ sessionID: session.id }))).toHaveLength(0)
    }).pipe(
      withCompaction({
        processor: stubProcessor({
          process: (ssn, message) =>
            Effect.gen(function* () {
              yield* ssn.removeMessage({ sessionID: message.sessionID, messageID: message.id })
              const other = yield* ssn.create({})
              yield* ssn.updateMessage({
                ...message,
                id: MessageID.ascending(),
                sessionID: other.id,
                finish: "stop",
                time: { ...message.time, completed: Date.now() },
              })
              return "continue" as const
            }),
        }),
      }),
    ),
  )

  itCompaction.instance(
    "T027/T028: a successful full summary publishes exactly once without a tail marker",
    () => {
      const stub = llm()
      stub.push(reply("full durable summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "second")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const ownerID = msgs.at(-1)!.info.id

        const result = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("continue")

        const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
        expect(summaries).toHaveLength(1)
        const part = yield* readOwnedCompactionPart(session.id, ownerID)
        expect(part?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })
        expect(part?.tail_start_id).toBeUndefined()

        const log = yield* compactionEventLog(session.id)
        const published = log.filter(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.publication?.state === "published",
        )
        expect(published).toHaveLength(1)
        expect(partPayload(published[0]!).part?.tail_start_id).toBeUndefined()
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 0 }) }))
    },
  )

  itCompaction.instance(
    "T028: the single publication event carries binding and tail atomically and precedes Compacted",
    () => {
      const stub = llm()
      stub.push(reply("tailed durable summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        const keep = yield* createUserMessage(session.id, "second")
        yield* createUserMessage(session.id, "third")
        yield* createSummaryCompaction(session.id)
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const ownerID = msgs.at(-1)!.info.id
        const observed: string[] = []
        const off = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === SessionCompaction.Event.Compacted.type) {
              const data = event.data as typeof SessionCompaction.Event.Compacted.data.Type
              if (data.sessionID === session.id) observed.push("compacted")
              return
            }
            if (event.type !== SessionV1.Event.PartUpdated.type) return
            const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
            if (data.part.type !== "compaction") return
            if (data.part.messageID !== ownerID) return
            if (data.part.publication?.state === "published") observed.push("published")
          }),
        )
        yield* Effect.addFinalizer(() => off)

        yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
        const part = yield* readOwnedCompactionPart(session.id, ownerID)
        expect(part?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })
        expect(part?.tail_start_id).toBe(keep.id)

        const log = yield* compactionEventLog(session.id)
        const published = log.filter(
          (event) =>
            isPartUpdated(event) &&
            partPayload(event).part?.publication?.state === "published",
        )
        expect(published).toHaveLength(1)
        expect(partPayload(published[0]!).part?.publication?.summaryID).toBe(summaries[0]!.info.id as unknown as string)
        expect(partPayload(published[0]!).part?.tail_start_id).toBe(keep.id as unknown as string)
        // Compacted is a live event; it is observed only after the durable
        // publication notification.
        expect(observed).toEqual(["published", "compacted"])
      }).pipe(
        withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }),
      )
    },
  )

  itCompaction.instance("T028: an identical publication decision stays idempotent and schedules nothing", () =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "context")
      yield* createPublishedCompaction(session.id, "/tmp", "already published summary", { origin: "compaction" })
      const messages = yield* ssn.messages({ sessionID: session.id })
      const owner = messages.find((msg) => msg.info.role === "user" && msg.parts.some((p) => p.type === "compaction"))!
      const part = owner.parts.find((p): p is SessionV1.CompactionPart => p.type === "compaction")!
      const before = JSON.stringify(yield* MessageV2.stream(session.id))

      // Exact identical replay of the committed publication.
      yield* ssn.updatePart({ ...part })

      expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(before)
      const tasks = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
      expect(tasks).toEqual([])
    }).pipe(withCompaction()),
  )

  itCompaction.instance("T028: a rejected final publication attempt leaves the prior projection intact", () => {
    const sabotaged = stubProcessor({
      process: (ssn, message) =>
        Effect.gen(function* () {
          yield* persistSummary(ssn, message, "durable summary before sabotage")
          // Simulate a competing durable write that makes the final
          // publication invalid inside the projector transaction.
          const owner = yield* ssn
            .findMessage(message.sessionID, (msg) => msg.info.id === message.parentID)
            .pipe(Effect.orDie)
          if (owner._tag === "Some") {
            const part = owner.value.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
            if (part) {
              yield* ssn.updatePart({ ...part, publication: { state: "abandoned" } })
            }
          }
          return "continue" as const
        }),
    })
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "prior context")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id
      const rawBefore = JSON.stringify(
        (yield* MessageV2.stream(session.id)).filter((msg) => msg.info.id !== ownerID),
      )

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(result).toBe("stop")
      const part = yield* readOwnedCompactionPart(session.id, ownerID)
      expect(part?.publication).toEqual({ state: "abandoned" })
      const filtered = yield* MessageV2.filterCompactedEffect(session.id)
      expect(filtered.some((msg) => msg.info.id === ownerID)).toBe(false)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
      // Raw history of prior turns is physically preserved.
      expect(
        JSON.stringify(
          (yield* MessageV2.stream(session.id)).filter((msg) => msg.info.id !== ownerID && msg.info.role !== "assistant"),
        ),
      ).toBe(
        JSON.stringify(
          (JSON.parse(rawBefore) as SessionV1.WithParts[]).filter((msg) => msg.info.role !== "assistant"),
        ),
      )
    }).pipe(withCompaction({ processor: sabotaged }))
  })

  itCompaction.instance("T029: reentry after publication never re-executes, replays, or reschedules", () => {
    const stub = llm()
    stub.push(reply("single durable summary"))
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const original = yield* createUserMessage(session.id, "original request")
      yield* createSummaryCompaction(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const ownerID = msgs.at(-1)!.info.id

      const result = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })
      expect(result).toBe("continue")
      const afterFirst = yield* ssn.messages({ sessionID: session.id })

      // Restart/reentry immediately after N6: the published task is refused.
      const reopened = yield* ssn.messages({ sessionID: session.id })
      const second = yield* SessionCompaction.use.process({
        parentID: ownerID,
        messages: reopened,
        sessionID: session.id,
        auto: false,
      })
      expect(second).toBe("stop")

      const afterSecond = yield* ssn.messages({ sessionID: session.id })
      expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst))
      expect(stub.inputs).toHaveLength(1)
      // No duplicate pending work and no replay of the original request.
      const tasks = MessageV2.pendingWork(yield* MessageV2.stream(session.id)).tasks
      expect(tasks).toEqual([])
      expect(afterSecond.filter((msg) => msg.info.role === "user" && msg.info.id === original.id)).toHaveLength(1)
      expect(summaryMessages(afterSecond)).toHaveLength(1)
      // The published pair is the model-visible projection.
      const filtered = yield* MessageV2.filterCompactedEffect(session.id)
      expect(filtered.some((msg) => msg.info.id === ownerID)).toBe(true)
      expect(summaryMessages(filtered)).toHaveLength(1)
    }).pipe(withCompaction({ llm: stub.llmLayer }))
  })
})

describe("session.compaction crash windows (T034-T035)", () => {
  type LoggedEvent = { seq: number; type: string; data: Record<string, unknown> }

  const compactionEventLog = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows as LoggedEvent[]
    })

  const partPayload = (event: LoggedEvent) =>
    event.data as {
      part?: { id?: string; messageID?: string; publication?: { state?: string; summaryID?: string } }
    }
  const isPartUpdated = (event: LoggedEvent) =>
    event.type.startsWith(`${SessionV1.Event.PartUpdated.type}.`)

  const summaryMessages = (messages: SessionV1.WithParts[]) =>
    messages.filter((msg) => msg.info.role === "assistant" && msg.info.summary === true)

  const persistSummary = (
    ssn: SessionNs.Interface,
    message: SessionV1.Assistant,
    text: string,
    extra: { finish?: string; error?: SessionV1.Assistant["error"] } = {},
  ) =>
    Effect.gen(function* () {
      const stored: SessionV1.Assistant = {
        ...message,
        finish: extra.finish ?? "stop",
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        time: { ...message.time, completed: Date.now() },
      }
      yield* ssn.updateMessage(stored)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text,
      })
    })

  function stubProcessor(input: {
    process: (
      ssn: SessionNs.Interface,
      message: SessionV1.Assistant,
    ) => Effect.Effect<"continue" | "compact" | "stop", never, never>
  }) {
    return Layer.effect(
      SessionProcessorModule.SessionProcessor.Service,
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        return SessionProcessorModule.SessionProcessor.Service.of({
          create: Effect.fn("TestSessionProcessor.create")((options) => {
            const msg = options.assistantMessage
            return Effect.succeed({
              get message() {
                return msg
              },
              updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
              completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
              markToolExecutionStarted: Effect.fn("TestSessionProcessor.markToolExecutionStarted")(() => Effect.void),
              finalizeFailure: Effect.fn("TestSessionProcessor.finalizeFailure")(() => Effect.void),
              process: Effect.fn("TestSessionProcessor.process")(() => input.process(ssn, msg)),
            } satisfies SessionProcessorModule.SessionProcessor.Handle)
          }),
        })
      }),
    )
  }

  // Mirrors SessionPrompt.lastAssistant's response-selection loop over the
  // newest-first raw stream: summaries count only when model-visible.
  const currentResponse = (raw: SessionV1.WithParts[], visible: ReadonlySet<string>) => {
    for (const msg of raw) {
      if (msg.info.role === "user") continue
      if (msg.info.summary === true && !visible.has(msg.info.id)) continue
      return msg
    }
    return undefined
  }

  // The full durable-boundary battery: raw persisted state, model-visible
  // IDs and content, independent pendingWork(raw), current-response
  // selection, and a reopen (fresh durable re-read) that must yield the same
  // consumer state.
  const assertBoundaryState = Effect.fn("test.assertBoundaryState")(function* (input: {
    sessionID: SessionID
    ownerID: MessageID
    taskOwners: MessageID[]
    candidateVisible: boolean
    priorSummaryVisible: boolean
    currentResponseID?: MessageID
  }) {
    const raw = yield* MessageV2.stream(input.sessionID)
    const filtered = MessageV2.filterCompacted(raw)
    const visible = new Set(filtered.map((msg) => msg.info.id))
    expect(visible.has(input.ownerID)).toBe(input.candidateVisible)
    const texts = filtered
      .flatMap((msg) => msg.parts)
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    if (input.priorSummaryVisible) expect(texts).toContain("prior summary")
    const tasks = MessageV2.pendingWork(raw).tasks.filter((task) => task.type === "compaction")
    expect(tasks.map((task) => task.messageID)).toEqual(input.taskOwners)
    const response = currentResponse(raw, visible)
    if (input.currentResponseID !== undefined) expect(response?.info.id).toBe(input.currentResponseID)

    // Reopen: a fresh durable read reconstructs the same consumer state.
    const rawAgain = yield* MessageV2.stream(input.sessionID)
    expect(JSON.stringify(rawAgain)).toBe(JSON.stringify(raw))
    const filteredAgain = MessageV2.filterCompacted(rawAgain)
    expect(filteredAgain.map((msg) => msg.info.id)).toEqual(filtered.map((msg) => msg.info.id))
    expect(
      MessageV2.pendingWork(rawAgain)
        .tasks.filter((task) => task.type === "compaction")
        .map((task) => task.messageID),
    ).toEqual(tasks.map((task) => task.messageID))
    return raw
  })

  // Prior valid published full summary (U0/P0/S0) plus genuine head X/B and
  // a later genuine user Y — the surviving projection for every boundary.
  const seedPriorPublication = Effect.fn("test.seedPriorPublication")(function* (sessionID: SessionID) {
    const test = yield* TestInstance
    const x = yield* createUserMessage(sessionID, "prior question")
    const b = yield* createAssistantMessage(sessionID, x.id, test.directory)
    const prior = yield* createPublishedCompaction(sessionID, test.directory, "prior summary", {
      origin: "compaction",
    })
    const y = yield* createUserMessage(sessionID, "later genuine question")
    return { x, b, prior, y }
  })

  const publishedEventsFor = (log: LoggedEvent[], ownerID: MessageID) =>
    log.filter(
      (event) =>
        isPartUpdated(event) &&
        partPayload(event).part?.messageID === ownerID &&
        partPayload(event).part?.publication?.state === "published",
    )

  itCompaction.instance(
    "T034 C0: crash before new-format identity leaves no new summary or published pair",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)

        // Boundary C0: the process crashed before N0, so no new-format
        // identity exists. No new successful summary or published pair may
        // appear, and no synthetic U exists beyond the prior published one.
        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID: seeded.prior.user.id,
          taskOwners: [],
          candidateVisible: true,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })
        expect(summaryMessages(raw)).toHaveLength(1)
        const publishedParts = raw
          .flatMap((msg) => msg.parts)
          .filter(
            (part): part is SessionV1.CompactionPart =>
              part.type === "compaction" && part.publication?.state === "published",
          )
        expect(publishedParts).toHaveLength(1)
        expect(publishedParts[0]?.messageID).toBe(seeded.prior.user.id)
        // The later genuine turn remains visible alongside the prior pair.
        expect(raw.some((msg) => msg.info.id === seeded.y.id)).toBe(true)
        const filtered = MessageV2.filterCompacted(raw)
        expect(filtered.some((msg) => msg.info.id === seeded.y.id)).toBe(true)
      }).pipe(withCompaction()),
  )

  itCompaction.instance(
    "T034 C1: crash after durable synthetic U but before P leaves a non-runnable orphan",
    () => {
      const stub = llm()
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)
        // Boundary C1: N0 committed, N1 did not. The tagged orphan U is
        // persisted with no compaction part.
        const orphan = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
          origin: "compaction",
        })

        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID: orphan.id,
          taskOwners: [],
          candidateVisible: false,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })
        const orphanMsg = raw.find((msg) => msg.info.id === orphan.id)
        expect(orphanMsg).toBeDefined()
        expect(orphanMsg?.parts).toHaveLength(0)
        // No accidental legacy interpretation: there is no compaction part at all.
        expect(orphanMsg?.parts.some((part) => part.type === "compaction")).toBe(false)
        expect(summaryMessages(raw).filter((msg) => (msg.info as SessionV1.Assistant).parentID === orphan.id)).toHaveLength(0)

        // Reentry cannot initiate generation from the orphan.
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: orphan.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")
        expect(stub.inputs).toHaveLength(0)
        expect(summaryMessages(yield* ssn.messages({ sessionID: session.id }))).toHaveLength(1)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "T034 C2: crash after queued P leaves runnable ordinary work hidden from model history",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)
        // Boundary C2: N1 committed. The queued ordinary request is durable.
        yield* createSummaryCompaction(session.id)
        const owner = (yield* ssn.messages({ sessionID: session.id })).at(-1)!
        expect(owner.info.role).toBe("user")
        const ownerID = owner.info.id
        if (owner.info.role === "user") expect(owner.info.origin).toBe("compaction")

        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID,
          taskOwners: [ownerID],
          candidateVisible: false,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })
        const part = raw
          .find((msg) => msg.info.id === ownerID)
          ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
        expect(part?.publication).toEqual({ state: "queued" })
        // Prior publication survives; nothing was summarized yet.
        expect(summaryMessages(raw)).toHaveLength(1)
        const log = yield* compactionEventLog(session.id)
        expect(publishedEventsFor(log, ownerID)).toEqual([])
        expect(publishedEventsFor(log, seeded.prior.user.id)).toHaveLength(1)
      }).pipe(withCompaction()),
  )

  itCompaction.instance(
    "T034 C3: interruption after preparing and before S leaves preparing non-runnable and unregenerated",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const seeded = yield* seedPriorPublication(session.id)
          yield* createSummaryCompaction(session.id)
          const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

          const fiber = yield* SessionCompaction.use
            .process({ parentID: ownerID, messages: yield* ssn.messages({ sessionID: session.id }), sessionID: session.id, auto: false })
            .pipe(Effect.forkChild)
          // Deterministic interruption at the compacting hook: N2 committed,
          // N3 has not.
          yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)

          const part = yield* readOwnedCompactionPart(session.id, ownerID)
          expect(part?.publication).toEqual({ state: "preparing" })
          const raw = yield* assertBoundaryState({
            sessionID: session.id,
            ownerID,
            taskOwners: [],
            candidateVisible: false,
            priorSummaryVisible: true,
            currentResponseID: seeded.prior.summary.id,
          })
          expect(summaryMessages(raw).filter((msg) => (msg.info as SessionV1.Assistant).parentID === ownerID)).toHaveLength(0)

          // Reopen/reentry does not automatically regenerate S.
          const reopened = yield* ssn.messages({ sessionID: session.id })
          const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
          const second = yield* SessionCompaction.use.process({
            parentID: ownerID,
            messages: reopened,
            sessionID: session.id,
            auto: false,
          })
          expect(second).toBe("stop")
          expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
          expect(
            summaryMessages(yield* ssn.messages({ sessionID: session.id })).filter(
              (msg) => (msg.info as SessionV1.Assistant).parentID === ownerID,
            ),
          ).toHaveLength(0)
          expect((yield* readOwnedCompactionPart(session.id, ownerID))?.publication).toEqual({ state: "preparing" })
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "T034 C4: interruption during S streaming leaves a partial summary non-authoritative",
    () =>
      Effect.gen(function* () {
        const streamed = yield* Deferred.make<void>()
        const hang = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const seeded = yield* seedPriorPublication(session.id)
          yield* createSummaryCompaction(session.id)
          const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

          const fiber = yield* SessionCompaction.use
            .process({
              parentID: ownerID,
              messages: yield* ssn.messages({ sessionID: session.id }),
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(streamed).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)

          const raw = yield* assertBoundaryState({
            sessionID: session.id,
            ownerID,
            taskOwners: [],
            candidateVisible: false,
            priorSummaryVisible: true,
            currentResponseID: seeded.prior.summary.id,
          })
          const part = raw
            .find((msg) => msg.info.id === ownerID)
            ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
          expect(part?.publication).toEqual({ state: "preparing" })
          // Partial streaming S exists durably but is not finalized.
          const partial = summaryMessages(raw).filter((msg) => (msg.info as SessionV1.Assistant).parentID === ownerID)
          expect(partial).toHaveLength(1)
          expect((partial[0]?.info as SessionV1.Assistant | undefined)?.finish).toBeUndefined()
          expect(partial[0]?.parts.some((p) => p.type === "text" && p.text === "partial summa")).toBe(true)
          // The partial S never becomes authoritative or the current response.
          const visible = new Set(MessageV2.filterCompacted(raw).map((msg) => msg.info.id))
          expect(visible.has(partial[0]!.info.id)).toBe(false)
          expect(currentResponse(raw, visible)?.info.id).toBe(seeded.prior.summary.id)
          // No publication ever occurred for this owner.
          const log = yield* compactionEventLog(session.id)
          expect(publishedEventsFor(log, ownerID)).toEqual([])

          // Reopen: reentry refuses; nothing is regenerated or published.
          const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
          const second = yield* SessionCompaction.use.process({
            parentID: ownerID,
            messages: yield* ssn.messages({ sessionID: session.id }),
            sessionID: session.id,
            auto: false,
          })
          expect(second).toBe("stop")
          expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
        }).pipe(
          withCompaction({
            processor: stubProcessor({
              process: (ssn, message) =>
                Effect.gen(function* () {
                  yield* ssn.updatePart({
                    id: PartID.ascending(),
                    messageID: message.id,
                    sessionID: message.sessionID,
                    type: "text",
                    text: "partial summa",
                  })
                  Deferred.doneUnsafe(streamed, Effect.void)
                  yield* Deferred.await(hang)
                  return "continue" as const
                }),
            }),
          }),
        )
      }),
    { git: true },
  )

  itCompaction.instance(
    "T035 C5: successful readable S with preparing P stays unpublished and inactive after reopen",
    () => {
      const stub = llm()
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)
        // Boundary C5: N5 committed — S is durably successful, finished and
        // readable — while P is still preparing, with NO failure evidence.
        const u = yield* createCompactionRequest(session.id, {
          origin: "compaction",
          publication: { state: "preparing" },
        })
        const s = yield* createSummaryAssistantMessage(session.id, u.id, test.directory, "successful unpublished")
        const sMsg = (yield* ssn.messages({ sessionID: session.id })).find((msg) => msg.info.id === s.id)
        if (sMsg?.info.role === "assistant") {
          expect(sMsg.info.finish).toBe("end_turn")
          expect(sMsg.info.error).toBeUndefined()
        }
        expect(sMsg?.parts.some((part) => part.type === "text" && part.text === "successful unpublished")).toBe(true)

        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID: u.id,
          taskOwners: [],
          candidateVisible: false,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })
        // Candidate remains unpublished and inactive.
        const part = raw
          .find((msg) => msg.info.id === u.id)
          ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
        expect(part?.publication).toEqual({ state: "preparing" })
        const log = yield* compactionEventLog(session.id)
        expect(publishedEventsFor(log, u.id)).toEqual([])
        const visible = new Set(MessageV2.filterCompacted(raw).map((msg) => msg.info.id))
        expect(visible.has(s.id)).toBe(false)

        // No reconciler is implemented: reopen + reentry neither publishes
        // nor resummarizes the successful completed content.
        const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
        const second = yield* SessionCompaction.use.process({
          parentID: u.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(second).toBe("stop")
        expect(stub.inputs).toHaveLength(0)
        expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
        expect((yield* readOwnedCompactionPart(session.id, u.id))?.publication).toEqual({ state: "preparing" })
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
  )

  itCompaction.instance(
    "T035 C6: a rejected final publication leaves the event log and sequence unchanged and keeps sequence contiguous",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const database = yield* Database.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)
        const u = yield* createCompactionRequest(session.id, {
          origin: "compaction",
          publication: { state: "preparing" },
        })
        // S looks successful but its durable content is unreadable, so the
        // final publication transition must be rejected inside the durable
        // event transaction.
        const s = yield* createSummaryAssistantMessage(session.id, u.id, test.directory, "   \n\t ")
        const part = (yield* readOwnedCompactionPart(session.id, u.id))!

        const logBefore = yield* compactionEventLog(session.id)
        const seqBefore = yield* EventV2.latestSequence(database.db, session.id)

        const exit = yield* ssn
          .updatePart({
            ...part,
            publication: { state: "published", summaryID: s.id },
          } as SessionV1.CompactionPart)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)

        // Projection, EventTable and EventSequenceTable are unchanged.
        const logAfter = yield* compactionEventLog(session.id)
        const seqAfter = yield* EventV2.latestSequence(database.db, session.id)
        expect(logAfter).toEqual(logBefore)
        expect(seqAfter).toBe(seqBefore)
        const afterMsgs = yield* ssn.messages({ sessionID: session.id })
        expect(
          afterMsgs
            .find((msg) => msg.info.id === u.id)
            ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
            ?.publication,
        ).toEqual({ state: "preparing" })

        // Prior projection survives and the candidate stays inactive.
        yield* assertBoundaryState({
          sessionID: session.id,
          ownerID: u.id,
          taskOwners: [],
          candidateVisible: false,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })

        // The next legitimate event uses the expected contiguous sequence.
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
        })
        const logNext = yield* compactionEventLog(session.id)
        const seqNext = yield* EventV2.latestSequence(database.db, session.id)
        expect(logNext).toHaveLength(logBefore.length + 1)
        expect(seqNext).toBe(seqBefore + 1)
        expect(logNext.at(-1)?.seq).toBe(seqBefore + 1)
      }).pipe(withCompaction()),
  )

  itCompaction.instance(
    "T035 C7: crash after publication before autocontinue leaves the published pair valid",
    () => {
      const stub = llm()
      stub.push(reply("crash-safe summary"))
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const x = yield* createUserMessage(session.id, "original request")
          yield* createSummaryCompaction(session.id)
          const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

          const fiber = yield* SessionCompaction.use
            .process({
              parentID: ownerID,
              messages: yield* ssn.messages({ sessionID: session.id }),
              sessionID: session.id,
              auto: true,
            })
            .pipe(Effect.forkChild)
          // Deterministic interruption inside the post-publication
          // autocontinue hook: N6 committed, N7 has not.
          yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)

          const part = yield* readOwnedCompactionPart(session.id, ownerID)
          const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
          expect(summaries).toHaveLength(1)
          expect(part?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })

          // Publication remains valid even though continuation never ran.
          const raw = yield* assertBoundaryState({
            sessionID: session.id,
            ownerID,
            taskOwners: [],
            candidateVisible: true,
            priorSummaryVisible: false,
            currentResponseID: summaries[0]!.info.id,
          })
          const texts = raw
            .flatMap((msg) => msg.parts)
            .filter((p): p is SessionV1.TextPart => p.type === "text")
            .map((p) => p.text)
            .join("\n")
          expect(texts).toContain("crash-safe summary")
          // No autocontinue/replay user message was invented.
          expect(raw.filter((msg) => msg.info.role === "user")).toHaveLength(2)
          expect(raw.some((msg) => msg.info.role === "user" && msg.info.id === x.id)).toBe(true)

          // Reopen: reentry refuses; the original request is not replayed.
          const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
          const second = yield* SessionCompaction.use.process({
            parentID: ownerID,
            messages: yield* ssn.messages({ sessionID: session.id }),
            sessionID: session.id,
            auto: true,
          })
          expect(second).toBe("stop")
          expect(stub.inputs).toHaveLength(1)
          expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
          expect(
            (yield* ssn.messages({ sessionID: session.id })).filter((msg) => msg.info.role === "user"),
          ).toHaveLength(2)
        }).pipe(
          withCompaction({
            llm: stub.llmLayer,
            config: cfg({ tail_turns: 0 }),
            plugin: Layer.mock(Plugin.Service)({
              trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
                if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
                return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
                  Effect.andThen(Effect.never),
                  Effect.as(output),
                )
              },
              list: () => Effect.succeed([]),
              init: () => Effect.void,
            }),
          }),
        )
      })
    },
    { git: true },
  )

  itCompaction.instance(
    "T035 C8: interrupted failure cleanup leaves preparing that cannot publish",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const hang = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const seeded = yield* seedPriorPublication(session.id)
          yield* createSummaryCompaction(session.id)
          const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

          const fiber = yield* SessionCompaction.use
            .process({
              parentID: ownerID,
              messages: yield* ssn.messages({ sessionID: session.id }),
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)
          // Interrupt inside the failure path after the error-finalized S is
          // durable but before finalizeFailure/abandonPart cleanup runs.
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
          expect(Exit.isFailure(exit)).toBe(true)

          const raw = yield* assertBoundaryState({
            sessionID: session.id,
            ownerID,
            taskOwners: [],
            candidateVisible: false,
            priorSummaryVisible: true,
            currentResponseID: seeded.prior.summary.id,
          })
          // Cleanup never committed: the part stays preparing, not abandoned,
          // and definitely not published.
          const part = raw
            .find((msg) => msg.info.id === ownerID)
            ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
          expect(part?.publication).toEqual({ state: "preparing" })
          const failed = summaryMessages(raw).filter((msg) => (msg.info as SessionV1.Assistant).parentID === ownerID)
          expect(failed).toHaveLength(1)
          expect((failed[0]?.info as SessionV1.Assistant | undefined)?.finish).toBe("error")
          const visible = new Set(MessageV2.filterCompacted(raw).map((msg) => msg.info.id))
          expect(visible.has(failed[0]!.info.id)).toBe(false)
          const log = yield* compactionEventLog(session.id)
          expect(publishedEventsFor(log, ownerID)).toEqual([])

          // Failure evidence can never be published, even by a direct attempt.
          const publishExit = yield* ssn
            .updatePart({
              ...part!,
              publication: { state: "published", summaryID: failed[0]!.info.id },
            } as SessionV1.CompactionPart)
            .pipe(Effect.exit)
          expect(Exit.isFailure(publishExit)).toBe(true)

          // Reopen: reentry refuses; no implicit re-summarization.
          const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
          const second = yield* SessionCompaction.use.process({
            parentID: ownerID,
            messages: yield* ssn.messages({ sessionID: session.id }),
            sessionID: session.id,
            auto: false,
          })
          expect(second).toBe("stop")
          expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
        }).pipe(
          withCompaction({
            processor: stubProcessor({
              process: (ssn, message) =>
                Effect.gen(function* () {
                  yield* persistSummary(ssn, message, "failed durable summary", {
                    finish: "error",
                    error: new SessionV1.AbortedError({ message: "cancelled" }).toObject(),
                  })
                  Deferred.doneUnsafe(entered, Effect.void)
                  yield* Deferred.await(hang)
                  return "continue" as const
                }),
            }),
          }),
        )
      }),
    { git: true },
  )

  itCompaction.instance(
    "T035 C9: committed abandoned cleanup stays terminal and cannot publish",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const seeded = yield* seedPriorPublication(session.id)
        yield* createSummaryCompaction(session.id)
        const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

        const result = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(result).toBe("stop")

        // C9: the abandoned cleanup committed.
        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID,
          taskOwners: [],
          candidateVisible: false,
          priorSummaryVisible: true,
          currentResponseID: seeded.prior.summary.id,
        })
        const part = raw
          .find((msg) => msg.info.id === ownerID)
          ?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction")
        expect(part?.publication).toEqual({ state: "abandoned" })
        const failed = summaryMessages(raw).filter((msg) => (msg.info as SessionV1.Assistant).parentID === ownerID)
        expect(failed).toHaveLength(1)
        expect((failed[0]?.info as SessionV1.Assistant | undefined)?.finish).toBe("error")
        const log = yield* compactionEventLog(session.id)
        expect(publishedEventsFor(log, ownerID)).toEqual([])

        // Reopen: reentry refuses; terminal state is preserved and history
        // is not rewritten.
        const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
        const second = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(second).toBe("stop")
        expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
        expect((yield* readOwnedCompactionPart(session.id, ownerID))?.publication).toEqual({ state: "abandoned" })
      }).pipe(
        withCompaction({
          processor: stubProcessor({
            process: (ssn, message) =>
              persistSummary(ssn, message, "failed durable summary", {
                finish: "error",
                error: new SessionV1.AbortedError({ message: "cancelled" }).toObject(),
              }).pipe(Effect.as("continue" as const)),
          }),
        }),
      ),
  )

  itCompaction.instance(
    "T035 C10: restart/reentry after the published decision preserves one effective publication",
    () => {
      const stub = llm()
      stub.push(reply("single durable summary"))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const x = yield* createUserMessage(session.id, "original request")
        yield* createSummaryCompaction(session.id)
        const ownerID = (yield* ssn.messages({ sessionID: session.id })).at(-1)!.info.id

        const first = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(first).toBe("continue")
        const summaries = summaryMessages(yield* ssn.messages({ sessionID: session.id }))
        expect(summaries).toHaveLength(1)

        // Restart after N6: one published binding, valid projection.
        const raw = yield* assertBoundaryState({
          sessionID: session.id,
          ownerID,
          taskOwners: [],
          candidateVisible: true,
          priorSummaryVisible: false,
          currentResponseID: summaries[0]!.info.id,
        })
        const published = raw
          .flatMap((msg) => msg.parts)
          .filter(
            (part): part is SessionV1.CompactionPart =>
              part.type === "compaction" && part.publication?.state === "published",
          )
        expect(published).toHaveLength(1)
        expect(published[0]?.publication).toEqual({ state: "published", summaryID: summaries[0]!.info.id })

        // Repeated identical publication is idempotent.
        yield* ssn.updatePart({ ...published[0] })
        const afterReplay = yield* ssn.messages({ sessionID: session.id })
        expect(
          afterReplay
            .flatMap((msg) => msg.parts)
            .filter(
              (part): part is SessionV1.CompactionPart =>
                part.type === "compaction" && part.publication?.state === "published",
            ),
        ).toHaveLength(1)

        // Reentry never re-executes, replays the original request, or
        // reschedules duplicate work.
        const rawBeforeReentry = JSON.stringify(yield* MessageV2.stream(session.id))
        const second = yield* SessionCompaction.use.process({
          parentID: ownerID,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })
        expect(second).toBe("stop")
        expect(stub.inputs).toHaveLength(1)
        expect(JSON.stringify(yield* MessageV2.stream(session.id))).toBe(rawBeforeReentry)
        expect(
          (yield* ssn.messages({ sessionID: session.id })).filter((msg) => msg.info.id === x.id),
        ).toHaveLength(1)
        expect(summaryMessages(yield* ssn.messages({ sessionID: session.id }))).toHaveLength(1)
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 0 }) }))
    },
  )
})
