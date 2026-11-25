import { expect } from "bun:test"
import {
  AIError,
  LanguageModel,
  TransportError,
} from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { Tool } from "@opencode/core/tool"
import { Document, Info } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const primary = LanguageModel.make({ id: "handoff-primary", provider: "fake", route: OpenAIChat.route })
const fallback = LanguageModel.update(
  LanguageModel.make({ id: "handoff-fallback", provider: "fake", route: OpenAIChat.route }),
  { options: { providerOptions: { effort: "high" } } },
)
const fallbackSelection = {
  providerID: Provider.ID.make("fake"),
  model: Model.ID.make("handoff-fallback"),
  variant: Model.VariantID.make("high"),
}
const retryable = () =>
  new AIError({
    reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
  })

const primarySelection = () => ({
  id: Model.ID.make("handoff-primary"),
  providerID: Provider.ID.make("fake"),
})

/**
 * Every real Location graph in this fixture registers the same scripted tool and allows the build agent to use it.
 * The node is a Location node, so each graph gets its own registry and agent state while sharing the scripted LLM.
 */
const graphTools = makeLocationNode({
  name: "test/session-handoff-tools",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
      })
      const registry = yield* Tool.Service
      yield* registry.transform((editor) => {
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          options: { codemode: false },
          execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
        })
      })
    }),
  ),
  deps: [Agent.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  SessionRestart.node,
  LocationServiceMap.node,
  SessionStore.node,
  KV.node,
])

// A real destination graph is built by `SessionMove` while the fallback request is still held, then selected by
// `SessionExecution` for the carried continuation. The model graph records its own identity and the directory it
// resolved, so the assertions distinguish two constructed instances instead of only two Location strings.
const it = testEffect(Layer.empty)

it.effect(
  "carries the attempted fallback into a new Location graph and suppresses it for the same turn",
  () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const source = yield* tmpdirScoped("handoff-source-")
      const destination = yield* tmpdirScoped("handoff-destination-")
      const sourceRef = Location.Ref.make({ directory: AbsolutePath.make(source.path) })
      const destinationRef = Location.Ref.make({ directory: AbsolutePath.make(destination.path) })

      const llmContext = yield* Layer.buildWithScope(
        TestLLM.testLayer({ fallback: undefined }),
        scope,
      )
      const llm = Context.get(llmContext, TestLLM.Test)
      const globalContext = yield* Layer.buildWithScope(tempGlobalLayer, scope)

      const graphBuilds: Array<string> = []
      const resolutions: Array<{ readonly graph: string; readonly model: string; readonly directory: string }> = []
      let build = 0
      const models = Layer.effect(
        SessionRunnerModel.Service,
        Effect.sync(() => {
          const id = `graph-${++build}`
          graphBuilds.push(id)
          return SessionRunnerModel.Service.of({
            resolve: (session) =>
              Effect.sync(() => {
                resolutions.push({
                  graph: id,
                  model: String(session.model?.id),
                  directory: session.location.directory,
                })
              }).pipe(
                Effect.as(
                  SessionRunnerModel.resolved(
                    session.model?.id === "handoff-fallback" ? fallback : primary,
                    {
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      cost: [],
                      limit: { context: 200_000, output: 32_000 },
                      variant: session.model?.variant,
                    },
                  ),
                ),
              ),
          })
        }),
      )
      const config = Config.testLayer([
        new Document({
          type: "document",
          info: new Info({ fallback: fallbackSelection }),
        }),
      ])

      const context = yield* Layer.buildWithScope(
        AppNodeBuilder.build(nodes, [
          Database.node.replace(Database.configured({ path: ":memory:" })),
          Global.node.replace(Layer.succeedContext(globalContext)),
          Bus.node.replace(Bus.configured({ persist: true })),
          offlineModels,
          LayerNodePlatform.llmClient.replace(Layer.succeedContext(llmContext)),
          SessionRunnerModel.node.replace(models),
          Config.node.replace(config),
          PluginSupervisor.node.replace(graphTools),
        ]),
        scope,
      )
      const sessions = Context.get(context, Session.Service)
      const execution = Context.get(context, SessionExecution.Service)
      const bus = Context.get(context, Bus.Service)
      const sessionID = Session.ID.make("ses_handoff_real")

      const created = yield* sessions.create({
        id: sessionID,
        location: sourceRef,
        title: "Handoff",
        model: Model.Ref.make(primarySelection()),
      })
      expect(created.location).toEqual(sourceRef)

      const retries = yield* Queue.unbounded<Event.Payload<typeof SessionEvent.RetryScheduled>>()
      yield* bus
        .subscribe(SessionEvent.RetryScheduled)
        .pipe(
          Stream.filter((event) => event.data.sessionID === sessionID),
          Stream.runForEach((event) => Queue.offer(retries, event)),
          Effect.forkScoped({ startImmediately: true }),
        )

      // Turn 1: primary fails, retry backoff selects the configured fallback X, and X returns a tool call. The move
      // is admitted while X's physical request is held, so the tool continuation hands the active turn to a new
      // Location graph with X already credited as attempted.
      yield* llm.push(
        Stream.fail(retryable()),
        TestLLM.toolCall("call-handoff", "echo", { text: "before move" }),
        Stream.fail(retryable()),
        TestLLM.text("After the move", "after-move"),
      )
      yield* sessions.prompt({ sessionID, text: "Start the handoff turn", resume: false })
      const firstTurn = yield* execution.resume(sessionID).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* llm.wait(1)
      yield* Queue.take(retries)
      const gate = yield* llm.gate()
      yield* TestClock.adjust(2_400)
      yield* gate.started
      expect(graphBuilds).toEqual(["graph-1"])

      yield* sessions.move({
        sessionID,
        directory: destinationRef.directory,
        delivery: "steer",
      })
      // The move resolves and builds the destination instance before the held fallback can complete.
      expect(graphBuilds).toEqual(["graph-1", "graph-2"])

      yield* gate.release
      // Request 3 is the carried continuation's next step in the destination graph, on the Session's primary model.
      yield* llm.wait(3)
      yield* Queue.take(retries)
      yield* TestClock.adjust(2_400)
      yield* Fiber.join(firstTurn)

      const requests = yield* llm.requests()
      expect(requests.map((request) => String(request.model.id))).toEqual([
        "handoff-primary",
        "handoff-fallback",
        "handoff-primary",
        "handoff-primary",
      ])
      // X was considered again in graph 2, but the carried attempted identity rejected it before dispatch.
      expect(resolutions.filter((entry) => entry.graph === "graph-2").map((entry) => entry.model)).toContain(
        "handoff-fallback",
      )
      expect(requests.slice(2).map((request) => String(request.model.id))).not.toContain("handoff-fallback")
      // X served the held attempt with its own variant attribution.
      expect(requests[1]?.model.options).toMatchObject({ providerOptions: { effort: "high" } })
      // The destination step itself resolved and dispatched through the new graph's runner.
      expect(resolutions).toContainEqual({
        graph: "graph-2",
        model: "handoff-primary",
        directory: destinationRef.directory,
      })

      // The settled tool result crossed the handoff with the assistant call that produced it.
      const contextMessages = yield* sessions.context(sessionID)
      const toolMessage = contextMessages.find(
        (message) =>
          message.type === "assistant" &&
          message.content.some((part) => part.type === "tool" && part.id === "call-handoff"),
      )
      expect(toolMessage).toMatchObject({
        model: { id: "handoff-fallback", providerID: "fake", variant: "high" },
        content: [
          {
            type: "tool",
            id: "call-handoff",
            state: { status: "completed", content: [{ type: "text", text: "before move" }] },
          },
        ],
      })
      const movedRequest = requests[2]!
      const callIndex = movedRequest.messages.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "tool-call" && part.id === "call-handoff"),
      )
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(movedRequest.messages[callIndex + 1]).toMatchObject({
        role: "tool",
        content: [{ type: "tool-result", id: "call-handoff" }],
      })

      // Turn 2 is genuinely new input, so the attempted set resets and X is eligible again.
      yield* llm.push(Stream.fail(retryable()), TestLLM.text("Fallback after new turn", "new-turn"))
      yield* sessions.prompt({ sessionID, text: "A genuinely new turn", resume: false })
      const secondTurn = yield* execution.resume(sessionID).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* llm.wait(5)
      yield* Queue.take(retries)
      yield* TestClock.adjust(2_400)
      yield* Fiber.join(secondTurn)

      const all = yield* llm.requests()
      expect(all.map((request) => String(request.model.id))).toEqual([
        "handoff-primary",
        "handoff-fallback",
        "handoff-primary",
        "handoff-primary",
        "handoff-primary",
        "handoff-fallback",
      ])
      expect(all[5]?.model.options).toMatchObject({ providerOptions: { effort: "high" } })
      expect(graphBuilds).toEqual(["graph-1", "graph-2"])
    }),
  30_000,
)
