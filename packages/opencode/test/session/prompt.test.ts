import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { FallbackRuntimeIntent } from "../../src/session/fallback-runtime-intent"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

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

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  FallbackRuntimeIntent.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function fallbackProviderCfg(url: string) {
  const base = providerCfg(url)
  const fallback = {
    ...base.provider.test,
    id: "mlx",
    name: "MLX",
    models: {
      "qwen3.8-27b": {
        ...cfg.provider.test.models["test-model"],
        id: "qwen3.8-27b",
        name: "Qwen 3.8 27B",
        reasoning: true,
        variants: { xhigh: { reasoningEffort: "xhigh" } },
      },
      "qwen-fallback-test": {
        ...cfg.provider.test.models["test-model"],
        id: "qwen-fallback-test",
        name: "Qwen Fallback Test",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      },
    },
  }
  return {
    ...providerCfg(url),
    provider: {
      ...base.provider,
      mlx: fallback,
    },
  }
}

function fallbackWithChunkTimeoutCfg(url: string, chunkTimeout: number) {
  const base = fallbackProviderCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        options: { ...base.provider.test.options, chunkTimeout },
      },
    },
  }
}

function fallbackRemoteDownCfg(url: string) {
  const base = fallbackProviderCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        options: { ...base.provider.test.options, baseURL: "http://127.0.0.1:1/v1" },
      },
      mlx: {
        ...base.provider.mlx,
        options: { ...base.provider.mlx.options, baseURL: url },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance(
  "fails over on the same assistant message and routes the active variant",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Fallback provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "fallback me" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-primary-transport",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      if (result.info.role !== "assistant") throw new Error("expected assistant message")
      expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
      expect(result.info.modelID).toBe(ModelV2.ID.make("qwen3.8-27b"))
      expect(result.info.variant).toBe("xhigh")
      expect(result.parts.some((part) => part.type === "text" && part.text === "fallback answer")).toBe(true)
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
      expect(JSON.stringify(inputs[1])).toContain("xhigh")
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "fails over immediately on a primary connectivity failure",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const events = yield* EventV2Bridge.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const statuses: SessionStatus.Info[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== SessionStatus.Event.Status.type) return Effect.void
        const data = event.data as typeof SessionStatus.Event.Status.data.Type
        if (data.sessionID === session.id) statuses.push(data.status)
        return Effect.void
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "fallback on network loss" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-connectivity",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("local answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      yield* off
      expect(result.info.role).toBe("assistant")
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
      expect(JSON.stringify(inputs[1])).toContain("xhigh")
      expect(statuses.some((status) => status.type === "retry")).toBe(false)
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "recovers from a silent primary SSE stream through the configured fallback",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => fallbackWithChunkTimeoutCfg(url, 50))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "recover from the silent SSE stream" }],
      })
      yield* llm.hang
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen3.8-27b",
        reply().text("fallback completed after idle timeout").stop().item(),
      )

      const result = yield* prompt.loop({ sessionID: session.id })
      if (result.info.role !== "assistant") throw new Error("expected assistant response")
      expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
      expect(result.info.modelID).toBe(ModelV2.ID.make("qwen3.8-27b"))
      expect(
        result.parts.some((part) => part.type === "text" && part.text === "fallback completed after idle timeout"),
      ).toBe(true)
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
    }),
  { config: fallbackWithChunkTimeoutCfg("http://localhost:1/v1", 50) },
  10_000,
)

it.instance(
  "does not use a fallback when explicitly disabled",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...fallbackProviderCfg(url), fallback: null }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "retry primary" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "disabled-fallback",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "test-model", reply().text("primary recovered").stop().item())
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(
        (yield* llm.inputs)
          .filter((input) => input.model === "test-model" && !JSON.stringify(input).includes("Generate a title"))
          .map((input) => input.model),
      ).toEqual(["test-model", "test-model"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "uses the configured fallback model and variant",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...fallbackProviderCfg(url),
        fallback: { model: "mlx/qwen-fallback-test", variant: "high" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "configured fallback" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen-fallback-test",
        reply().text("configured answer").stop().item(),
      )
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
        expect(result.info.modelID).toBe(ModelV2.ID.make("qwen-fallback-test"))
        expect(result.info.variant).toBe("high")
      }
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          ["test-model", "qwen-fallback-test"].some((model) => model === input.model) &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen-fallback-test"])
      expect(JSON.stringify(inputs[1])).toContain("high")
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "prefers the staged runtime fallback over the persisted one",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...fallbackProviderCfg(url),
        fallback: { model: "mlx/qwen-fallback-test", variant: "high" },
      }))
      const intent = yield* FallbackRuntimeIntent.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "runtime over persisted" }],
      })
      yield* intent.stage({ model: "mlx/qwen3.8-27b", variant: "xhigh" })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("runtime answer").stop().item())
      const result = yield* prompt.loop({ sessionID: session.id })
      if (result.info.role !== "assistant") throw new Error("expected assistant message")
      expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
      expect(result.info.modelID).toBe(ModelV2.ID.make("qwen3.8-27b"))
      expect(result.info.variant).toBe("xhigh")
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          ["test-model", "qwen3.8-27b", "qwen-fallback-test"].includes(String(input.model)) &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  15_000,
)

it.instance(
  "disables fallback when runtime intent explicitly clears it",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const intent = yield* FallbackRuntimeIntent.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "runtime clear" }],
      })
      yield* intent.stage(null)
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-runtime-clear",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "test-model", reply().text("primary recovered").stop().item())
      const result = yield* prompt.loop({ sessionID: session.id })
      if (result.info.role !== "assistant") throw new Error("expected assistant message")
      const inputs = (yield* llm.inputs).filter(
        (input) => input.model === "test-model" && !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "test-model"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  15_000,
)

it.instance(
  "dispatches the latest staged runtime fallback when an older one is superseded",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const intent = yield* FallbackRuntimeIntent.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "latest runtime fallback" }],
      })
      yield* intent.stage({ model: "mlx/qwen3.8-27b", variant: "xhigh" })
      yield* intent.stage({ model: "mlx/qwen-fallback-test", variant: "low" })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen-fallback-test", reply().text("latest answer").stop().item())
      const result = yield* prompt.loop({ sessionID: session.id })
      if (result.info.role !== "assistant") throw new Error("expected assistant message")
      expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
      expect(result.info.modelID).toBe(ModelV2.ID.make("qwen-fallback-test"))
      expect(result.info.variant).toBe("low")
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          ["test-model", "qwen3.8-27b", "qwen-fallback-test"].includes(String(input.model)) &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen-fallback-test"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  15_000,
)

it.instance(
  "keeps the accepted fallback attempt frozen when a newer intent arrives",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const intent = yield* FallbackRuntimeIntent.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const gate = defer<void>()
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "frozen fallback" }],
      })
      yield* intent.stage({ model: "mlx/qwen-fallback-test", variant: "high" })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen-fallback-test",
        raw({
          head: [{ id: "chatcmpl-held", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] }],
          wait: gate.promise,
          tail: [
            {
              id: "chatcmpl-held",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "held fallback answer" } }],
            },
            {
              id: "chatcmpl-held",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ],
        }),
      )

      const run = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        llm.inputs.pipe(
          Effect.map((inputs) => (inputs.some((input) => input.model === "qwen-fallback-test") ? true : undefined)),
        ),
        "staged fallback request never reached the provider",
      )
      yield* intent.stage({ model: "mlx/qwen3.8-27b", variant: "xhigh" })
      gate.resolve()

      const result = yield* Fiber.join(run)
      if (result.info.role !== "assistant") throw new Error("expected assistant message")
      expect(result.info.modelID).toBe(ModelV2.ID.make("qwen-fallback-test"))
      expect(result.info.variant).toBe("high")
      expect(result.parts.some((part) => part.type === "text" && part.text === "held fallback answer")).toBe(true)
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          ["test-model", "qwen3.8-27b", "qwen-fallback-test"].includes(String(input.model)) &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen-fallback-test"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  15_000,
)

it.instance(
  "uses configured fallback default reasoning without forcing a variant",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...fallbackProviderCfg(url),
        fallback: { model: "mlx/qwen-fallback-test", variant: null },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "default fallback" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen-fallback-test",
        reply().text("default answer").stop().item(),
      )
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.variant).toBeUndefined()
      const fallbackInput = (yield* llm.inputs).find(
        (input) => input.model === "qwen-fallback-test" && !JSON.stringify(input).includes("Generate a title"),
      )
      expect(fallbackInput).toBeDefined()
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "does not substitute the legacy fallback for invalid configured fallback values",
  () =>
    Effect.gen(function* () {
      const cases = [
        { name: "invalid variant", fallback: { model: "mlx/qwen-fallback-test", variant: "missing" } },
        { name: "inherited invalid variant", fallback: { model: "mlx/qwen-fallback-test", variant: "toString" } },
        { name: "invalid model", fallback: { model: "mlx/does-not-exist", variant: null } },
      ] as const
      for (const item of cases) {
        const { llm } = yield* useServerConfig((url) => ({ ...fallbackProviderCfg(url), fallback: item.fallback }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: item.name }],
        })
        yield* llm.pushMatch(
          (hit) => hit.body.model === "test-model",
          raw({
            chunks: [
              {
                id: item.name,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.pushMatch((hit) => hit.body.model === "test-model", reply().text("primary recovered").stop().item())
        yield* prompt.loop({ sessionID: session.id })
        expect((yield* llm.inputs).filter((input) => input.model !== "test-model")).toHaveLength(0)
      }
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "retries the fallback model without recursively failing over",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "retry fallback" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-fallback-retry-primary",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen3.8-27b",
        raw({
          chunks: [
            {
              id: "chatcmpl-fallback-retry-error",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback retry answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "does not fail over to the same provider and model with another variant",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => {
        const base = fallbackProviderCfg(url)
        return {
          ...base,
          provider: {
            ...base.provider,
            test: {
              ...base.provider.test,
              models: {
                ...base.provider.test.models,
                "test-model": {
                  ...base.provider.test.models["test-model"],
                  reasoning: true,
                  variants: {
                    high: { reasoningEffort: "high" },
                    xhigh: { reasoningEffort: "xhigh" },
                  },
                },
              },
            },
          },
          fallback: { model: "test/test-model", variant: "xhigh" },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "same model" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(400, { error: { message: "do not recurse" } }),
      )
      yield* prompt.loop({ sessionID: session.id })
      expect(
        (yield* llm.inputs).filter(
          (input) => input.model === "test-model" && !JSON.stringify(input).includes("Generate a title"),
        ),
      ).toHaveLength(1)
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "discards failed connectivity telemetry before local fallback telemetry starts",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackRemoteDownCfg)
      const events = yield* EventV2Bridge.Service
      const telemetry: { assistantMessageID?: string; done?: boolean; source?: string }[] = []
      const off = yield* events.listen((event) => {
        if (event.type === SessionV1.Event.Telemetry.type) {
          telemetry.push(event.data as { assistantMessageID?: string; done?: boolean; source?: string })
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "fallback telemetry" }],
      })
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("local answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      yield* Effect.sleep("100 millis")
      const current = telemetry.filter((item) => item.assistantMessageID === result.info.id)
      expect(current.filter((item) => item.done === false).length).toBeGreaterThanOrEqual(2)
      expect(current.filter((item) => item.done === true)).toHaveLength(0)
    }),
  { config: fallbackRemoteDownCfg("http://localhost:1/v1") },
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance(
  "keeps the fallback model sticky across a tool step",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Sticky fallback",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "use a tool" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-sticky-transport",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().tool("first", { value: "first" }).item())
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("sticky answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "starts a new user turn from the primary after sticky fallback",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first turn" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-first-turn-failure",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback turn").stop().item())
      yield* prompt.loop({ sessionID: session.id })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second turn" }],
      })
      yield* llm.pushMatch((hit) => hit.body.model === "test-model", reply().text("primary turn").stop().item())
      yield* prompt.loop({ sessionID: session.id })

      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b", "test-model"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "fails over an HTTP 400 when fallback is available",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "do not use fallback for HTTP 400" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(400, { error: { message: "primary unavailable" } }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
        expect(result.info.error).toBeUndefined()
      }
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "keeps retrying the primary when connectivity fails without a fallback",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "retry network failure" }],
      })
      yield* llm.push(
        raw({
          chunks: [
            {
              id: "chatcmpl-retry-partial",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
            },
            {
              id: "chatcmpl-retry-partial",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.text("primary recovered")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.info.role === "assistant" ? result.info.providerID : undefined).toBe(ProviderV2.ID.make("test"))
      expect(
        (yield* llm.inputs).filter(
          (input) => input.model === "test-model" && !JSON.stringify(input).includes("Generate a title"),
        ),
      ).toHaveLength(2)
      expect(result.parts.some((part) => part.type === "text" && part.text === "partial")).toBe(false)
      expect(result.parts.some((part) => part.type === "text" && part.text === "primary recovered")).toBe(true)
    }),
  { config: providerCfg("http://localhost:1/v1") },
)

it.instance(
  "fails over HTTP 503 when fallback is available",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "retry transient HTTP failures" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(503, { error: { message: "service unavailable" } }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback recovered").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.info.role === "assistant" ? result.info.providerID : undefined).toBe(ProviderV2.ID.make("mlx"))
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "fails over HTTP 429 before same-provider retry",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const events = yield* EventV2Bridge.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const statuses: SessionStatus.Info[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== SessionStatus.Event.Status.type) return Effect.void
        const data = event.data as typeof SessionStatus.Event.Status.data.Type
        if (data.sessionID === session.id) statuses.push(data.status)
        return Effect.void
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "fallback rate limit" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        httpError(429, { error: { message: "rate limited" } }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      yield* off
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )

      expect(result.info.role).toBe("assistant")
      expect(result.info.role === "assistant" ? result.info.providerID : undefined).toBe(ProviderV2.ID.make("mlx"))
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
      expect(JSON.stringify(inputs[1])).toContain("xhigh")
      expect(statuses.some((status) => status.type === "retry")).toBe(false)
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "continues from a completed tool without replaying it after provider failure",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      let executionCount = 0
      const originalRead = read.execute
      read.execute = (...args) => {
        executionCount++
        return originalRead(...args)
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          read.execute = originalRead
        }),
      )
      const session = yield* sessions.create({
        title: "Tool continuation fallback",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "once.txt")
      yield* writeText(file, "executed once")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "read the file and summarize it" }],
      })
      yield* llm.pushMatch((hit) => hit.body.model === "test-model", reply().tool("read", { filePath: file }).item())
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-tool-failure",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback summary").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      const msgs = yield* MessageV2.filterCompactedEffect(session.id)
      const tools = msgs.flatMap((msg) => msg.parts).filter((part) => part.type === "tool" && part.tool === "read")
      const toolAssistant = msgs.find(
        (msg) =>
          msg.info.role === "assistant" &&
          msg.parts.some((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed"),
      )
      const fallbackAssistant = msgs.find(
        (msg) => msg.info.role === "assistant" && msg.info.providerID === ProviderV2.ID.make("mlx"),
      )
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )

      expect(result.info.role).toBe("assistant")
      expect(result.info.role === "assistant" ? result.info.providerID : undefined).toBe(ProviderV2.ID.make("mlx"))
      expect(result.parts.some((part) => part.type === "text" && part.text === "fallback summary")).toBe(true)
      expect(executionCount).toBe(1)
      expect(tools).toHaveLength(1)
      expect(tools[0]?.type === "tool" ? tools[0].state.status : undefined).toBe("completed")
      expect(toolAssistant?.info.role === "assistant" ? toolAssistant.info.providerID : undefined).toBe(
        ProviderV2.ID.make("test"),
      )
      expect(toolAssistant?.info.role === "assistant" ? toolAssistant.info.modelID : undefined).toBe(
        ModelV2.ID.make("test-model"),
      )
      expect(fallbackAssistant?.info.role === "assistant" ? fallbackAssistant.info.providerID : undefined).toBe(
        ProviderV2.ID.make("mlx"),
      )
      expect(fallbackAssistant?.info.role === "assistant" ? fallbackAssistant.info.modelID : undefined).toBe(
        ModelV2.ID.make("qwen3.8-27b"),
      )
      expect(fallbackAssistant?.info.role === "assistant" ? fallbackAssistant.info.variant : undefined).toBe("xhigh")
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "test-model", "qwen3.8-27b"])
      expect(JSON.stringify(inputs[2])).toContain("executed once")
      expect(JSON.stringify(inputs[0])).toContain("exact model ID is test/test-model")
      expect(JSON.stringify(inputs[2])).toContain("exact model ID is mlx/qwen3.8-27b")
      expect(JSON.stringify(inputs[2])).not.toContain("exact model ID is test/test-model")
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
  10_000,
)

it.instance(
  "replaces partial text before connectivity fallback",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "do not fail over after output" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-partial-connectivity",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
            },
            {
              id: "chatcmpl-partial-connectivity",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("fallback answer").stop().item())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.info.role === "assistant" ? result.info.providerID : undefined).toBe(ProviderV2.ID.make("mlx"))
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
      expect(result.parts.some((part) => part.type === "text" && part.text === "partial")).toBe(false)
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance(
  "does not retry a failed fallback or fall back recursively",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(fallbackProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "fallback failure" }],
      })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-no-recursive-primary",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch(
        (hit) => hit.body.model === "qwen3.8-27b",
        httpError(400, { error: { message: "fallback unavailable" } }),
      )

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.providerID).toBe(ProviderV2.ID.make("mlx"))
        expect(result.info.modelID).toBe(ModelV2.ID.make("qwen3.8-27b"))
        expect(result.info.error).toBeDefined()
      }
      const inputs = (yield* llm.inputs).filter(
        (input) =>
          (input.model === "test-model" || input.model === "qwen3.8-27b") &&
          !JSON.stringify(input).includes("Generate a title"),
      )
      expect(inputs.map((input) => input.model)).toEqual(["test-model", "qwen3.8-27b"])
    }),
  { config: fallbackProviderCfg("http://localhost:1/v1") },
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

it.instance("records an aborted fallback when prompt is cancelled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(fallbackProviderCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Fallback cancel regression" })

    yield* llm.pushMatch(
      (hit) => hit.body.model === "test-model" && !JSON.stringify(hit.body).includes("Generate a title"),
      raw({
        chunks: [
          {
            id: "fallback-cancel-primary",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
          },
        ],
      }),
    )
    yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().hang().item())

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel fallback" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      llm.inputs.pipe(
        Effect.map((inputs) => (inputs.some((input) => input.model === "qwen3.8-27b") ? true : undefined)),
      ),
      "fallback request did not start",
    )
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.providerID).toBe(ProviderV2.ID.make("mlx"))
      expect(last.info.modelID).toBe(ModelV2.ID.make("qwen3.8-27b"))
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

const messageIDs = (msgs: SessionV1.WithParts[]) => msgs.map((msg) => msg.info.id)

type LegacySchedulingSeed = {
  head: SessionV1.Info
  tailUser: SessionV1.Info
  tailAssistant: SessionV1.Info
  c1: SessionV1.Info
  s1: SessionV1.Info
  c2: SessionV1.Info
  s2: SessionV1.Info
}

const seedLegacyScheduling = Effect.fn("test.seedLegacyScheduling")(function* (
  sessionID: SessionID,
  finalize: "unfinished" | "failed",
) {
  const session = yield* Session.Service

  const head = yield* session.updateMessage({
    id: MessageID.make("msg_sched_head"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 100 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_head"),
    messageID: head.id,
    sessionID,
    type: "text",
    text: "head question",
  })
  const headReply = yield* session.updateMessage({
    id: MessageID.make("msg_sched_head_reply"),
    role: "assistant",
    parentID: head.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: 110 },
    finish: "stop",
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_head_reply"),
    messageID: headReply.id,
    sessionID,
    type: "text",
    text: "head reply",
  })

  const tailUser = yield* session.updateMessage({
    id: MessageID.make("msg_sched_tail"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 160 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_tail"),
    messageID: tailUser.id,
    sessionID,
    type: "text",
    text: "tail question",
  })
  const tailAssistant = yield* session.updateMessage({
    id: MessageID.make("msg_sched_tail_reply"),
    role: "assistant",
    parentID: tailUser.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: 170 },
    finish: "stop",
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_tail_reply"),
    messageID: tailAssistant.id,
    sessionID,
    type: "text",
    text: "tail reply",
  })

  const c1 = yield* session.updateMessage({
    id: MessageID.make("msg_sched_c1"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 200 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_c1"),
    messageID: c1.id,
    sessionID,
    type: "compaction",
    auto: true,
    tail_start_id: tailUser.id,
  })
  const s1 = yield* session.updateMessage({
    id: MessageID.make("msg_sched_s1"),
    role: "assistant",
    parentID: c1.id,
    sessionID,
    mode: "compaction",
    agent: "compaction",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    summary: true,
    finish: "stop",
    time: { created: 250 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_s1"),
    messageID: s1.id,
    sessionID,
    type: "text",
    text: "summary one",
  })

  const c2 = yield* session.updateMessage({
    id: MessageID.make("msg_sched_c2"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 300 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_c2"),
    messageID: c2.id,
    sessionID,
    type: "compaction",
    auto: true,
  })
  const s2 = yield* session.updateMessage({
    id: MessageID.make("msg_sched_s2"),
    role: "assistant",
    parentID: c2.id,
    sessionID,
    mode: "compaction",
    agent: "compaction",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    summary: true,
    time: finalize === "failed" ? { created: 350, completed: 350 } : { created: 350 },
    ...(finalize === "failed"
      ? { finish: "error" as const, error: new SessionV1.AbortedError({ message: "compaction failed" }).toObject() }
      : {}),
  })
  yield* session.updatePart({
    id: PartID.make("prt_sched_s2"),
    messageID: s2.id,
    sessionID,
    type: "text",
    text: finalize === "failed" ? "failed summary" : "partial summary",
  })

  return { head, tailUser, tailAssistant, c1, s1, c2, s2 }
})

const compactionProcessCalls: { parentID: MessageID; messages: SessionV1.WithParts[]; auto: boolean }[] = []

function recordingCompactionLayer(result: "stop" | "continue" = "stop") {
  return Layer.succeed(
    SessionCompaction.Service,
    SessionCompaction.Service.of({
      isOverflow: () => Effect.succeed(false),
      prune: () => Effect.void,
      process: (input) =>
        Effect.sync(() => {
          compactionProcessCalls.push({ parentID: input.parentID, messages: input.messages, auto: input.auto })
          return result
        }),
      create: () => Effect.void,
    }),
  )
}

function makeHttpRecordingCompaction(result: "stop" | "continue" = "stop") {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  return LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [SessionCompaction.node, recordingCompactionLayer(result)],
  ])
}

const recordingCompactionIt = testEffect(makeHttpRecordingCompaction())
const recordingCompactionContinueIt = testEffect(makeHttpRecordingCompaction("continue"))

recordingCompactionIt.instance(
  "legacy pending compaction remains runnable after an unfinished legacy summary",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Legacy pending scheduling" })
      const seeded: LegacySchedulingSeed = yield* seedLegacyScheduling(chat.id, "unfinished")

      yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(1)
      const call = compactionProcessCalls[0]!
      expect(call.parentID).toBe(seeded.c2.id)
      expect(messageIDs(call.messages)).toEqual([
        seeded.c1.id,
        seeded.s1.id,
        seeded.tailUser.id,
        seeded.tailAssistant.id,
        seeded.c2.id,
        seeded.s2.id,
      ])
      expect(messageIDs(call.messages)).not.toContain(seeded.head.id)
    }),
  { config: cfg },
)

recordingCompactionIt.instance(
  "a terminal failed legacy summary suppresses the legacy compaction task",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Legacy failed scheduling" })
      const seeded: LegacySchedulingSeed = yield* seedLegacyScheduling(chat.id, "failed")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(0)
      expect(result.info.id).toBe(seeded.s2.id)
    }),
  { config: cfg },
)

recordingCompactionIt.instance(
  "an explicit synthetic compaction user missing publication metadata is not eligible legacy work",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Malformed synthetic scheduling" })

      const user = yield* sessions.updateMessage({
        id: MessageID.make("msg_p3_user"),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_p3_user"),
        messageID: user.id,
        sessionID: chat.id,
        type: "text",
        text: "genuine question",
      })
      const reply = yield* sessions.updateMessage({
        id: MessageID.make("msg_p3_reply"),
        role: "assistant",
        parentID: user.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 150 },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_p3_reply"),
        messageID: reply.id,
        sessionID: chat.id,
        type: "text",
        text: "genuine reply",
      })

      const malformed = yield* sessions.updateMessage({
        id: MessageID.make("msg_p3_malformed"),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 200 },
        origin: "compaction",
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_p3_malformed"),
        messageID: malformed.id,
        sessionID: chat.id,
        type: "compaction",
        auto: true,
      })
      const malformedSummary = yield* sessions.updateMessage({
        id: MessageID.make("msg_p3_malformed_summary"),
        role: "assistant",
        parentID: malformed.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        summary: true,
        finish: "stop",
        time: { created: 250 },
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_p3_malformed_summary"),
        messageID: malformedSummary.id,
        sessionID: chat.id,
        type: "text",
        text: "misclassified summary",
      })

      yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(0)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(messageIDs(msgs)).toEqual([user.id, reply.id])
      const state = MessageV2.latest(msgs)
      expect(state.user?.id).toBe(user.id)
      expect(state.finished?.id).toBe(reply.id)
      expect(state.tasks).toEqual([])
    }),
  { config: cfg },
)

type QueuedSeed = {
  x: SessionV1.Info
  b: SessionV1.Info
  u: SessionV1.Info
  y: SessionV1.Info | undefined
}

const seedQueuedCompaction = Effect.fn("test.seedQueuedCompaction")(function* (
  sessionID: SessionID,
  options?: {
    newerUser?: boolean
    newerUserModel?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  },
) {
  const session = yield* Session.Service
  const x = yield* session.updateMessage({
    id: MessageID.make("msg_qc_x"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 100 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_qc_x"),
    messageID: x.id,
    sessionID,
    type: "text",
    text: "question",
  })
  const b = yield* session.updateMessage({
    id: MessageID.make("msg_qc_b"),
    role: "assistant",
    parentID: x.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: 110 },
    finish: "stop",
  })
  yield* session.updatePart({
    id: PartID.make("prt_qc_b"),
    messageID: b.id,
    sessionID,
    type: "text",
    text: "answer",
  })
  const u = yield* session.updateMessage({
    id: MessageID.make("msg_qc_u"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 200 },
    origin: "compaction",
  })
  yield* session.updatePart({
    id: PartID.make("prt_qc_u"),
    messageID: u.id,
    sessionID,
    type: "compaction",
    auto: true,
    publication: { state: "queued" },
  })
  let y: SessionV1.Info | undefined
  if (options?.newerUser) {
    y = yield* session.updateMessage({
      id: MessageID.make("msg_qc_y"),
      role: "user",
      sessionID,
      agent: "build",
      model: options.newerUserModel ?? ref,
      time: { created: 300 },
    })
    yield* session.updatePart({
      id: PartID.make("prt_qc_y"),
      messageID: y.id,
      sessionID,
      type: "text",
      text: "newer question",
    })
  }
  return { x, b, u, y }
})

recordingCompactionIt.instance(
  "T014 compaction uses task.messageID with the projection bounded through that owner",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Queued owner" })
      const seeded: QueuedSeed = yield* seedQueuedCompaction(chat.id, { newerUser: true })
      const rawBefore = JSON.stringify(yield* MessageV2.stream(chat.id))

      yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(1)
      const call = compactionProcessCalls[0]!
      expect(call.parentID).toBe(seeded.u.id)
      expect(messageIDs(call.messages)).toEqual([seeded.x.id, seeded.b.id, seeded.u.id])
      expect(messageIDs(call.messages)).not.toContain(seeded.y!.id)

      const acceptance = (parentID: MessageID) => {
        expect(parentID).toBe(seeded.u.id)
      }
      acceptance(call.parentID)
      expect(() => acceptance(seeded.y!.id)).toThrow()

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(messageIDs(msgs)).toContain(seeded.y!.id)
      expect(messageIDs(msgs)).not.toContain(seeded.u.id)
      expect(MessageV2.latest(msgs).user?.id).toBe(seeded.y!.id)
      expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(rawBefore)
    }),
  { config: cfg },
)

recordingCompactionContinueIt.instance(
  "T015 pending queued work runs before the completed-turn early exit and only once",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Finished turn then queued work" })
      const seeded: QueuedSeed = yield* seedQueuedCompaction(chat.id)

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(1)
      const call = compactionProcessCalls[0]!
      expect(call.parentID).toBe(seeded.u.id)
      expect(messageIDs(call.messages)).toEqual([seeded.x.id, seeded.b.id, seeded.u.id])
      expect(result.info.id).toBe(seeded.b.id)
      expect(yield* llm.hits).toHaveLength(0)

      const raw = yield* MessageV2.stream(chat.id)
      expect(messageIDs(raw)).toContain(seeded.u.id)
      expect(MessageV2.pendingWork(raw).tasks.map((task) => task.messageID)).toEqual([seeded.u.id])
    }),
  30_000,
)

recordingCompactionContinueIt.instance(
  "T017 a newer genuine user keeps its own generation identity while queued work stays owned by U",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Queued work with newer user" })
      const seeded: QueuedSeed = yield* seedQueuedCompaction(chat.id, { newerUser: true })
      yield* llm.text("y answer")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(compactionProcessCalls).toHaveLength(1)
      const call = compactionProcessCalls[0]!
      expect(call.parentID).toBe(seeded.u.id)
      expect(messageIDs(call.messages)).toEqual([seeded.x.id, seeded.b.id, seeded.u.id])
      expect(messageIDs(call.messages)).not.toContain(seeded.y!.id)

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.parentID).toBe(seeded.y!.id)
        expect(result.info.finish).toBe("stop")
      }
      expect(yield* llm.hits).toHaveLength(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(messageIDs(msgs)).toContain(seeded.y!.id)
      expect(messageIDs(msgs)).not.toContain(seeded.u.id)
      expect(MessageV2.latest(msgs).user?.id).toBe(seeded.y!.id)

      const raw = yield* MessageV2.stream(chat.id)
      const pending = MessageV2.pendingWork(raw).tasks
      expect(pending.map((task) => task.messageID)).toEqual([seeded.u.id])
      expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(JSON.stringify(raw))
    }),
  30_000,
)

const seedGenuineExchange = Effect.fn("test.seedGenuineExchange")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const x = yield* session.updateMessage({
    id: MessageID.make("msg_sgx_x"),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: 100 },
  })
  yield* session.updatePart({
    id: PartID.make("prt_sgx_x"),
    messageID: x.id,
    sessionID,
    type: "text",
    text: "question",
  })
  const b = yield* session.updateMessage({
    id: MessageID.make("msg_sgx_b"),
    role: "assistant",
    parentID: x.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: 110 },
    finish: "stop",
  })
  yield* session.updatePart({
    id: PartID.make("prt_sgx_b"),
    messageID: b.id,
    sessionID,
    type: "text",
    text: "answer",
  })
  return { x, b }
})

type SyntheticShape = {
  name: string
  attach: (sessionID: SessionID) => Effect.Effect<SessionV1.Info, never, Session.Service>
}

const syntheticShapes: SyntheticShape[] = [
  {
    name: "orphan compaction user with no part",
    attach: (sessionID) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.updateMessage({
          id: MessageID.make("msg_syn_orphan"),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: 200 },
          origin: "compaction",
        })
      }),
  },
  {
    name: "compaction user whose part lacks publication metadata",
    attach: (sessionID) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const u = yield* session.updateMessage({
          id: MessageID.make("msg_syn_malformed"),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: 200 },
          origin: "compaction",
        })
        yield* session.updatePart({
          id: PartID.make("prt_syn_malformed"),
          messageID: u.id,
          sessionID,
          type: "compaction",
          auto: false,
        })
        const s = yield* session.updateMessage({
          id: MessageID.make("msg_syn_malformed_s"),
          role: "assistant",
          parentID: u.id,
          sessionID,
          mode: "compaction",
          agent: "compaction",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: 210 },
          summary: true,
          finish: "stop",
        })
        yield* session.updatePart({
          id: PartID.make("prt_syn_malformed_s"),
          messageID: s.id,
          sessionID,
          type: "text",
          text: "misclassified summary",
        })
        return u
      }),
  },
  {
    name: "recovery-preparation user with a queued part",
    attach: (sessionID) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const u = yield* session.updateMessage({
          id: MessageID.make("msg_syn_recovery"),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: 200 },
          origin: "recovery-preparation",
        })
        yield* session.updatePart({
          id: PartID.make("prt_syn_recovery"),
          messageID: u.id,
          sessionID,
          type: "compaction",
          auto: false,
          publication: { state: "queued" },
        })
        return u
      }),
  },
  {
    name: "unknown-origin user with a queued part",
    attach: (sessionID) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const u = yield* session.updateMessage({
          id: MessageID.make("msg_syn_unknown"),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: 200 },
          origin: "unknown-future-origin",
        })
        yield* session.updatePart({
          id: PartID.make("prt_syn_unknown"),
          messageID: u.id,
          sessionID,
          type: "compaction",
          auto: false,
          publication: { state: "queued" },
        })
        return u
      }),
  },
  {
    name: "compaction user carrying an accidental text part",
    attach: (sessionID) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const u = yield* session.updateMessage({
          id: MessageID.make("msg_syn_text"),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: 200 },
          origin: "compaction",
        })
        yield* session.updatePart({
          id: PartID.make("prt_syn_text"),
          messageID: u.id,
          sessionID,
          type: "text",
          text: "accidental synthetic text",
        })
        return u
      }),
  },
]

for (const shape of syntheticShapes) {
  it.instance(
    `T016 ${shape.name} cannot start ordinary generation without an earlier genuine user`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Synthetic only" })
        const synthetic = yield* shape.attach(chat.id)

        const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("No user message found")
        }
        expect(yield* llm.hits).toHaveLength(0)
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        expect(messageIDs(msgs)).toEqual([])
        expect(messageIDs(msgs)).not.toContain(synthetic.id)
      }),
    30_000,
  )

  it.instance(
    `T016 ${shape.name} cannot displace an earlier genuine user's completed result`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Genuine then synthetic" })
        const genuine = yield* seedGenuineExchange(chat.id)
        const synthetic = yield* shape.attach(chat.id)

        const result = yield* prompt.loop({ sessionID: chat.id })

        expect(result.info.id).toBe(genuine.b.id)
        expect(yield* llm.hits).toHaveLength(0)
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        expect(messageIDs(msgs)).toEqual([genuine.x.id, genuine.b.id])
        expect(messageIDs(msgs)).not.toContain(synthetic.id)
        expect(MessageV2.latest(msgs).user?.id).toBe(genuine.x.id)
      }),
    30_000,
  )
}

it.instance("T018 completed-but-unpublished summary is not the current response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Unpublished summary" })
    const genuine = yield* seedGenuineExchange(chat.id)
    const u2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_unpub_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_unpub_u"),
      messageID: u2.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "preparing" },
    })
    const s2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_unpub_s"),
      role: "assistant",
      parentID: u2.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "stop",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_unpub_s"),
      messageID: s2.id,
      sessionID: chat.id,
      type: "text",
      text: "unpublished summary text",
    })

    const naive = yield* sessions.findMessage(chat.id, (m) => m.info.role !== "user")
    expect(Option.isSome(naive)).toBe(true)
    if (Option.isSome(naive)) expect(naive.value.info.id).toBe(s2.id)

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(genuine.b.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
  30_000,
)

it.instance("T018 streaming provisional summary is not the current response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Provisional summary" })
    const genuine = yield* seedGenuineExchange(chat.id)
    const u2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_prov_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_prov_u"),
      messageID: u2.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "preparing" },
    })
    const s2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_prov_s"),
      role: "assistant",
      parentID: u2.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_prov_s"),
      messageID: s2.id,
      sessionID: chat.id,
      type: "text",
      text: "partial summary text",
    })

    const naive = yield* sessions.findMessage(chat.id, (m) => m.info.role !== "user")
    expect(Option.isSome(naive)).toBe(true)
    if (Option.isSome(naive)) expect(naive.value.info.id).toBe(s2.id)

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(genuine.b.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
  30_000,
)

it.instance("T018 published candidate rejected for an invalid tail is not the current response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Invalid tail summary" })
    const genuine = yield* seedGenuineExchange(chat.id)
    const u2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_tail_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    const s2 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_tail_s"),
      role: "assistant",
      parentID: u2.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "stop",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_tail_s"),
      messageID: s2.id,
      sessionID: chat.id,
      type: "text",
      text: "rejected tail summary",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_tail_u"),
      messageID: u2.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      tail_start_id: u2.id,
      publication: { state: "published", summaryID: MessageID.make("msg_t18_tail_s") },
    })

    const naive = yield* sessions.findMessage(chat.id, (m) => m.info.role !== "user")
    expect(Option.isSome(naive)).toBe(true)
    if (Option.isSome(naive)) expect(naive.value.info.id).toBe(s2.id)

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(genuine.b.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
  30_000,
)

it.instance("T018 published compaction summary keeps its continuation semantics", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Published summary response" })
    yield* seedGenuineExchange(chat.id)
    const u1 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_pub_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    const s1 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_pub_s"),
      role: "assistant",
      parentID: u1.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "stop",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_pub_s"),
      messageID: s1.id,
      sessionID: chat.id,
      type: "text",
      text: "published summary text",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_pub_u"),
      messageID: u1.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "published", summaryID: MessageID.make("msg_t18_pub_s") },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(s1.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
  30_000,
)

it.instance("T018 a genuine later user's assistant stays attributed to that user", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Genuine later user" })
    yield* seedGenuineExchange(chat.id)
    const u1 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_y_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    const s1 = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_y_s"),
      role: "assistant",
      parentID: u1.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "stop",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_y_s"),
      messageID: s1.id,
      sessionID: chat.id,
      type: "text",
      text: "published summary text",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_y_u"),
      messageID: u1.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "published", summaryID: MessageID.make("msg_t18_y_s") },
    })
    const y = yield* sessions.updateMessage({
      id: MessageID.make("msg_t18_y_user"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 300 },
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t18_y_user"),
      messageID: y.id,
      sessionID: chat.id,
      type: "text",
      text: "newer question",
    })
    yield* llm.text("y answer")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.parentID).toBe(y.id)
      expect(result.info.finish).toBe("stop")
    }
    expect(yield* llm.hits).toHaveLength(1)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(MessageV2.latest(msgs).user?.id).toBe(y.id)
  }),
  30_000,
)

recordingCompactionContinueIt.instance(
  "B1 queued compaction dispatch depends on its exact owner, not the newer user's model",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Owner model isolation" })
      const seeded: QueuedSeed = yield* seedQueuedCompaction(chat.id, {
        newerUser: true,
        newerUserModel: {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("missing-model"),
        },
      })

      const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

      expect(compactionProcessCalls).toHaveLength(1)
      const call = compactionProcessCalls[0]!
      expect(call.parentID).toBe(seeded.u.id)
      expect(messageIDs(call.messages)).toEqual([seeded.x.id, seeded.b.id, seeded.u.id])
      expect(messageIDs(call.messages)).not.toContain(seeded.y!.id)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("missing-model")
      }

      const raw = yield* MessageV2.stream(chat.id)
      expect(messageIDs(raw)).toContain(seeded.u.id)
      expect(messageIDs(raw)).toContain(seeded.y!.id)
    }),
  { config: cfg },
)

recordingCompactionIt.instance(
  "final-response edge: no legitimate assistant yields a clear no-valid-response outcome",
  () =>
    Effect.gen(function* () {
      compactionProcessCalls.length = 0
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Unpublished then queued" })

      const x = yield* sessions.updateMessage({
        id: MessageID.make("msg_fr_x"),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_fr_x"),
        messageID: x.id,
        sessionID: chat.id,
        type: "text",
        text: "question",
      })
      const u2 = yield* sessions.updateMessage({
        id: MessageID.make("msg_fr_u2"),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 200 },
        origin: "compaction",
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_fr_u2"),
        messageID: u2.id,
        sessionID: chat.id,
        type: "compaction",
        auto: false,
        publication: { state: "preparing" },
      })
      const s2 = yield* sessions.updateMessage({
        id: MessageID.make("msg_fr_s2"),
        role: "assistant",
        parentID: u2.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 210 },
        summary: true,
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_fr_s2"),
        messageID: s2.id,
        sessionID: chat.id,
        type: "text",
        text: "unpublished summary text",
      })
      const uq = yield* sessions.updateMessage({
        id: MessageID.make("msg_fr_uq"),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 300 },
        origin: "compaction",
      })
      yield* sessions.updatePart({
        id: PartID.make("prt_fr_uq"),
        messageID: uq.id,
        sessionID: chat.id,
        type: "compaction",
        auto: true,
        publication: { state: "queued" },
      })

      const rawBefore = JSON.stringify(yield* MessageV2.stream(chat.id))
      const naive = yield* sessions.findMessage(chat.id, (m) => m.info.role !== "user")
      expect(Option.isSome(naive)).toBe(true)
      if (Option.isSome(naive)) expect(naive.value.info.id).toBe(s2.id)

      const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)

      expect(compactionProcessCalls).toHaveLength(1)
      expect(compactionProcessCalls[0]!.parentID).toBe(uq.id)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message).toContain("No assistant response available")
        expect(message).not.toContain("unpublished summary text")
      }
      expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(rawBefore)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(messageIDs(msgs)).toEqual([x.id])
      expect(messageIDs(msgs)).not.toContain(s2.id)
    }),
  { config: cfg },
)

it.instance("T034 C1: orphan synthetic compaction U without a part dispatches no generation and is not the current response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Crash C1 orphan" })
    const genuine = yield* seedGenuineExchange(chat.id)
    // Boundary C1: durable synthetic U exists without its compaction part.
    const orphan = yield* sessions.updateMessage({
      id: MessageID.make("msg_t34_c1_orphan"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })

    const rawBefore = JSON.stringify(yield* MessageV2.stream(chat.id))
    const result = yield* prompt.loop({ sessionID: chat.id })

    // The orphan never dispatches generation and never becomes the response.
    expect(yield* llm.hits).toHaveLength(0)
    expect(result.info.id).toBe(genuine.b.id)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(messageIDs(msgs)).not.toContain(orphan.id)
    // The loop performs no writes for the orphaned synthetic request.
    expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(rawBefore)
  }),
  30_000,
)

it.instance("T035 C5: a successful complete-but-unpublished summary is never the current response after reopen", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Crash C5 unpublished" })
    const genuine = yield* seedGenuineExchange(chat.id)
    // Boundary C5: S is durably successful, finished and readable while P is
    // still preparing, with no failure evidence and no publication.
    const u = yield* sessions.updateMessage({
      id: MessageID.make("msg_t35_c5_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t35_c5_u"),
      messageID: u.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "preparing" },
    })
    const s = yield* sessions.updateMessage({
      id: MessageID.make("msg_t35_c5_s"),
      role: "assistant",
      parentID: u.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "end_turn",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t35_c5_s"),
      messageID: s.id,
      sessionID: chat.id,
      type: "text",
      text: "successful unpublished summary",
    })

    const rawBefore = JSON.stringify(yield* MessageV2.stream(chat.id))
    const naive = yield* sessions.findMessage(chat.id, (m) => m.info.role !== "user")
    expect(Option.isSome(naive)).toBe(true)
    if (Option.isSome(naive)) expect(naive.value.info.id).toBe(s.id)

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(0)
    expect(result.info.id).toBe(genuine.b.id)
    // Reopen-equivalent durable state is untouched by the read path.
    expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(rawBefore)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(messageIDs(msgs)).not.toContain(s.id)
  }),
  30_000,
)

it.instance("T035 C7: a published pair before autocontinue keeps the summary as the response without replay", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Crash C7 published" })
    const genuine = yield* seedGenuineExchange(chat.id)
    // Boundary C7: N6 committed (published) and the optional continuation
    // never ran. The publication itself must remain valid.
    const u = yield* sessions.updateMessage({
      id: MessageID.make("msg_t35_c7_u"),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: 200 },
      origin: "compaction",
    })
    const s = yield* sessions.updateMessage({
      id: MessageID.make("msg_t35_c7_s"),
      role: "assistant",
      parentID: u.id,
      sessionID: chat.id,
      mode: "compaction",
      agent: "compaction",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: 210 },
      summary: true,
      finish: "end_turn",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t35_c7_s"),
      messageID: s.id,
      sessionID: chat.id,
      type: "text",
      text: "published crash-safe summary",
    })
    yield* sessions.updatePart({
      id: PartID.make("prt_t35_c7_u"),
      messageID: u.id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      publication: { state: "published", summaryID: s.id },
    })

    const rawBefore = JSON.stringify(yield* MessageV2.stream(chat.id))
    const result = yield* prompt.loop({ sessionID: chat.id })

    // The published summary is the current response; the original request is
    // not replayed and no continuation message is invented.
    expect(result.info.id).toBe(s.id)
    expect(yield* llm.hits).toHaveLength(0)
    expect(JSON.stringify(yield* MessageV2.stream(chat.id))).toBe(rawBefore)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(messageIDs(msgs)).toContain(s.id)
    expect(messageIDs(msgs)).not.toContain(genuine.x.id)
  }),
  30_000,
)
