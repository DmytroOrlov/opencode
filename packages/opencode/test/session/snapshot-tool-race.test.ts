/**
 * Reproducer for snapshot race condition with instant tool execution.
 *
 * When the mock LLM returns a tool call response instantly, the AI SDK
 * processes the tool call and executes the tool (e.g. apply_patch) before
 * the processor's start-step handler can capture a pre-tool snapshot.
 * Both the "before" and "after" snapshots end up with the same git tree
 * hash, so computeDiff returns empty and the session summary shows 0 files.
 *
 * This is a real bug: the snapshot system assumes it can capture state
 * before tools run by hooking into start-step, but the AI SDK executes
 * tools internally during multi-step processing before emitting events.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string) => ({
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
        baseURL: url,
      },
    },
  },
})

const fallbackProviderCfg = (url: string) => {
  const base = providerCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      mlx: {
        ...base.provider.test,
        id: "mlx",
        name: "MLX",
        models: {
          "qwen3.8-27b": {
            ...base.provider.test.models["test-model"],
            id: "qwen3.8-27b",
            name: "Qwen 3.8 27B",
            reasoning: true,
            variants: { xhigh: { reasoningEffort: "xhigh" } },
          },
        },
      },
    },
  }
}

it.live("tool execution produces non-empty session diff (snapshot race)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service

      const session = yield* sessions.create({
        title: "snapshot race test",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Use bash tool (always registered) to create a file
      const command = `echo 'snapshot race test content' > ${path.join(dir, "race-test.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", {
        command,
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      // Seed user message
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })

      // Run the agent loop
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      // Verify the file was created
      const filePath = path.join(dir, "race-test.txt")
      const fileExists = yield* Effect.promise(() =>
        fs
          .access(filePath)
          .then(() => true)
          .catch(() => false),
      )
      expect(fileExists).toBe(true)

      // Verify the tool call completed (in the first assistant message)
      const allMsgs = yield* MessageV2.filterCompactedEffect(session.id)
      const user = allMsgs.find(
        (msg): msg is SessionV1.WithParts & { info: SessionV1.User } => msg.info.role === "user",
      )
      const tool = allMsgs
        .flatMap((m) => m.parts)
        .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "bash")
      expect(tool?.state.status).toBe("completed")
      if (!user) throw new Error("Expected user message")

      // Poll for the turn diff — summarize() is fire-and-forget.
      let diff: Array<{ file?: string }> = []
      for (let i = 0; i < 50; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("continuation preserves executed tool patch provenance", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "snapshot continuation test",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const filePath = path.join(dir, "continuation.txt")
      const command = `echo 'continuation content' > ${filePath}`

      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create continuation file"), "bash", { command })
      yield* llm.pushMatch(
        (hit) => hit.body.model === "test-model",
        raw({
          chunks: [
            {
              id: "chatcmpl-snapshot-failure",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
            },
          ],
        }),
      )
      yield* llm.pushMatch((hit) => hit.body.model === "qwen3.8-27b", reply().text("continued").stop().item())

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create continuation file" }],
      })
      const result = yield* prompt.loop({ sessionID: session.id })
      const messages = yield* MessageV2.filterCompactedEffect(session.id)
      const parts = messages.flatMap((message) => message.parts)
      const tool = parts.find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")

      expect(result.info.role).toBe("assistant")
      expect(tool?.state.status).toBe("completed")
      expect(parts.some((part) => part.type === "patch" && part.files.some((file) => file === filePath))).toBe(true)
      expect(parts.some((part) => part.type === "text" && part.text === "continued")).toBe(true)
    }),
    { git: true, config: fallbackProviderCfg },
  ),
)
