import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { AIError, LanguageModel, LLMClient, TransportError, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { filesystem as platformFilesystem } from "@opencode/util/effect/app-node-platform"
import { withNamespace } from "@opencode/util/filesystem-provenance"
import { Config } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { ResourceCoordination } from "@opencode/core/effect/resource-coordination"
import { filesystemInjection } from "../../server/test/fixture/config-fs"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { verifyTlsCaMode } from "@opencode/util/tls-ca"
import { makeMemoryDriver } from "@opencode/core/environment/index"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Plugin } from "@opencode/plugin/effect"
import { makeDurableObjectStorage } from "../../core/test/fixture/durable-object-storage"
import { OpenCodeWorkerd } from "../src/effect/workerd"
import { Deferred, Effect, Exit, Fiber, FileSystem, Latch, Layer, Option, Schedule, Stream } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import type { OpenCodeEvent } from "../src/effect"
import type { SdkInstances } from "../src/internal/instances"

// Every host built here goes through the server route graph, whose server-info layer reads the verified TLS CA
// mode. Naming it here keeps this file correct when it runs alone rather than relying on another file's load order.
verifyTlsCaMode("bundled")

const it = testEffect(Layer.empty)
type Sdk = typeof import("../src/effect")
type Fixture = { readonly directory: string; readonly sdk: Sdk }

const withEmbedded = <A, E, R>(prefix: string, f: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(prefix)),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((directory) =>
      Effect.promise(() => import("../src/effect")).pipe(
        Effect.flatMap((sdk) => f({ directory: directory.path, sdk })),
      ),
    ),
  )

const sessionID = (fixture: Fixture) => fixture.sdk.Session.ID.create()

const location = (fixture: Fixture) =>
  fixture.sdk.Location.Ref.make({ directory: fixture.sdk.AbsolutePath.make(fixture.directory) })

// The fallback a protected reader sees for the ONE durable document under test, taken from that host's own
// entries. Keyed by the document's path: a seeded `content` document is virtual and carries no fallback.
const fileFallback = (entries: ReadonlyArray<Config.Entry>, document: string) =>
  entries
    .filter(
      (entry): entry is Config.Document =>
        entry.type === "document" && String((entry as { readonly path?: unknown }).path ?? "") === document,
    )
    .at(-1)?.info.fallback

// The server doesn't wait for plugins, so an SDK caller waits until the plugin-provided entry it needs is loaded.
// Activation takes milliseconds here; the cap stays well inside the 5s test timeout so a miss fails with its name.
const loaded = <A, E, R>(name: string, read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until: ready, schedule: Schedule.spaced("10 millis") }),
    Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.die(new Error(`${name} never loaded`)) }),
    Effect.andThen(read),
  )

for (const selection of ["explicit", "default"] as const) {
  it.live(`generate.text uses configured providers with ${selection} model selection`, () =>
    withEmbedded("opencode-embedded-generate-", (fixture) =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test.pipe(
          Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") })),
        )
        const opencode = yield* fixture.sdk.OpenCode.create(
          {
            config: {
              directory: fixture.directory,
              project: false,
              content: JSON.stringify({
                model: "custom/fictional-chat",
                providers: {
                  custom: {
                    package: "aisdk:@ai-sdk/openai-compatible",
                    settings: { baseURL: "https://provider.example/v1" },
                    models: { "fictional-chat": {} },
                  },
                },
              }),
            },
            models: { fetch: false },
            fs: { filewatcher: false },
          },
          {
            overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
          },
        )
        yield* loaded("custom/fictional-chat", opencode.model.list({ location: location(fixture) }), (models) =>
          models.data.some((model) => model.providerID === "custom" && model.id === "fictional-chat"),
        )

        const result = yield* opencode.experimental.generate.text({
          prompt: "Say ready",
          ...(selection === "explicit"
            ? {
                model: fixture.sdk.Model.Ref.make({
                  providerID: fixture.sdk.Provider.ID.make("custom"),
                  id: fixture.sdk.Model.ID.make("fictional-chat"),
                }),
              }
            : {}),
        })

        expect(result.text).toBe("ready")
        const requests = yield* llm.requests()
        expect(requests).toHaveLength(1)
        expect(requests[0]?.model).toMatchObject({ provider: "custom", id: "fictional-chat" })
      }),
    ),
  )
}

it.live("seeds host plugins from CreateOptions and loads delayed model plugins without self-deadlock", () =>
  withEmbedded("opencode-embedded-seeded-plugin-", (fixture) =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Test.pipe(
        Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") })),
      )
      const listedDuringSetup: number[] = []
      const plugin = Plugin.define({
        id: "seeded-models",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* Effect.sleep("25 millis")
            const before = yield* ctx.model.list()
            listedDuringSetup.push(before.data.length)
            yield* ctx.provider.transform((providers) => {
              providers.update(fixture.sdk.Provider.ID.make("seeded"), (provider) => {
                provider.name = "Seeded Provider"
                provider.activation = "enabled"
                provider.package = "@opencode/ai/providers/openai-compatible"
                provider.settings = { baseURL: "https://provider.example/v1", apiKey: "secret" }
              })
              providers.models.update(
                fixture.sdk.Provider.ID.make("seeded"),
                fixture.sdk.Model.ID.make("fictional-chat"),
                (model) => {
                  model.name = "Seeded Fictional Chat"
                },
              )
            })
          }).pipe(Effect.orDie),
      })
      const opencode = yield* fixture.sdk.OpenCode.create(
        {
          config: {
            directory: fixture.directory,
            project: false,
            content: JSON.stringify({ model: "seeded/fictional-chat" }),
          },
          models: { fetch: false },
          fs: { filewatcher: false },
          plugins: [plugin],
        },
        {
          overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
        },
      )

      const defaultModel = yield* loaded(
        "seeded model",
        opencode.model.default({ location: location(fixture) }),
        (model) => model.data?.providerID === "seeded",
      )
      const generated = yield* opencode.experimental.generate.text({ prompt: "Say ready" })

      expect(listedDuringSetup.length).toBeGreaterThan(0)
      expect(defaultModel.data).toMatchObject({
        providerID: "seeded",
        id: "fictional-chat",
        name: "Seeded Fictional Chat",
      })
      expect(generated.text).toBe("ready")
    }),
  ),
)

it.live("OpenCodeWorkerd seeds plugins before cold model resolution", () =>
  withEmbedded("opencode-workerd-seeded-plugin-", (fixture) =>
    Effect.gen(function* () {
      const opencode = yield* OpenCodeWorkerd.create({
        storage: makeDurableObjectStorage(),
        models: { fetch: false },
        config: { model: "workerd-seeded/fictional-chat" },
        plugins: [
          Plugin.define({
            id: "workerd-seeded-models",
            effect: (ctx) =>
              Effect.gen(function* () {
                yield* Effect.sleep("20 millis")
                yield* ctx.model.list()
                yield* ctx.provider.transform((providers) => {
                  providers.update(fixture.sdk.Provider.ID.make("workerd-seeded"), (provider) => {
                    provider.name = "Workerd Seeded"
                    provider.activation = "enabled"
                    provider.package = "@opencode/ai/providers/openai-compatible"
                    provider.settings = { baseURL: "https://provider.example/v1", apiKey: "secret" }
                  })
                  providers.models.update(
                    fixture.sdk.Provider.ID.make("workerd-seeded"),
                    fixture.sdk.Model.ID.make("fictional-chat"),
                    () => {},
                  )
                })
              }).pipe(Effect.orDie),
          }),
        ],
      })

      const selected = yield* loaded(
        "workerd-seeded model",
        opencode.model.default({
          location: fixture.sdk.Location.Ref.make({ directory: fixture.sdk.AbsolutePath.make("/workspace") }),
        }),
        (model) => model.data?.providerID === "workerd-seeded",
      )
      expect(selected.data).toMatchObject({
        providerID: "workerd-seeded",
        id: "fictional-chat",
      })
    }),
  ),
)

it.live(
  "embedded client uses the real router and handlers",
  () =>
    withEmbedded("opencode-embedded-", (fixture) =>
      Effect.gen(function* () {
        const opencode = yield* fixture.sdk.OpenCode.create({ events: { persist: true } })
        const id = sessionID(fixture)
        const model = fixture.sdk.Model.Ref.make({
          id: fixture.sdk.Model.ID.make("embedded"),
          providerID: fixture.sdk.Provider.ID.make("test"),
        })

        const created = yield* opencode.sessions.create({
          id,
          agent: fixture.sdk.Agent.ID.make("build"),
          location: location(fixture),
        })
        yield* opencode.sessions.switchModel({ sessionID: id, model })
        const selected = yield* opencode.sessions.get({ sessionID: id })
        const page = yield* opencode.sessions.list({ directory: fixture.sdk.AbsolutePath.make(fixture.directory) })
        const active = yield* opencode.sessions.active()
        const admitted = yield* opencode.sessions.prompt({
          sessionID: id,
          text: "Do not run",
          resume: false,
        })
        const context = yield* opencode.sessions.context({ sessionID: id })
        const pendingAfterAdmit = yield* opencode.sessions.inbox.list({ sessionID: id })
        yield* opencode.experimental.session.instructions.entry.put({ sessionID: id, key: "deploy-target", value: "production" })
        yield* opencode.experimental.session.instructions.entry.put({ sessionID: id, key: "flags", value: { beta: true } })
        const contextEntries = yield* opencode.experimental.session.instructions.entry.list({ sessionID: id })
        yield* opencode.experimental.session.instructions.entry.remove({ sessionID: id, key: "flags" })
        const remainingContextEntries = yield* opencode.experimental.session.instructions.entry.list({ sessionID: id })
        const wake = yield* opencode.sessions.prompt({
          sessionID: id,
          text: "Promote this input",
        })
        const prompted = yield* opencode.experimental.session.log({ sessionID: id, follow: true }).pipe(
          Stream.filter((event) => event.type === "session.inbox.delivered" && event.data.inboxID === wake.id),
          Stream.runHead,
          Effect.timeout("10 seconds"),
          Effect.map(Option.getOrThrow),
        )
        const wakeContext = yield* opencode.sessions.context({ sessionID: id })
        const pendingAfterPromote = yield* opencode.sessions.inbox.list({ sessionID: id })
        const event = yield* opencode.experimental.session.log({ sessionID: id }).pipe(
          Stream.filter((item) => item.type === "session.model.selected"),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        )
        const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
          Option.getOrThrow,
        )
        const message = yield* opencode.sessions.message.get({ sessionID: id, messageID: modelMessage.id })
        yield* opencode.sessions.interrupt({ sessionID: id })
        const other = yield* opencode.sessions.create({ location: location(fixture) })
        const missingSessionID = fixture.sdk.Session.ID.create()
        const missing = yield* Effect.all(
          [
            opencode.experimental.session.log({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
            opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
            opencode.sessions.message.get({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
            opencode.experimental.session.instructions.entry.list({ sessionID: missingSessionID }).pipe(Effect.flip),
            opencode.sessions.inbox.list({ sessionID: missingSessionID }).pipe(Effect.flip),
          ],
          { concurrency: "unbounded" },
        )
        const missingMessage = yield* Effect.flip(
          opencode.sessions.message.get({
            sessionID: other.id,
            messageID: modelMessage.id,
          }),
        )

        expect(created.id).toBe(id)
        expect(selected.model?.id).toBe(model.id)
        expect(selected.model?.providerID).toBe(model.providerID)
        expect(page.data.some((session) => session.id === id)).toBe(true)
        expect(active).toEqual({})
        expect(admitted.sessionID).toBe(id)
        expect(pendingAfterAdmit).toContainEqual(
          expect.objectContaining({ id: admitted.id, type: "user", delivery: "steer" }),
        )
        expect(prompted.type).toBe("session.inbox.delivered")
        expect(pendingAfterPromote.map((item) => item.id)).not.toContainAnyValues([admitted.id, wake.id])
        expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
        expect(contextEntries).toEqual([
          { key: "deploy-target", value: "production" },
          { key: "flags", value: { beta: true } },
        ])
        expect(remainingContextEntries).toEqual([{ key: "deploy-target", value: "production" }])
        expect(context.some((message) => message.type === "model-switched")).toBe(true)
        expect(event).toMatchObject({ type: "session.model.selected", durable: { seq: 1 } })
        expect(message).toEqual(modelMessage)
        expect(missing.map((error) => error._tag)).toEqual([
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
        ])
        expect(missingMessage._tag).toBe("MessageNotFoundError")
      }),
    ),
  10_000,
)

it.live("embedded client exposes plugin-backed web search", () =>
  withEmbedded("opencode-embedded-websearch-", (fixture) =>
    Effect.gen(function* () {
      const opencode = yield* fixture.sdk.OpenCode.create()
      const providerID = fixture.sdk.WebSearch.ID.make("embedded-websearch")
      yield* opencode.plugin({
        id: `embedded-websearch-${crypto.randomUUID()}`,
        effect: (ctx) =>
          ctx.websearch.transform((editor) => {
            editor.add({
              id: providerID,
              name: "Embedded web search",
              execute: (input) =>
                Effect.succeed([{ url: "https://example.com", content: `Found ${input.query}`, time: {} }]),
            })
          }),
      })
      yield* loaded(
        "embedded-websearch provider",
        opencode.websearch.providers({ location: location(fixture) }),
        (providers) => providers.data.some((provider) => provider.id === providerID),
      )

      const result = yield* opencode.websearch.query({
        query: "opencode",
        providerID,
        location: location(fixture),
      })

      expect(result.data).toEqual({
        providerID,
        results: [{ url: "https://example.com", content: "Found opencode", time: {} }],
      })
    }),
  ),
)

it.live(
  "Location-owned runner events reach the ready global client",
  () =>
    withEmbedded("opencode-embedded-events-", (fixture) =>
      Effect.gen(function* () {
        const opencode = yield* fixture.sdk.OpenCode.create()
        const id = sessionID(fixture)
        const connected = yield* Latch.make(false)
        const prompted = yield* Deferred.make<Extract<OpenCodeEvent, { type: "session.inbox.delivered" }>>()

        yield* opencode.events.subscribe().pipe(
          Stream.runForEach((event) =>
            event.type === "server.connected"
              ? connected.open
              : event.type === "session.inbox.delivered" && event.data.sessionID === id
                ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        )
        yield* connected.await
        yield* opencode.sessions.create({ id, location: location(fixture) })
        yield* opencode.sessions.prompt({
          sessionID: id,
          text: "Observe this input",
        })

        const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
        expect(event.durable).toEqual(expect.objectContaining({ aggregateID: id, seq: expect.any(Number) }))
      }),
    ),
  10_000,
)

it.live(
  "independent embedded hosts do not share live notifications",
  () =>
    withEmbedded("opencode-embedded-hosts-", (fixture) =>
      Effect.gen(function* () {
        const first = yield* fixture.sdk.OpenCode.create()
        const second = yield* fixture.sdk.OpenCode.create()
        const id = sessionID(fixture)
        const firstReady = yield* Latch.make(false)
        const secondReady = yield* Latch.make(false)
        const firstEvent = yield* Latch.make(false)
        const secondEvent = yield* Latch.make(false)
        const observe = (ready: Latch.Latch, event: Latch.Latch) =>
          Stream.runForEach((notification: OpenCodeEvent) =>
            notification.type === "server.connected"
              ? ready.open
              : notification.type === "session.agent.selected" && notification.data.sessionID === id
                ? event.open
                : Effect.void,
          )

        yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
        yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
        yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
        yield* first.sessions.create({ id, location: location(fixture) })
        yield* first.sessions.switchAgent({ sessionID: id, agent: fixture.sdk.Agent.ID.make("plan") })

        yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
        expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
      }),
    ),
  10_000,
)

it.live("embedded client is available as a Layer service", () =>
  withEmbedded("opencode-embedded-layer-", (fixture) => {
    const id = sessionID(fixture)
    return Effect.gen(function* () {
      const opencode = yield* fixture.sdk.OpenCode.Service
      const created = yield* opencode.sessions.create({ id, location: location(fixture) })
      expect(created.id).toBe(id)
    }).pipe(Effect.provide(fixture.sdk.OpenCode.layer()))
  }),
)

it.live("configures workspace providers through the SDK facade", () =>
  withEmbedded("opencode-embedded-workspace-", (fixture) =>
    Effect.gen(function* () {
      const calls: Array<{ readonly operation: string; readonly workspaceID: string }> = []
      const driver = WorkspaceDriver.make({
        create: ({ workspaceID }) => {
          calls.push({ operation: "create", workspaceID })
          return Effect.succeed({ binding: { externalID: workspaceID } })
        },
        connect: ({ workspaceID }) => {
          calls.push({ operation: "connect", workspaceID })
          return Effect.succeed(makeMemoryDriver())
        },
        suspendForIdle: () => Effect.void,
        destroy: ({ workspaceID }) => {
          calls.push({ operation: "destroy", workspaceID })
          return Effect.void
        },
      })
      const opencode = yield* fixture.sdk.OpenCode.create({ workspaceProviders: { fake: driver } })
      const requestedID = fixture.sdk.Workspace.ID.create()
      const workspaceID = yield* opencode.workspace.create({ id: requestedID, provider: "fake" })

      expect(workspaceID).toBe(requestedID)
      expect(yield* opencode.workspace.create({ id: requestedID, provider: "fake" })).toBe(requestedID)
      expect(calls).toEqual([])

      const workspace = yield* opencode.workspace.provision({ workspaceID })

      expect(workspace.provider).toBe("fake")
      expect(workspace.binding).toEqual({ externalID: workspace.id })
      expect(calls).toEqual([{ operation: "create", workspaceID: workspace.id }])

      const workspaceLocation = fixture.sdk.Location.Ref.make({
        directory: fixture.sdk.AbsolutePath.make("/"),
        workspaceID: workspace.id,
      })
      const session = yield* opencode.sessions.create({ location: workspaceLocation })
      expect(session.location.workspaceID).toBe(workspace.id)

      expect(yield* opencode.workspace.destroy({ workspaceID: workspace.id })).toEqual({ destroyed: true })
      expect(calls.map((call) => call.operation)).toEqual(["create", "destroy"])
      expect(yield* opencode.workspace.destroy({ workspaceID: workspace.id })).toEqual({ destroyed: false })
      expect(calls.map((call) => call.operation)).toEqual(["create", "destroy"])
    }),
  ),
)

const workspaceModelScenario = (fixture: Fixture, policy: "eager" | "lazy") =>
  Effect.gen(function* () {
    const calls: string[] = []
    const createStarted = yield* Deferred.make<void>()
    const createRelease = yield* Deferred.make<void>()
    const modelStarted = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(createRelease, undefined).pipe(Effect.asVoid))
    const model = LanguageModel.make({ id: "workspace-test", provider: "test", route: OpenAIChat.route })
    const client = TestLLM.testLayer({
      fallback: TestLLM.text("ready", "answer"),
      transformRequest: (request) => {
        Deferred.doneUnsafe(modelStarted, Effect.void)
        return request
      },
    })
    const models = Layer.mock(SessionRunnerModel.Service, {
      resolve: () =>
        Effect.succeed(
          SessionRunnerModel.resolved(model, {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 100_000, output: 1_000 },
          }),
        ),
    })
    const driver = WorkspaceDriver.make({
      create: ({ workspaceID }) => {
        calls.push("create")
        return Deferred.succeed(createStarted, undefined).pipe(
          Effect.andThen(Deferred.await(createRelease)),
          Effect.as({ binding: { workspaceID } }),
        )
      },
      connect: () => {
        calls.push("connect")
        return Effect.succeed(makeMemoryDriver())
      },
      suspendForIdle: () => Effect.void,
      destroy: () => Effect.void,
    })
    const configDirectory = path.join(fixture.directory, "config")
    yield* Effect.promise(() => fs.mkdir(configDirectory))
    const opencode = yield* fixture.sdk.OpenCode.create(
      {
        config: { directory: configDirectory, project: false, content: "{}" },
        workspaceProviders: { fake: driver },
      },
      {
        overrides: [llmClient.replace(client), SessionRunnerModel.node.replace(models)],
      },
    )
    const workspaceID = yield* opencode.workspace.create({ provider: "fake" })
    const provisioning =
      policy === "eager"
        ? yield* opencode.workspace.provision({ workspaceID }).pipe(Effect.forkScoped({ startImmediately: true }))
        : undefined
    if (provisioning) {
      yield* Deferred.await(createStarted).pipe(
        Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("provider create did not start") }),
      )
    }

    const session = yield* opencode.sessions.create({
      location: fixture.sdk.Location.Ref.make({
        directory: fixture.sdk.AbsolutePath.make(fixture.directory),
        workspaceID,
      }),
    })
    yield* opencode.sessions.prompt({ sessionID: session.id, text: "Answer without using tools" })
    yield* Deferred.await(modelStarted).pipe(
      Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("model stream did not start") }),
    )

    if (!provisioning) {
      expect(calls).toEqual([])
      return
    }
    expect(provisioning.pollUnsafe()).toBeUndefined()
    expect(calls).toEqual(["create"])
    yield* Deferred.succeed(createRelease, undefined)
    expect((yield* Fiber.join(provisioning)).binding).toEqual({ workspaceID })
    expect(calls).toEqual(["create"])
  })

it.live(
  "starts model execution while eager workspace provisioning is blocked",
  () => withEmbedded("opencode-embedded-workspace-eager-", (fixture) => workspaceModelScenario(fixture, "eager")),
  15_000,
)

it.live(
  "starts model execution without provisioning a lazy workspace",
  () => withEmbedded("opencode-embedded-workspace-lazy-", (fixture) => workspaceModelScenario(fixture, "lazy")),
  15_000,
)

it.live(
  "blocks the model-selected first tool on lazy provisioning",
  () =>
    withEmbedded("opencode-embedded-workspace-tool-", (fixture) =>
      Effect.gen(function* () {
        const calls: string[] = []
        const createStarted = yield* Deferred.make<void>()
        const createRelease = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(createRelease, undefined).pipe(Effect.asVoid))
        const model = LanguageModel.make({ id: "workspace-tool-test", provider: "test", route: OpenAIChat.route })
        // The first tool-advertising request selects the shell tool; everything else
        // (including title generation, which carries no tools) answers with text.
        let toolIssued = false
        const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
        yield* llm.serve((request) => {
          const wantsTool = !toolIssued && request.tools.some((tool) => tool.name === "shell")
          if (!wantsTool) return TestLLM.text("done", "answer")
          toolIssued = true
          return TestLLM.toolCall("call-shell", "shell", { command: "echo hi" })
        })
        const models = Layer.mock(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(model, {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 100_000, output: 1_000 },
              }),
            ),
        })
        const driver = WorkspaceDriver.make({
          create: ({ workspaceID }) => {
            calls.push("create")
            return Deferred.succeed(createStarted, undefined).pipe(
              Effect.andThen(Deferred.await(createRelease)),
              Effect.as({ binding: { workspaceID } }),
            )
          },
          connect: () => {
            calls.push("connect")
            return Effect.succeed(makeMemoryDriver())
          },
          suspendForIdle: () => Effect.void,
          destroy: () => Effect.void,
        })
        const configDirectory = path.join(fixture.directory, "config")
        yield* Effect.promise(() => fs.mkdir(configDirectory))
        const opencode = yield* fixture.sdk.OpenCode.create(
          {
            config: { directory: configDirectory, project: false, content: "{}" },
            workspaceProviders: { fake: driver },
          },
          {
            overrides: [
              llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
              SessionRunnerModel.node.replace(models),
            ],
          },
        )
        const workspaceID = yield* opencode.workspace.create({ provider: "fake" })
        const session = yield* opencode.sessions.create({
          location: fixture.sdk.Location.Ref.make({
            directory: fixture.sdk.AbsolutePath.make(fixture.directory),
            workspaceID,
          }),
        })
        expect(calls).toEqual([])

        yield* opencode.sessions.prompt({ sessionID: session.id, text: "Run echo" })
        // The model-selected shell tool is the first execution-plane demand: it alone
        // starts provisioning and blocks inside the tool call until the provider is ready.
        yield* Deferred.await(createStarted).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("first tool did not provision") }),
        )
        expect(calls).toEqual(["create"])

        yield* Deferred.succeed(createRelease, undefined)
        yield* opencode.experimental.session.wait({ sessionID: session.id })
        // Provisioning settled, the workspace connected, and the turn completed. The
        // memory driver rejects the actual spawn, which surfaces to the model as an
        // ordinary tool error before the final text response.
        expect(calls).toEqual(["create", "connect"])
        expect(toolIssued).toBe(true)
      }),
    ),
  15_000,
)

it.live("preserves unknown workspace provider errors", () =>
  withEmbedded("opencode-embedded-workspace-provider-", (fixture) =>
    Effect.gen(function* () {
      const opencode = yield* fixture.sdk.OpenCode.create()
      const error = yield* opencode.workspace.create({ provider: "missing" }).pipe(Effect.flip)
      expect(error).toEqual(new WorkspaceDriver.ProviderNotFound({ provider: "missing" }))
    }),
  ),
)

/**
 * The borrowed pair the route graph holds for one config directory, taken back out of the production registry.
 *
 * Same identity inputs (the same recorded filesystem layer, the same spelled directory) must yield the SAME live pair
 * the hosts use, which is what makes `admission.observation` an authoritative read of production's queue rather than
 * of a fixture's bookkeeping. If either host had an unshared pair, this observation would stay empty forever.
 */
const resourcePair = (
  configDirectory: string,
  filesystemLayer: Layer.Layer<FileSystem.FileSystem>,
) =>
  FSUtil.Service.pipe(
    Effect.flatMap((util) => FSUtil.identifyConfigResource(util, configDirectory)),
    Effect.flatMap((identity) => ResourceCoordination.borrow(identity.namespace, identity.directoryKey)),
    Effect.provide(FSUtil.layer),
    Effect.provide(filesystemLayer),
  )

/**
 * Cross-host Config resource coordination, through the public SDK only.
 *
 * Two hosts over ONE config directory must share one admission and one fallback-intent owner, because both write the
 * same durable document. A parked generation in host A therefore withholds host B's durable commit, and nothing here
 * injects either owner: the sharing has to come from the route graph's own resource borrow. A/B/C ordering,
 * cancellation and disposal each get their own case below, and every wait is a Deferred or a recorded operation
 * the production path itself resolves.
 */
it.live(
  "withholds one host's durable config commit while another host on the same directory holds a generation lease",
  () =>
    withEmbedded("opencode-embedded-config-resource-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        // The real-filesystem recorder, injected the way the server's own wire tests do, so a rename is proof that
        // the production writer reached its commit boundary rather than a mock claiming to.
        const hostOverrides = [platformFilesystem.replace(injection.layer)]

        // Host A parks inside its own provider request, which runs in the drain that run-coordinator.ts:119 wraps
        // in `acquireShared`: the lease it holds is production's, and its terminal is what releases it.
        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)
        const second = yield* writerHost(fixture, configDirectory, hostOverrides)

        // Both protected readers are warm BEFORE the competing write. A fresh GET after the commit alone cannot
        // prove cross-host reconciliation of an already-loaded Config owner, so these same two hosts read here.
        const beforeFirst = yield* a.opencode.config.get({ location: location(fixture) })
        const beforeSecond = yield* second.config.get({ location: location(fixture) })
        expect(fileFallback(beforeFirst, document)).toBeUndefined()
        expect(fileFallback(beforeSecond, document)).toBeUndefined()

        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
        const renamesAt = renames()
        const tempsAt = temps()
        const readsAt = injection.readCount(document)
        // Production's own queue, read through the pair the route graph borrowed for this resource. A fresh pair
        // would report nothing here, so an unshared pair in either host makes the waits below time out instead of
        // passing quietly.
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive
        expect((yield* pair.admission.observation).sharedReaders, "A holds no production shared lease").toBe(1)

        const queued = yield* Effect.forkScoped(
          second.experimental.config.update({
            fallback: { providerID: "test", model: "cross-host", variant: "high" },
          }),
        )
        // The candidate read is B's own validation, which precedes admission: reaching it proves B entered Config's
        // owner, and what follows is the only remaining gate before the rename.
        yield* injection.awaitedReads(document, readsAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never reached its config owner"),
          }),
        )
        expect(renames()).toBe(renamesAt)
        expect(temps()).toBe(tempsAt)
        expect(queued.pollUnsafe()).toBeUndefined()
        // One read only: the re-validation that follows the exclusive grant has not run, so B is queued at the
        // admission A still holds, not merely slow elsewhere.
        expect(injection.readCount(document)).toBe(readsAt + 1)
        // The queue itself, not an inference: production reports B parked in the exclusive queue with A's lease the
        // only live holder, and no exclusive grant handed out yet.
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never entered production's exclusive queue"),
          }),
        )
        const parked = yield* pair.admission.observation
        // Authoritative enqueue, not an inference: production reports an exclusive acquisition entered THIS admission
        // with A's shared lease the only holder and no exclusive grant handed out yet.
        expect(parked.enqueuedExclusive).toBeGreaterThanOrEqual(enqueuedAt + 1)
        expect(parked.grantedExclusive).toBe(enqueuedAt)
        expect(parked.writer).toBe(false)
        expect(parked.sharedReaders).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')

        // A's terminal releases its lease, so B's exclusive grant follows and its own re-validation runs.
        yield* a.gate.release
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(Effect.timeout("8 seconds"))
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("queued B never committed") }),
        )
        expect(renames()).toBe(renamesAt + 1)
        expect(temps()).toBe(tempsAt + 1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "cross-host"')
        // The queue is drained: the grant eventually reached the withheld writer, A's lease is gone, and no waiter
        // of the withheld window is left behind.
        const settled = yield* pair.admission.observation
        expect(settled.grantedExclusive).toBeGreaterThanOrEqual(enqueuedAt + 1)
        expect(settled.queuedExclusive).toBe(0)
        expect(settled.writer).toBe(false)
        expect(settled.sharedReaders).toBe(0)
        // The single rename consumed the single temp file: no orphan, no second writer.
        expect(injection.calls.renames.filter(([, to]) => to === document)[renamesAt]![0]).toBe(
          injection.calls.writes.filter((write) => write.path.includes(".tmp"))[tempsAt]!.path,
        )

        // Both hosts' warmed protected reads see the committed document, which is the shared intent owner's job:
        // neither graph was rebuilt for this.
        const inFirst = yield* a.opencode.config.get({ location: location(fixture) })
        const inSecond = yield* second.config.get({ location: location(fixture) })
        expect(fileFallback(inFirst, document)).toMatchObject({ model: "cross-host" })
        expect(fileFallback(inSecond, document)).toMatchObject({ model: "cross-host" })
      }),
    ),
  20_000,
)

it.live(
  "coordinates only the same config resource: a host on another directory commits while the first holds its lease",
  () =>
    withEmbedded("opencode-embedded-config-resource-isolation-", (fixture) =>
      Effect.gen(function* () {
        const firstDirectory = path.join(fixture.directory, "config-a")
        const secondDirectory = path.join(fixture.directory, "config-b")
        const firstDocument = path.join(firstDirectory, "opencode.jsonc")
        const secondDocument = path.join(secondDirectory, "opencode.jsonc")
        yield* Effect.promise(() =>
          Promise.all([
            fs.mkdir(firstDirectory, { recursive: true }),
            fs.mkdir(secondDirectory, { recursive: true }),
          ]),
        )
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(firstDocument, `{ "shell": "bash" }\n`),
            fs.writeFile(secondDocument, `{ "shell": "bash" }\n`),
          ]),
        )
        const injection = filesystemInjection()
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        // A parks in its own provider request, in the OTHER config resource.
        const a = yield* parkedHost(fixture, firstDirectory, hostOverrides)
        const second = yield* writerHost(fixture, secondDirectory, hostOverrides)

        const renames = () => injection.calls.renames.filter(([, to]) => to === secondDocument).length
        // A's generation is still in flight: its terminal has not been reached, so its shared lease is still open
        // while this other resource's writer commits.
        const holding = yield* Effect.forkScoped(a.opencode.experimental.session.wait({ sessionID: a.session.id }))
        yield* second.experimental.config.update({
          fallback: { providerID: "test", model: "other-resource", variant: "high" },
        })
        expect(holding.pollUnsafe(), "A's generation settled early").toBeUndefined()
        // Coordination is keyed by resource, never process-wide: a lease in one config resource cannot withhold
        // a writer of another one.
        expect(renames(), JSON.stringify(injection.calls.renames)).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(secondDocument, "utf8"))).toContain('"model": "other-resource"')
        // The other resource's document was never touched, and its host's config view carries no leaked intent.
        expect(injection.calls.renames.filter(([, to]) => to === firstDocument).length).toBe(0)
        const inFirst = yield* a.opencode.config.get({ location: location(fixture) })
        expect(fileFallback(inFirst, firstDocument)).toBeUndefined()
        expect(yield* Effect.promise(() => fs.readFile(firstDocument, "utf8"))).toContain('"shell": "bash"')
      }),
    ),
  20_000,
)

/** Config content that selects a deterministic fictional model, so a session turn reaches the test provider. */
const modelContent = JSON.stringify({
  model: "custom/fictional-chat",
  providers: {
    custom: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://provider.example/v1" },
      models: { "fictional-chat": {}, "fallback-chat": { variants: [{ id: "high", settings: { temperature: 0.317 } }] } },
    },
  },
})

/**
 * A host parked inside its provider request, so the shared lease it holds is production's own and stays open until
 * the caller opens the gate. The park is the model request itself, which runs in the drain that
 * `run-coordinator.ts:119` wraps in `acquireShared`.
 */
const parkedHost = Effect.fnUntraced(function* (
  fixture: Fixture,
  configDirectory: string,
  overrides: LayerNode.Replacements = [],
  // When given, this responder answers THIS host's provider requests from the very first arrival, so a test can
  // make the first attempt of a specific request fail and later ones succeed. TestLLM picks the response AT arrival,
  // which is why the responder is installed before the prompt is sent rather than after.
  responder?: (request: LLMRequest) => TestLLM.Response,
  prompt = "Hold the lease",
) {
  const llm = yield* TestLLM.Test.pipe(
    Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") })),
  )
  const gate = yield* llm.gate()
  if (responder !== undefined) yield* llm.serve(responder)
  const opencode = yield* fixture.sdk.OpenCode.create(
    {
      config: { directory: configDirectory, project: false, content: modelContent },
      models: { fetch: false },
      fs: { filewatcher: false },
    },
    {
      overrides: [...overrides, llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
    },
  )
  const session = yield* opencode.sessions.create({ location: location(fixture) })
  yield* opencode.sessions.prompt({ sessionID: session.id, text: prompt })
  yield* gate.started.pipe(
    Effect.timeoutOrElse({
      duration: "4 seconds",
      orElse: () => Effect.die("host never reached its provider request"),
    }),
  )
  return { opencode, session, llm, gate }
})

/** An ordinary host with no session, writing to one config directory through the recorded filesystem. */
const writerHost = (
  fixture: Fixture,
  configDirectory: string,
  overrides: LayerNode.Replacements,
) =>
  fixture.sdk.OpenCode.create(
    {
      config: { directory: configDirectory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
    },
    { overrides },
  )

/**
 * A host whose session has been PROMPTED but which has not been observed reaching its provider request: the forked
 * arrival watcher is the observation, so a withheld generation is proven by that watcher never completing.
 * `instances` builds the host through the SDK's private selector, so its session operations run in the instance
 * `configure` reconstructs rather than in the host's own location graph.
 */
const generationHost = Effect.fnUntraced(function* (
  fixture: Fixture,
  configDirectory: string,
  overrides: LayerNode.Replacements = [],
  instances?: SdkInstances.Options,
) {
  const llm = yield* TestLLM.Test.pipe(
    Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") })),
  )
  const gate = yield* llm.gate()
  const opencode = yield* fixture.sdk.OpenCode.create(
    {
      config: { directory: configDirectory, project: false, content: modelContent },
      models: { fetch: false },
      fs: { filewatcher: false },
      ...(instances === undefined ? {} : { instances }),
    },
    {
      overrides: [...overrides, llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
    },
  )
  const session = yield* opencode.sessions.create({ location: location(fixture) })
  yield* opencode.sessions.prompt({ sessionID: session.id, text: "Blocked by the held grant" })
  const arrived = yield* Deferred.make<void>()
  const started = yield* Effect.forkScoped(
    gate.started.pipe(Effect.tap(() => Deferred.succeed(arrived, undefined)), Effect.asVoid),
  )
  const entered = Deferred.await(arrived)
  return { opencode, session, llm, gate, started, entered }
})

it.live(
  "interrupting a live host's active session releases its lease so the queued writer commits, then it generates again",
  () =>
    withEmbedded("opencode-embedded-config-resource-interrupt-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]

        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)
        const b = yield* writerHost(fixture, configDirectory, hostOverrides)

        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
        const renamesAt = renames()
        const tempsAt = temps()
        const readsAt = injection.readCount(document)

        const queued = yield* Effect.forkScoped(
          b.experimental.config.update({ fallback: { providerID: "test", model: "interrupted-release" } }),
        )
        yield* injection.awaitedReads(document, readsAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never reached its config owner"),
          }),
        )
        expect(renames()).toBe(renamesAt)
        expect(temps()).toBe(tempsAt)
        expect(queued.pollUnsafe()).toBeUndefined()

        // Cancellation of the SESSION, not the host: A stays live and reports its own interruption.
        const interrupt = yield* a.opencode.sessions.interrupt({ sessionID: a.session.id })
        expect(interrupt.interrupted).toBe(true)

        // A's terminal settlement releases the lease, and B's queued exclusive grant follows in the same resource.
        // Opening the gate also lets any later request through; the interrupted request never resumes.
        yield* a.gate.release
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("A's interrupted generation never settled"),
          }),
        )
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("queued B never committed"),
          }),
        )
        expect(renames()).toBe(renamesAt + 1)
        expect(temps()).toBe(tempsAt + 1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "interrupted-release"')

        // A is still a working host: a second generation reaches a terminal and reaches the provider.
        yield* a.opencode.sessions.prompt({ sessionID: a.session.id, text: "Generate again" })
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("A's second generation never settled"),
          }),
        )
        const requests = yield* a.llm.requests()
        expect(requests.length).toBeGreaterThan(0)
        expect((yield* Effect.promise(() => fs.readdir(configDirectory))).filter((name) => name.startsWith("."))).toEqual(
          [],
        )
      }),
    ),
  25_000,
)

it.live(
  "closing host A's own scope releases only its borrowed reference, so the queued writer commits and stays usable",
  () =>
    withEmbedded("opencode-embedded-config-dispose-a-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive

        const writer = yield* writerHost(fixture, configDirectory, hostOverrides)
        const readsAt = injection.readCount(document)

        // A's generation is parked at its provider request inside the scope below: its lease is open and its terminal
        // is never reached. The writer's update runs DETACHED, so leaving this scope disposes only A's own host and
        // cannot cancel the writer's request.
        const queued = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* parkedHost(fixture, configDirectory, hostOverrides)
            const inFlight = yield* Effect.forkDetach(
              writer.experimental.config.update({ fallback: { providerID: "test", model: "disposed-holder", variant: "high" } }),
            )
            yield* injection.awaitedReads(document, readsAt + 1).pipe(
              Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("writer never reached its config owner") }),
            )
            yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
              Effect.timeoutOrElse({
                duration: "4 seconds",
                orElse: () => Effect.die("writer never entered production's exclusive queue"),
              }),
            )
            expect(renames()).toBe(0)
            expect(temps()).toBe(0)
            expect(inFlight.pollUnsafe()).toBeUndefined()
            return inFlight
          }),
        )

        // A's borrow retired, so the queued grant went to the writer: its post-grant re-validation read, then its
        // own single rename, and the writer's host is still usable afterwards.
        yield* injection.awaitedReads(document, readsAt + 2).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("queued writer never resumed after A's disposal"),
          }),
        )
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("queued writer never committed") }),
        )
        expect(renames()).toBe(1)
        expect(temps()).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "disposed-holder"')
        yield* writer.experimental.config.update({ fallback: { providerID: "test", model: "second-writer", variant: "high" } })
        expect(renames()).toBe(2)
        expect(temps()).toBe(2)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "second-writer"')
        // Nothing of the disposed host's window is stranded: the parked waiter was granted, the later writer's
        // acquisition entered and was granted, and no holder or waiter is left behind.
        const drained = yield* pair.admission.observation
        expect(drained.queuedExclusive).toBe(0)
        expect(drained.enqueuedExclusive).toBe(enqueuedAt + 2)
        expect(drained.grantedExclusive).toBe(enqueuedAt + 2)
        expect(drained.sharedReaders).toBe(0)
        expect((yield* Effect.promise(() => fs.readdir(configDirectory))).filter((name) => name.startsWith("."))).toEqual(
          [],
        )
      }),
    ),
  30_000,
)

it.live(
  "cancelling the queued writer's request with its host open retires only its own position and override",
  () =>
    withEmbedded("opencode-embedded-config-cancel-request-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive

        // A's host also carries the recovery probe used at the end of this case: its responder answers from the first
        // arrival, so a specific arrival can be made to fail with a retryable transport error. Arrival 1 is the
        // session's title request and arrival 2 its first turn, which stays parked at the gate; arrival 3 is the turn
        // started AFTER the abandoned intent retires, and the closing assertions establish that mapping rather than
        // assuming it.
        let arrival = 0
        const a = yield* parkedHost(fixture, configDirectory, hostOverrides, (request) => {
          arrival += 1
          if (arrival === 3)
            return TestLLM.failAfter(
              new AIError({
                reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
              }),
            )
          return TestLLM.text("answer", "answer")
        })
        const writer = yield* writerHost(fixture, configDirectory, hostOverrides)
        const readsAt = injection.readCount(document)
        const queued = yield* Effect.forkScoped(
          writer.experimental.config.update({ fallback: { providerID: "test", model: "cancelled-writer", variant: "high" } }),
        )
        // Cancel AFTER production reports the writer staged and parked at the exclusive grant, so what follows
        // distinguishes a cancelled owner from one that never started.
        yield* injection.awaitedReads(document, readsAt + 1).pipe(
          Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("writer never reached its config owner") }),
        )
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("writer never entered the exclusive queue") }),
        )
        expect((yield* pair.fallbackIntent.current()).override.type).toBe("some")

        // The REQUEST is cancelled while host B stays open: the client call returns, and the assertions below are
        // about the OWNER, exactly as the server's wire keepers phrase them.
        yield* Fiber.interrupt(queued)
        const outcome = yield* Fiber.await(queued)
        // The cancelled request's OWN termination read straight off the fiber: an interruption, not a completion.
        // Wrapping the read in `Effect.exit` would report success for any outcome, including a request that never
        // stopped, so it is not evidence at all.
        expect(Exit.hasInterrupts(outcome)).toBe(true)
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(0)
        expect(injection.calls.writes.filter((write) => write.path.includes(".tmp")).length).toBe(0)
        // A's lease is untouched by another host's cancellation: it is still the only holder.
        const cancelled = yield* pair.admission.observation
        expect(cancelled.sharedReaders).toBe(1)
        expect(cancelled.writer).toBe(false)
        // A settles, and the cancelled owner's queue position and staged override are both gone: nothing was granted
        // to it, nothing of it is still waiting, and its override was retired rather than left effective.
        yield* a.gate.release
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(Effect.timeout("8 seconds"))
        const settled = yield* pair.admission.observation
        expect(settled.queuedExclusive).toBe(0)
        expect(settled.grantedExclusive).toBe(enqueuedAt)
        expect((yield* pair.fallbackIntent.current()).override.type).toBe("none")
        // The cancelled host is still open, and a later writer of the same resource commits exactly once. Its
        // selection is one this host can actually dispatch, so the recovery below has a real fallback to resolve.
        yield* writer.experimental.config.update({ fallback: { providerID: "custom", model: "fallback-chat" } })
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "fallback-chat"')

        // The next eligible recovery on that same still-live host: the new turn fails its first attempt, so the
        // retry is an actual fallback dispatch, and it resolves the newly COMMITTED selection rather than the
        // abandoned one. That is the physical proof the cancelled writer's override retired: no arrival of this
        // host's session ever carries `test/cancelled-writer`.
        yield* a.opencode.sessions.prompt({ sessionID: a.session.id, text: "Recover after the abandoned intent" })
        yield* a.llm.wait(4).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("the recovery retry never reached its request"),
          }),
        )
        const recovered = yield* a.llm.requests()
        expect(recovered.length).toBe(4)
        // Which arrival failed is established, not assumed: the attempt preceding the retry ran on this host's own
        // primary, and the retry runs on the committed fallback.
        expect(recovered[2]?.model).toMatchObject({ provider: "custom", id: "fictional-chat" })
        expect(recovered[3]?.model).toMatchObject({ provider: "custom", id: "fallback-chat" })
        const dispatchedModels = recovered.map((request) => `${request.model.provider}/${request.model.id}`)
        expect(dispatchedModels, "the abandoned selection reached the provider").not.toContain("test/cancelled-writer")
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("A's recovery never settled") }),
        )
        expect((yield* pair.fallbackIntent.current()).override.type).toBe("none")
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(1)
      }),
    ),
  30_000,
)

it.live(
  "one borrowed pair is what the SDK's private instance and ordinary location graphs both honour",
  () =>
    withEmbedded("opencode-embedded-config-private-selector-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)

        // A writer holds the EXCLUSIVE grant through the borrowed pair the route graph took. Any graph of any host
        // that starts a generation must be withheld by it, which is only true if they resolve the same pair.
        const held = yield* pair.admission.acquireExclusive
        const observed = yield* pair.admission.observation
        expect(observed.writer).toBe(true)
        const sharedAt = observed.enqueuedShared
        const grantedSharedAt = observed.grantedShared

        // The ordinary location graph: a freshly created host with no selector at all.
        const ordinary = yield* generationHost(fixture, configDirectory, hostOverrides)
        // The SDK's private selector, built for real: `key` is deterministic, `configure` records that it ran and
        // reconstructs an instance whose plugin rewrites the prompt. Only that instance's plugin can put the marker
        // into a physical request, so the marker is the proof the session operation ran in the instance graph.
        const marker = "sdk-private-instance"
        const configured: string[] = []
        const selected = yield* generationHost(fixture, configDirectory, hostOverrides, {
          key: () => marker,
          configure: (key) =>
            Effect.gen(function* () {
              configured.push(key)
              return {
                plugins: [
                  Plugin.define({
                    id: "sdk-private-selector-marker",
                    effect: Effect.fnUntraced(function* (ctx: Plugin.Context) {
                      yield* ctx.session.hook("prompt", (event) =>
                        Effect.sync(() => {
                          event.prompt.text = `${marker}: ${event.prompt.text}`
                        }),
                      )
                    }),
                  }),
                ],
              }
            }),
        })

        yield* pair.admission.awaitedEnqueued("shared", sharedAt + 2).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("a new host's generation never reached the borrowed pair's admission"),
          }),
        )
        const withheld = yield* pair.admission.observation
        // Both graphs are withheld by the ONE grant: two shared acquisitions entered this admission, none granted.
        expect(withheld.writer).toBe(true)
        expect(withheld.queuedShared).toBe(2)
        expect(withheld.grantedShared).toBe(grantedSharedAt)
        expect(withheld.sharedReaders).toBe(0)
        expect(ordinary.started.pollUnsafe(), "the held grant did not withhold the ordinary graph").toBeUndefined()
        expect(selected.started.pollUnsafe(), "the held grant did not withhold the selected instance").toBeUndefined()
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')

        // Releasing the borrowed grant admits both generations, so that grant really was in both paths.
        yield* held.release
        for (const host of [ordinary, selected]) {
          yield* host.entered.pipe(
            Effect.timeoutOrElse({
              duration: "8 seconds",
              orElse: () => Effect.die("a withheld generation never entered its provider request"),
            }),
          )
          yield* host.gate.release
          yield* host.opencode.experimental.session.wait({ sessionID: host.session.id }).pipe(
            Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("a released generation never settled") }),
          )
        }

        // The selector ran, exactly once, for the session operation that its generation performed.
        expect(configured, "the private selector never configured the instance that ran the session").toEqual([marker])
        const selectedRequests = yield* selected.llm.requests()
        expect(selectedRequests.length, "the selected instance reached no provider").toBeGreaterThan(0)
        expect(
          JSON.stringify(selectedRequests.map((request) => request.messages)),
          "the prompt never passed through the SDK's private instance",
        ).toContain(marker)
        // The ordinary graph ran its own session in its own location graph, unmarked, and both reached the provider.
        const ordinaryRequests = yield* ordinary.llm.requests()
        expect(ordinaryRequests.length).toBeGreaterThan(0)
        expect(JSON.stringify(ordinaryRequests.map((request) => request.messages))).not.toContain(marker)
        const settled = yield* pair.admission.observation
        expect(settled.grantedShared).toBeGreaterThanOrEqual(grantedSharedAt + 2)
        expect(settled.queuedShared).toBe(0)
        expect(settled.writer).toBe(false)
        expect(settled.sharedReaders).toBe(0)
      }),
    ),
  30_000,
)

/**
 * One independently owned store. Every path the delegate accepts is addressed through this store's own directory:
 * the shared spelling `exposed` is translated to `physical`, `realPath` hands back `exposed` itself, and `stat` asserts
 * one fixed device/inode pair for every directory. Two stores built this way agree on the exposed path AND on the inode
 * data, and differ only in the backing-store token their provider asserts — so a resource key that ignored the token
 * could not tell them apart.
 */
const storeLayer = (
  physical: string,
  exposed: string,
  probe: string,
  token: object,
  injection: ReturnType<typeof filesystemInjection>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      const relocate = (target: string) =>
        target === exposed || target.startsWith(exposed + path.sep)
          ? path.join(physical, path.relative(exposed, target))
          : target
      // Uniform translation, so no operation can leak the shared spelling into this store or read the other one.
      // Only arguments that spell the exposed directory move, in any position, which leaves content untouched.
      const translated = Object.fromEntries(
        Object.entries(fs).map(([method, value]) => [
          method,
          typeof value === "function"
            ? (...args: readonly unknown[]) =>
                (value as (...parameters: readonly unknown[]) => unknown)(
                  ...args.map((argument) =>
                    typeof argument === "string" && (argument === exposed || argument.startsWith(exposed + path.sep))
                      ? relocate(argument)
                      : argument,
                  ),
                )
            : value,
        ]),
      ) as unknown as FileSystem.FileSystem
      return withNamespace(
        {
          ...translated,
          // The store asserts its directory identity rather than inheriting what its own root's inode happens to be:
          // the exposed directory is answered from one shared probe, which is how two separate stores come to hand
          // out identical device and inode data.
          stat: (target: string) => target === exposed ? fs.stat(probe) : fs.stat(relocate(target)),
          realPath: (target: string) => fs.realPath(relocate(target)).pipe(Effect.map(() => exposed)),
        },
        token,
      )
    }),
  ).pipe(Layer.provide(injection.layer))

it.live(
  "dispatches a sibling host's staged fallback physically while its commit is still unrenamed",
  () =>
    withEmbedded("opencode-embedded-config-fallback-dispatch-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive

        // A's host sends more than one provider request (the session's title generation is one of them, and it is the
        // FIRST arrival: a failure there is not retried). So the responder fails the SECOND arrival, which is the
        // session turn's first attempt, and answers everything else. Which arrival is which is then established by
        // the assertions below rather than assumed: the request at that index is the primary attempt whose retry
        // follows it, and the retry is the one carrying the staged selection.
        const prompt = "Dispatch the staged fallback marker"
        let arrival = 0
        const a = yield* parkedHost(fixture, configDirectory, hostOverrides, (request) => {
          arrival += 1
          if (arrival === 2)
            return TestLLM.failAfter(
              new AIError({
                reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
              }),
            )
          return TestLLM.text("answer", "answer")
        }, prompt)
        const writer = yield* writerHost(fixture, configDirectory, hostOverrides)
        const readsAt = injection.readCount(document)
        const queued = yield* Effect.forkScoped(
          writer.experimental.config.update({ fallback: { providerID: "custom", model: "fallback-chat", variant: "high" } }),
        )
        // The sibling's intent is staged and parked at A's lease: staging follows validation and precedes admission,
        // so its value is effective to this resource while its document is still untouched.
        yield* injection.awaitedReads(document, readsAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("writer never reached its config owner"),
          }),
        )
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("writer never entered production's exclusive queue"),
          }),
        )
        const staged = yield* pair.fallbackIntent.current()
        expect(staged.override.type).toBe("some")
        expect((yield* pair.fallbackIntent.committedRevision()), "a staged intent must not look committed").toBe(0)
        expect(renames()).toBe(0)
        expect(temps()).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).not.toContain("fallback-chat")

        // The retry's physical request arrives while that commit is still unmade, and it is attributed to the staged
        // fallback rather than to the primary the request began on.
        yield* a.gate.release
        // The retried attempt arrives, counted as an arrival of this host rather than waited on as a duration: a third
        // request has been sent.
        yield* a.llm.wait(3).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("the retry never reached its request") }),
        )
        const dispatched = yield* a.llm.requests()
        expect(dispatched.length).toBe(3)
        // The variant a staged selection carries has to reach the physical request, not just the model ID: this
        // provider model declares `variants: [{ id: "high", settings: { temperature } }]`, and the resolver applies
        // those settings to the model it dispatches (`model-resolver.ts` `withVariant`). The failed attempt ran on
        // the primary the request began on and carries no such setting; the retry carries it.
        const variantSetting = (request: LLMRequest | undefined) =>
          (request?.model.options?.providerOptions as { readonly temperature?: unknown } | undefined)?.temperature
        expect(dispatched[1]?.model).toMatchObject({ provider: "custom", id: "fictional-chat" })
        expect(variantSetting(dispatched[1]), "the primary attempt carried the staged variant's setting").toBeUndefined()
        expect(dispatched[2]?.model).toMatchObject({ provider: "custom", id: "fallback-chat" })
        expect(variantSetting(dispatched[2]), "the retry was not physically dispatched on the staged variant").toBe(0.317)
        // At this same instant the staging writer has committed nothing: the retry outran the rename, the temp write
        // and the durable bytes of the selection it was dispatched on.
        expect(renames(), "the retry outran the staging writer's rename").toBe(0)
        expect(temps()).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).not.toContain("fallback-chat")

        // A's generation settles, its lease releases, and only then does the staging writer's rename land.
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("A's generation never settled") }),
        )
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("the staging writer never committed") }),
        )
        expect(renames()).toBe(1)
        expect(temps()).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "fallback-chat"')
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"variant": "high"')
        expect((yield* pair.fallbackIntent.committedRevision())).toBe(1)
        // Already-dispatched attempts keep their attribution: the retry is never relabelled by the later commit,
        // and neither its model nor the variant setting that model was dispatched with changes afterwards.
        const finalRequests = yield* a.llm.requests()
        expect(finalRequests.length).toBe(3)
        expect(finalRequests[2]?.model).toMatchObject({ provider: "custom", id: "fallback-chat" })
        expect(variantSetting(finalRequests[2]), "a committed document relabelled an already-dispatched attempt").toBe(0.317)
      }),
    ),
  30_000,
)

it.live(
  "orders three hosts on one resource so the earlier entry commits first and the newest intent survives",
  () =>
    withEmbedded("opencode-embedded-config-entry-order-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp"))
        const renames = () => injection.calls.renames.filter(([, to]) => to === document)
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive

        // A holds the generation lease, so no writer can reach its commit boundary yet.
        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)

        // B enters Config's owner first: it validates, stages its value, and parks at the lease A still holds.
        const b = yield* writerHost(fixture, configDirectory, hostOverrides)
        const queuedB = yield* Effect.forkScoped(
          b.experimental.config.update({ shell: "zsh", fallback: { providerID: "test", model: "earlier-entry" } }),
        )
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never entered production's exclusive queue"),
          }),
        )
        const stagedByB = yield* pair.fallbackIntent.current()
        expect(stagedByB.override.type).toBe("some")
        expect((stagedByB.override as { readonly value?: { readonly model?: string } }).value?.model).toBe("earlier-entry")
        expect(renames().length).toBe(0)
        expect(temps().length).toBe(0)

        // C enters later, validates and stages its own value, and only then waits at its commit boundary for the
        // earlier entry to retire. Its own read of the document is the barrier that proves it got there.
        const readsAfterB = injection.readCount(document)
        const c = yield* writerHost(fixture, configDirectory, hostOverrides)
        const queuedC = yield* Effect.forkScoped(
          c.experimental.config.update({ shell: "fish", fallback: { providerID: "test", model: "newest-intent" } }),
        )
        yield* injection.awaitedReads(document, readsAfterB + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("C never reached its own validation read"),
          }),
        )
        // C has reached validation but not the queue: it waits at its own commit boundary for the earlier entry to
        // retire, so exactly one exclusive acquisition has entered this admission so far, and nothing is durable.
        const waitingC = yield* pair.admission.observation
        expect(waitingC.enqueuedExclusive).toBe(enqueuedAt + 1)
        expect(waitingC.sharedReaders).toBe(1)
        expect(waitingC.writer).toBe(false)
        expect(temps().length).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')

        // The rename gate parks the FIRST durable replacement attempt, so the ordering snapshot below is taken while
        // B is mid-commit and C has not started its own.
        const parkedRename = yield* Deferred.make<void>()
        injection.armRenameGate(parkedRename)
        yield* a.gate.release
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("A's generation never settled") }),
        )
        yield* injection.awaitedRenames(1).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("B never reached its rename") }),
        )
        expect(renames().length).toBe(1)
        expect(temps().length).toBe(1)
        // B's temporary document is its own patch over the bytes it validated, carrying none of C's choice: a newer
        // host's staged intent cannot leak backwards into an earlier commit.
        expect(temps()[0]!.content).toContain('"shell": "zsh"')
        expect(temps()[0]!.content).toContain("earlier-entry")
        expect(temps()[0]!.content).not.toContain("fish")
        // C's intent is still the newest staged value while B's rename is parked, and the parked attempt is not a
        // commit: the document on disk is still the seeded one, and C has written nothing.
        const parked = yield* pair.fallbackIntent.current()
        expect((parked.override as { readonly value?: { readonly model?: string } }).value?.model).toBe("newest-intent")
        expect((yield* pair.fallbackIntent.committedRevision()), "a rename parked mid-commit is not a commit").toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')
        expect(temps().length).toBe(1)

        // B's rename lands, and only then does C's commit boundary open: C re-applies its patch on top of B's
        // committed bytes rather than the bytes it validated, and B never revisits a document C already replaced.
        yield* Deferred.succeed(parkedRename, undefined)
        yield* Fiber.join(queuedB).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("B never committed") }),
        )
        yield* Fiber.join(queuedC).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("C never committed") }),
        )
        const temporary = temps()
        expect(renames().length).toBe(2)
        expect(temporary.length).toBe(2)
        // The first temporary document is B's: its own patch over the seeded bytes, with none of C's choice in it.
        expect(temporary[0]!.content).toContain('"shell": "zsh"')
        expect(temporary[0]!.content).toContain("earlier-entry")
        expect(temporary[0]!.content).not.toContain("fish")
        // The second is C's, applied on top of B's commit: the newest patch wins where they touch, and B's unrelated
        // change stays durable, so C never rewrote B's document from a stale snapshot.
        expect(temporary[1]!.content).toContain('"shell": "fish"')
        expect(temporary[1]!.content).toContain("newest-intent")
        expect(temporary[1]!.content).not.toContain("earlier-entry")
        const bytes = yield* Effect.promise(() => fs.readFile(document, "utf8"))
        expect(bytes).toContain('"shell": "fish"')
        expect(bytes).toContain('"model": "newest-intent"')
        expect((yield* pair.fallbackIntent.committedRevision())).toBe(2)
        const finalIntent = yield* pair.fallbackIntent.current()
        // A committed document retires the staged intent it carried, so the newest value is durable rather than staged,
        // and the earlier entry's value is gone from both the document and the queue of intents.
        expect(finalIntent.override.type).toBe("none")
        // Nothing of the withheld window is stranded. A queue position that is retired and re-entered keeps its entry
        // count, so the grants are read directionally.
        const drained = yield* pair.admission.observation
        expect(drained.queuedExclusive).toBe(0)
        expect(drained.sharedReaders).toBe(0)
        expect(drained.writer).toBe(false)
        expect(drained.enqueuedExclusive).toBeGreaterThanOrEqual(enqueuedAt + 2)
        expect(drained.grantedExclusive).toBeGreaterThanOrEqual(enqueuedAt + 2)
        expect((yield* Effect.promise(() => fs.readdir(configDirectory))).filter((name) => name.startsWith("."))).toEqual(
          [],
        )
      }),
    ),
  30_000,
)

it.live(
  "refuses a late validation's intent when a newer entry already staged, and keeps durable writes in entry order",
  () =>
    withEmbedded("opencode-embedded-config-late-validation-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]
        const pair = yield* resourcePair(configDirectory, injection.layer)
        const temps = () => injection.calls.writes.filter((write) => write.path.includes(".tmp"))
        const renames = () => injection.calls.renames.filter(([, to]) => to === document)
        const enqueuedAt = (yield* pair.admission.observation).enqueuedExclusive
        // The staged selection this resource resolves right now, read from the intent owner itself: "none" when
        // nothing is staged, and the model ID of whatever value is.
        const staged = Effect.fnUntraced(function* () {
          const snapshot = yield* pair.fallbackIntent.current()
          return snapshot.override.type === "none" || snapshot.override.value === null
            ? "none"
            : snapshot.override.value.model
        })
        // Staging is not a queue event and the intent owner exposes no wait for it, so the value is polled until
        // the owner reports it. The cap only turns a missing value into a named failure: the ORDERING proof is
        // separate and comes from the recorder's read gate, which holds B's validation suspended until the test
        // opens it.
        const stagedAs = (want: string) =>
          staged().pipe(
            Effect.repeat({
              until: (value: string) => value === want,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeoutOrElse({
              duration: "4 seconds",
              orElse: () => Effect.die(`${want} never became the staged intent`),
            }),
          )

        // The test holds a SHARED lease of the resource itself, so neither writer can pass its commit boundary while
        // the validation window below is open. Both still reach their boundaries and queue there, which is what turns
        // the queue counters into readable evidence instead of a timing assumption.
        const lease = yield* pair.admission.acquireShared
        const b = yield* writerHost(fixture, configDirectory, hostOverrides)
        const c = yield* writerHost(fixture, configDirectory, hostOverrides)
        // Both writers' protected readers are warmed first, so their config owners have already read the document
        // and the next reads of it can only be updates' own candidate reads.
        yield* b.config.get({ location: location(fixture) })
        yield* c.config.get({ location: location(fixture) })
        // The update's own flow reads the document twice before it can stage: once on the way into the update owner
        // and once as its candidate read, AFTER reserving its entry position. Arming after `readsAt + 1` therefore
        // lets the first of these through and parks exactly the candidate read, which is the point the ordering
        // hinges on: the entry position is already reserved and open while B is suspended.
        const readsAt = injection.readCount(document)
        const validation = yield* Deferred.make<void>()
        injection.armReadGate(document, validation, readsAt + 1)

        // B enters the update owner FIRST: it reserves its entry position and then pauses inside candidate validation.
        const queuedB = yield* Effect.forkScoped(
          b.experimental.config.update({ shell: "zsh", fallback: { providerID: "test", model: "late-validation" } }),
        )
        yield* injection.awaitedReads(document, readsAt + 2).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never reached its own candidate read"),
          }),
        )
        // B is the ONLY update in flight, so the read this gate parked can only be B's own candidate read: its entry
        // position is reserved and open, and staging follows validation, so this resource still carries no intent and
        // no writer has reached its commit boundary.
        expect(yield* staged()).toBe("none")
        expect(renames().length).toBe(0)
        expect(temps().length).toBe(0)
        expect((yield* pair.admission.observation).enqueuedExclusive).toBe(enqueuedAt)

        // C enters LATER, validates unimpeded and stages its newer intent while B is still inside validation. Its
        // patch touches only `fallback`, so whatever it commits must carry the other writer's change.
        const queuedC = yield* Effect.forkScoped(
          c.experimental.config.update({ fallback: { providerID: "test", model: "newer-intent" } }),
        )
        // Two more reads of the document: C's way-in read and its own candidate read, both unimpeded because the
        // gate armed above parks exactly one read and disarms as it does.
        yield* injection.awaitedReads(document, readsAt + 4).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("C never reached its own candidate read"),
          }),
        )
        yield* stagedAs("newer-intent")
        const newer = yield* pair.fallbackIntent.current()
        expect(yield* staged()).toBe("newer-intent")
        expect(newer.revision).toBeGreaterThan(0)
        // Decisive ordering, and not a timing assumption: neither writer has reached its commit boundary at all (no
        // entry and no grant), so B's update is still suspended on the read gate this test has not opened — B had
        // NOT finished validating at the instant C's intent became effective — while C is held at `awaitPredecessors`
        // by B's still-open entry position. B forked first and is the first fiber to read, so the gated read is its
        // own candidate read.
        const boundary = yield* pair.admission.observation
        expect(boundary.enqueuedExclusive).toBe(enqueuedAt)
        expect(boundary.queuedExclusive).toBe(0)
        expect(boundary.writer).toBe(false)
        expect(boundary.grantedExclusive).toBe(enqueuedAt)
        expect(boundary.sharedReaders).toBe(1)
        expect(renames().length).toBe(0)
        expect(temps().length).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')

        // The negative that matters: B's validation resumes AFTER C staged, it completes normally, and its late
        // stage is REFUSED — the effective intent stays C's, at C's revision, rather than being replaced by the
        // older entry's value. `stageValidated` refuses a position at or below the current revision, so that refusal
        // is itself the entry-order proof. B's first durable replacement is parked as it reaches it, so the
        // snapshots below cannot race with each other.
        const parkedFirst = yield* Deferred.make<void>()
        injection.armRenameGate(parkedFirst)
        yield* Deferred.succeed(validation, undefined)
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never reached its commit boundary after its late validation"),
          }),
        )
        const late = yield* pair.fallbackIntent.current()
        expect(yield* staged()).toBe("newer-intent")
        expect(late.revision).toBe(newer.revision)
        const queued = yield* pair.admission.observation
        // B is the only entry at that boundary and the test's shared lease withholds its grant; C has still not
        // entered it, and B wrote nothing durable yet, so neither the document nor the committed revision moved.
        expect(queued.queuedExclusive).toBe(1)
        expect(queued.writer).toBe(false)
        expect(queued.grantedExclusive).toBe(enqueuedAt)
        expect(queued.sharedReaders).toBe(1)
        expect(temps().length).toBe(0)
        expect((yield* pair.fallbackIntent.committedRevision()), "an entry position is not a commit").toBe(0)
        // The lease goes, so the earlier entry is admitted first and commits first.
        yield* lease.release
        yield* injection.awaitedRenames(1).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("B never reached its rename") }),
        )
        // B's entry, being the earlier one, commits FIRST, and it re-applies its own candidate over the bytes it
        // reads at commit time — the seeded ones — so C's intent stays staged and uncommitted under B's write.
        expect(renames().length).toBe(1)
        expect(temps()[0]!.content).toContain('"shell": "zsh"')
        expect(temps()[0]!.content).toContain("late-validation")
        expect(temps()[0]!.content).not.toContain("newer-intent")
        expect((yield* pair.fallbackIntent.committedRevision()), "a rename parked mid-commit is not a commit").toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"shell": "bash"')

        // B then retires its own position and clears only if it were current — it is not, so the newer staged intent
        // survives B's retirement instead of being erased by it. C's boundary opens at that point, and its patch is
        // re-applied against B's COMMITTED bytes, so B's unrelated key survives underneath C's newer choice.
        const parkedSecond = yield* Deferred.make<void>()
        injection.armRenameGate(parkedSecond)
        yield* Deferred.succeed(parkedFirst, undefined)
        yield* Fiber.join(queuedB).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("B never committed") }),
        )
        expect((yield* pair.fallbackIntent.committedRevision())).toBe(1)
        expect(yield* staged()).toBe("newer-intent")
        const afterB = yield* pair.fallbackIntent.current()
        expect(afterB.revision).toBe(newer.revision)
        const bytesB = yield* Effect.promise(() => fs.readFile(document, "utf8"))
        expect(bytesB).toContain('"shell": "zsh"')
        expect(bytesB).toContain("late-validation")
        expect(bytesB).not.toContain("newer-intent")
        yield* pair.admission.awaitedEnqueued("exclusive", enqueuedAt + 2).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("C never reached its commit boundary after the earlier entry retired"),
          }),
        )
        yield* injection.awaitedRenames(2).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("C never reached its rename") }),
        )
        expect(temps().length).toBe(2)
        expect(temps()[1]!.content).toContain('"shell": "zsh"')
        expect(temps()[1]!.content).toContain("newer-intent")
        expect(temps()[1]!.content).not.toContain("late-validation")
        expect(temps()[1]!.content).not.toContain('"shell": "bash"')
        yield* Deferred.succeed(parkedSecond, undefined)
        yield* Fiber.join(queuedC).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("C never committed") }),
        )
        const bytes = yield* Effect.promise(() => fs.readFile(document, "utf8"))
        expect(bytes).toContain('"shell": "zsh"')
        expect(bytes).toContain('"model": "newer-intent"')
        expect(bytes).not.toContain("late-validation")
        expect((yield* pair.fallbackIntent.committedRevision())).toBe(2)
        // C's own commit retires the intent it carried, so the newest value is durable rather than staged.
        expect(yield* staged()).toBe("none")
        const drained = yield* pair.admission.observation
        expect(drained.queuedExclusive).toBe(0)
        expect(drained.sharedReaders).toBe(0)
        expect(drained.writer).toBe(false)
        expect(drained.enqueuedExclusive).toBe(enqueuedAt + 2)
        expect(drained.grantedExclusive).toBe(enqueuedAt + 2)
        expect((yield* Effect.promise(() => fs.readdir(configDirectory))).filter((name) => name.startsWith("."))).toEqual(
          [],
        )
      }),
    ),
  30_000,
)

it.live(
  "keeps two independently owned stores apart when they expose one path and one inode pair",
  () =>
    withEmbedded("opencode-embedded-config-independent-stores-", (fixture) =>
      Effect.gen(function* () {
        // Two separately rooted stores, each recorded on its own, each asserting its own backing-store token. They
        // expose the SAME spelled directory and report the SAME dev/ino data, so the token is all that distinguishes
        // them, and each writes to its own physical directory.
        const storeA = filesystemInjection()
        const storeB = filesystemInjection()
        const physicalA = path.join(fixture.directory, "store-a")
        const physicalB = path.join(fixture.directory, "store-b")
        const exposed = path.join(fixture.directory, "exposed-config")
        const probe = path.join(fixture.directory, "identity-probe")
        const documentA = path.join(physicalA, "opencode.jsonc")
        const documentB = path.join(physicalB, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(physicalA, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(physicalB, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(probe, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(documentA, `{ "shell": "bash" }\n`))
        yield* Effect.promise(() => fs.writeFile(documentB, `{ "shell": "bash" }\n`))
        const layerA = storeLayer(physicalA, exposed, probe, { token: "store-a" }, storeA)
        const layerB = storeLayer(physicalB, exposed, probe, { token: "store-b" }, storeB)

        const a = yield* parkedHost(fixture, exposed, [platformFilesystem.replace(layerA)])
        const writer = yield* writerHost(fixture, exposed, [platformFilesystem.replace(layerB)])
        const queued = yield* Effect.forkScoped(
          writer.experimental.config.update({ fallback: { providerID: "test", model: "foreign-store" } }),
        )

        // The identity each store proves: one exposed path, one inode pair, different tokens, therefore different
        // resources, and each host's own pair is the one the borrowed registry hands back.
        const pairA = yield* resourcePair(exposed, layerA)
        const pairB = yield* resourcePair(exposed, layerB)
        expect(pairA === pairB).toBe(false)
        const heldA = yield* pairA.admission.observation
        expect(heldA.sharedReaders, "A's lease is not in its own store's admission").toBe(1)
        const heldB = yield* pairB.admission.observation
        expect(heldB.sharedReaders).toBe(0)
        expect(heldB.enqueuedShared).toBe(0)

        // Independent stores never queue behind each other and never touch each other's document: B commits once, in
        // its own store, while A still holds its lease and its own document stays as seeded.
        yield* storeB.awaitedRenames(1).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("the independent store's writer never committed while the other held its lease"),
          }),
        )
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("the independent writer never finished") }),
        )
        expect(storeB.calls.renames.length).toBe(1)
        expect(storeB.calls.writes.filter((write) => write.path.includes(".tmp")).length).toBe(1)
        expect(storeA.calls.renames.length).toBe(0)
        expect(storeA.calls.writes.length).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(documentB, "utf8"))).toContain('"model": "foreign-store"')
        expect(yield* Effect.promise(() => fs.readFile(documentA, "utf8"))).not.toContain("foreign-store")
        expect(yield* Effect.promise(() => fs.readFile(documentA, "utf8"))).toContain('"shell": "bash"')

        // A is unaffected by the other store's commit and finishes its own generation.
        yield* a.gate.release
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("A's generation never settled") }),
        )
        expect((yield* a.llm.requests()).length).toBeGreaterThan(0)
        expect(storeA.calls.renames.length).toBe(0)
      }),
    ),
  30_000,
)

it.live(
  "shares one pair across transparent wrappers of one store, so one host's lease withholds the other's writer",
  () =>
    withEmbedded("opencode-embedded-config-transparent-wrappers-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        // Two independently constructed wrappers over the same recorded store. Neither adds a token, and both keep the
        // store's provenance capability, which is exactly what a spread of the delegate must not destroy.
        const wrapperOne = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (fs) => ({ ...fs })),
        ).pipe(Layer.provide(injection.layer))
        const wrapperTwo = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (fs) => Object.assign({}, fs)),
        ).pipe(Layer.provide(injection.layer))

        const a = yield* parkedHost(fixture, configDirectory, [platformFilesystem.replace(wrapperOne)])
        // Same spelled path, same inode data, wrapper-proven same store: the registry hands back ONE live pair.
        const first = yield* resourcePair(configDirectory, wrapperOne)
        const second = yield* resourcePair(configDirectory, wrapperTwo)
        expect(first === second).toBe(true)
        const enqueuedAt = (yield* first.admission.observation).enqueuedExclusive
        expect((yield* first.admission.observation).sharedReaders, "the wrapped host's lease is not in this pair").toBe(1)

        const writer = yield* writerHost(fixture, configDirectory, [platformFilesystem.replace(wrapperTwo)])
        const readsAt = injection.readCount(document)
        const queued = yield* Effect.forkScoped(
          writer.experimental.config.update({ fallback: { providerID: "test", model: "wrapper-shared", variant: "high" } }),
        )
        yield* injection.awaitedReads(document, readsAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("writer never reached its config owner"),
          }),
        )
        yield* first.admission.awaitedEnqueued("exclusive", enqueuedAt + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("the wrapped writer never entered the shared pair's queue"),
          }),
        )
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(0)
        expect(queued.pollUnsafe()).toBeUndefined()
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).not.toContain("wrapper-shared")

        // A's lease, taken through one wrapper, is what the other wrapper's writer waits behind.
        yield* a.gate.release
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("the wrapped writer never committed") }),
        )
        expect(injection.calls.renames.filter(([, to]) => to === document).length).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "wrapper-shared"')
      }),
    ),
  30_000,
)

it.live(
  "closing a host releases only its own borrow: a queued writer's host may close, and a new sibling still shares",
  () =>
    withEmbedded("opencode-embedded-config-resource-dispose-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]

        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)
        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const renamesAt = renames()

        // A writer host that closes while its update is queued at A's lease. Its own reservation and lease retire,
        // and the abandoned request contributes no rename.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const b = yield* writerHost(fixture, configDirectory, hostOverrides)
            // Counted from B's own post-load reads, so the wait below can only be satisfied by B's candidate read.
            const bReads = injection.readCount(document)
            const queued = yield* Effect.forkScoped(
              b.experimental.config.update({ fallback: { providerID: "test", model: "closed-writer" } }),
            )
            yield* injection.awaitedReads(document, bReads + 1).pipe(
              Effect.timeoutOrElse({
                duration: "4 seconds",
                orElse: () => Effect.die("B never reached its config owner"),
              }),
            )
            expect(renames()).toBe(renamesAt)
            expect(queued.pollUnsafe()).toBeUndefined()
          }),
        )
        expect(renames()).toBe(renamesAt)

        // A new sibling on the same directory is withheld by A's still-open lease, which proves the pair survived
        // the closed host instead of being evicted with it.
        const c = yield* writerHost(fixture, configDirectory, hostOverrides)
        const cReads = injection.readCount(document)
        const sibling = yield* Effect.forkScoped(
          c.experimental.config.update({ fallback: { providerID: "test", model: "surviving-pair" } }),
        )
        yield* injection.awaitedReads(document, cReads + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("C never reached its config owner"),
          }),
        )
        expect(renames()).toBe(renamesAt)
        expect(sibling.pollUnsafe()).toBeUndefined()

        // Releasing A's lease lets the sibling commit exactly once, and A itself completes its own generation.
        yield* a.gate.release
        yield* Fiber.join(sibling).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("sibling C never committed"),
          }),
        )
        expect(renames()).toBe(renamesAt + 1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "surviving-pair"')
        yield* a.opencode.experimental.session.wait({ sessionID: a.session.id }).pipe(Effect.timeout("8 seconds"))
        const requests = yield* a.llm.requests()
        expect(requests.length).toBeGreaterThan(0)
      }),
    ),
  25_000,
)

it.live(
  "shares one pair across alias spellings of one directory, because identity comes from the host's own writer",
  () =>
    withEmbedded("opencode-embedded-config-resource-alias-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        // An alias that names the same native directory through a symlink AND through a `..` step.
        const link = path.join(fixture.directory, "config-link")
        yield* Effect.promise(() => fs.symlink(configDirectory, link, "dir"))
        const alias = path.join(link, "..", path.basename(link))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]

        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)
        const b = yield* writerHost(fixture, alias, hostOverrides)

        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const renamesAt = renames()
        // Counted from B's post-load reads: B's proven directory is the canonical path it rebound, so its own
        // candidate read is recorded against A's document path rather than an alias spelling.
        const bReads = injection.readCount(document)
        const queued = yield* Effect.forkScoped(
          b.experimental.config.update({ fallback: { providerID: "test", model: "alias-shared" } }),
        )
        yield* injection.awaitedReads(document, bReads + 1).pipe(
          Effect.timeoutOrElse({
            duration: "4 seconds",
            orElse: () => Effect.die("B never reached its config owner"),
          }),
        )
        expect(renames(), JSON.stringify(injection.calls.renames)).toBe(renamesAt)
        expect(queued.pollUnsafe()).toBeUndefined()

        yield* a.gate.release
        yield* Fiber.join(queued).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.die("alias B never committed"),
          }),
        )
        expect(renames()).toBe(renamesAt + 1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "alias-shared"')
      }),
    ),
  25_000,
)

it.live(
  "shares nothing across backing-store tokens and refuses startup when the writer cannot prove its namespace",
  () =>
    withEmbedded("opencode-embedded-config-resource-namespace-", (fixture) =>
      Effect.gen(function* () {
        const injection = filesystemInjection()
        const configDirectory = path.join(fixture.directory, "config")
        const document = path.join(configDirectory, "opencode.jsonc")
        yield* Effect.promise(() => fs.mkdir(configDirectory, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(document, `{ "shell": "bash" }\n`))
        const hostOverrides = [platformFilesystem.replace(injection.layer)]

        // A SECOND backing-store token over the SAME real directory: the path, device and inode data are identical,
        // which must never be enough to share one Config resource.
        const foreign = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (fs) => withNamespace(fs, { token: "foreign-backing-store" })),
        ).pipe(Layer.provide(injection.layer))

        const a = yield* parkedHost(fixture, configDirectory, hostOverrides)
        const b = yield* writerHost(fixture, configDirectory, [platformFilesystem.replace(foreign)])
        const renames = () => injection.calls.renames.filter(([, to]) => to === document).length
        const renamesAt = renames()
        yield* b.experimental.config.update({ fallback: { providerID: "test", model: "foreign-token" } })
        // Distinct backing stores keep separate leases and entry lines, so this writer commits while A holds its lease.
        expect(renames(), JSON.stringify(injection.calls.renames)).toBe(renamesAt + 1)
        expect(yield* Effect.promise(() => fs.readFile(document, "utf8"))).toContain('"model": "foreign-token"')

        // A writer that cannot prove a backing namespace must fail startup with scoped cleanup: no unproven
        // fallback key, and nothing written by it.
        // Every own string-keyed operation is copied while the backing-namespace symbol is dropped: a real writer
        // that cannot prove who owns it, which is the case that must fail rather than invent a key.
        const unproven = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(
            FileSystem.FileSystem,
            (fs) => Object.fromEntries(Object.entries(fs)) as FileSystem.FileSystem,
          ),
        ).pipe(Layer.provide(injection.layer))
        const failed = yield* Effect.exit(writerHost(fixture, configDirectory, [platformFilesystem.replace(unproven)]))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(renames()).toBe(renamesAt + 1)

        // The failed startup left the surviving host's lease and resources intact: A finishes its own generation.
        const holding = yield* Effect.forkScoped(a.opencode.experimental.session.wait({ sessionID: a.session.id }))
        yield* Effect.yieldNow
        expect(holding.pollUnsafe(), "A settled early").toBeUndefined()
        yield* a.gate.release
        yield* Fiber.join(holding).pipe(Effect.timeout("8 seconds"))
        const requests = yield* a.llm.requests()
        expect(requests.length).toBeGreaterThan(0)
      }),
    ),
  25_000,
)
