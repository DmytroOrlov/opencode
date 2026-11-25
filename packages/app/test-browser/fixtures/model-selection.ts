import { afterEach, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Agent } from "@/runtime/server/types"
import type { ModelKey } from "@/providers/models/selection"
import { ServerScope } from "@/runtime/server/scope"

// Bun does not compile Solid JSX. Compile the real context provider with the
// same presets as Vite, along with every TSX module it loads, instead of
// replacing LocalProvider's implementation.
const require = createRequire(import.meta.url)

const solid = createRequire(require.resolve("vite-plugin-solid"))

const { transformSync } = solid("@babel/core")

Bun.plugin({
  name: "selection-solid-context",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})

type Commit = { agent?: string; model?: { providerID: string; id: string; variant?: string } }

type Event = { data: { sessionID: string } }

type ConfigModel = string | { providerID: string; model: string; variant?: string }

const key = (modelID: string): ModelKey => ({ providerID: "provider", modelID })

const durable = (modelID: string, variant?: string, agent = "build"): Commit => ({
  agent,
  model: { providerID: "provider", id: modelID, variant },
})

const agent = (name: string, model?: ModelKey, variant?: string): Agent => ({
  name,
  mode: "primary",
  permission: [],
  options: {},
  model,
  variant,
})

let active: ReturnType<typeof fixture>

mock.module("@solidjs/router", () => ({ useParams: () => active.state.route }))

mock.module("@/runtime/server/current", () => ({
  useData: () => active.data,
  // One `sync` per fixture: `createFallbackModelSelection` shares its config chain by `server.ctx.sync` identity
  // (`fallback-update.ts:13`), so every owner in one test has to see the same object, and each test needs its own
  // chain rather than one inherited from an earlier root that was already disposed.
  useServer: () => ({ ctx: { sync: active.sync } }),
}))

mock.module("@/runtime/server/client", () => ({ useServerSDK: () => active.sdk }))

mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ models: active.preferences }) }))

// Like the real provider, every read builds a new location object, and loading its info builds another.
mock.module("@/workspaces/location", () => ({
  useWorkspaceLocation: () => {
    const owner = active

    return () => ({ directory: owner.directory, loaded: owner.state.locationLoads })
  },
}))

mock.module("@/settings/model", () => ({
  useSettings: () => ({ visibility: { customAgents: () => active.state.visible } }),
}))

mock.module("@/composer/persistence", () => ({ useComposerState: () => active.prompt }))

mock.module("@/shell/state/layout", () => ({ useLayout: () => undefined }))

// The fallback owner reads the language only when it reports a rejected write itself, which these cases replace with
// their own callback, so no locale dictionary is needed here.
mock.module("@/runtime/i18n/language", () => ({
  useLanguage: () => ({ t: (key: string) => key, plural: (key: string) => key, locale: "en", direction: "ltr" }),
}))

mock.module("@/runtime/platform/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
  }),
}))

// What a rejected write reports through the toast API: the title and description the fallback owner's own toast copy
// would have used (`selection.tsx`'s `reported`), or a bare string. Named so the fixture records a report rather than
// an unparsed value, and every report of an attempt is counted, not inspected (T028's one-report claim).
type ToastReport = { title?: string; description?: string } | string

// The composer reports a rejected pair write through the fallback owner's toast; counting these calls is how the
// "at most once per attempt" claims are observed. The toast region itself is `@opencode/ui`'s business.
mock.module("@/shell/notifications/toast", () => ({
  ToastRegion: () => null,
  showToast: (options: ToastReport) => {
    active.reports.push(options)
  },
}))

const { LocalProvider, useLocal, createFallbackModelSelection } = await import("@/providers/models/selection")

const { ModelsProvider } = await import("@/providers/models/models")

const { Persist } = await import("@/runtime/persistence/storage")

const { flushPersisted } = await import("@/runtime/persistence/persist")

const { createMemoryComposerState } = await import("@/composer/state")

const { createComposerModelSelection, createComposerControls } = await import("@/composer/selection")

const { payloadChoice } = await import("@/session/composer/selection")

const cleanups: Array<() => void> = []

afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

function fixture(input: { session?: Commit; agents?: Agent[]; config?: ConfigModel; fallback?: ConfigModel | null; preferred?: string } = {}) {
  const directory = `/selection-test/${crypto.randomUUID()}`

  // SAFETY: fixture transitions clear the route as well as selecting session IDs.
  const [state, set] = createStore({
    visible: true,
    configLoaded: true,
    connection: "connected",
    configWriteFailures: 0,
    locationLoads: 0,
    route: { id: "ses_a" as string | undefined, serverKey: undefined as string | undefined },
    agents: input.agents ?? [agent("build"), agent("plan")],
    config: input.config,
    sessions: Object.fromEntries([["ses_a", input.session]]),
    providers: [{ id: "provider", name: "Provider", package: "@ai-sdk/test", activation: "enabled" }],
    models: ["a", "b", "c"].map((id) => ({
      id,
      modelID: id,
      providerID: "provider",
      name: `Model ${id}`,
      settings: {},
      headers: {},
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: ["low", "high"].map((id) => ({ id, settings: {} })),
      time: { released: 1 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 128_000, output: 8192 },
    })),
  })

  // SAFETY: empty collections are valid preferences; tests later populate them with the declared model keys and variants.
  const [preferences, setPreferences] = createStore({
    user: [] as Array<ModelKey & { visibility: "show" | "hide" }>,
    recent: [] as ModelKey[],
    favorite: [] as ModelKey[],
    variant: (input.preferred ? { "provider/a": input.preferred } : {}) as Record<string, string>,
  })

  const events = new Map<string, Set<(event: Event) => void>>()
  const configLoads: string[] = []
  let failingWrites = 0

  // One `sync` per fixture, shared by every owner mounted in it: `createFallbackModelSelection` keys its config chain
  // by `server.ctx.sync` identity (`fallback-update.ts:13`), which is what makes a fallback write visible to the
  // composer's fallback slot and vice versa. It reads and writes the stored `fallback` field the way the server's
  // document does, so the value survives the owner clearing its own optimistic override.
  // One `sync` per fixture, shared by every owner mounted in it: `createFallbackModelSelection` keys its config chain
  // by `server.ctx.sync` identity (`fallback-update.ts:13`), which is what makes a fallback write visible to the
  // composer's fallback slot and vice versa. The stored `fallback` field is a plain object here, like the JSON the
  // server hands back: the owner's own optimistic override is what shows a write immediately, and this document is
  // what it reads again once that override is cleared when the write lands.
  // An explicit `null` in the config disables the fallback, which is different from the field being absent: the
  // fixture keeps that distinction the way the server's document does.
  // The stored config document, exactly as the server's JSON holds it: the `fallback` key is always PRESENT, so an
  // explicit `null` disables the fallback while an absent field would leave the shipped default in place (FR-012).
  type ConfigDocument = { fallback: ConfigModel | null | undefined }

  const configDocument: ConfigDocument = {
    fallback: Object.hasOwn(input, "fallback") ? input.fallback : undefined,
  }

  // Every config write this fixture was asked for, including the rejected ones: a claim that an action "writes nothing
  // at all" is read off this list, which is what the pair rule's no-op cases need (FR-006/FR-029).
  const configPatches: { fallback?: unknown }[] = []
  // The same writes with the promise the owner's chain awaits, which is what lets a test wait for a save's OUTCOME
  // rather than for a number of microtasks (FR-032's compensation can only be observed after that outcome lands).
  const configChain: { patch: { fallback?: unknown }; promise: Promise<unknown> }[] = []
  // The fixture's side of that queue: a waiter is answered the moment the owner's chain starts a save, so a test can
  // await a save that has not been issued yet without guessing how many microtasks the chain takes.
  let writeWaiters: Array<(write: { patch: { fallback?: unknown }; promise: Promise<unknown> }) => void> = []
  // How many of this fixture's config writes have already been awaited to their outcomes by `settleConfigWrites`.
  let written = 0

  const sync = {
    data: { config: configDocument },
    // Rejects while the fixture arms it, so one config half of a pair can fail and the next one lands.
    updateConfig: (patch: { fallback?: unknown }) => {
      configPatches.push(patch)

      const promise = (async () => {
        if (state.configWriteFailures > 0) {
          set("configWriteFailures", state.configWriteFailures - 1)

          throw new Error("config write failed")
        }

        if (Object.hasOwn(patch, "fallback")) {
          // SAFETY: only the app's config chain writes this patch, and it names the fallback it chose (`ConfigModel`)
          // or `null` to disable it; the `hasOwn` guard above already skipped a patch that says nothing about it.
          configDocument.fallback = patch.fallback as ConfigModel | null
        }
      })()

      const write = { patch, promise }
      configChain.push(write)

      const waiting = writeWaiters
      writeWaiters = []
      waiting.forEach((resolve) => resolve(write))

      return promise
    },
  }

  // Every report the composer made through the toast API, in order, for the `at most once` claims.
  const reports: unknown[] = []

  const result = {
    prompt: createMemoryComposerState(),
    directory,
    state,
    set,
    setPreferences,
    sync,
    /** The stored config `fallback` field as the server's document holds it: `undefined` means unconfigured. */
    configFallback: () => configDocument.fallback,
    /** Every config write attempted against this fixture's server, in order. */
    configWrites: () => configPatches,
    /** The same writes as the promises the owners' chains await, oldest first. */
    writes: configChain,
    /**
     * Waits for `count` config saves to reach their outcomes.
     *
     * Deterministic, with no turn count and no timer: the first await resolves when this fixture is ASKED for the
     * next save (the moment the owner's chain starts it), and the second awaits that save's own promise THROUGH a
     * derived one, which lands one queue slot behind the chain's OWN reaction to it — its revert of the optimistic
     * override and the caller's `failed` callback (`fallback-update.ts:37-51`). So when this returns the owner has
     * ANSWERED the write: the report, the compensation, or the deliberate nothing that the pair machine decided has
     * already happened. That is what makes the assertions that follow it about the OUTCOME rather than about a save
     * still in flight, and the tests that expect a report or a restored pair immediately after this call, beside the
     * ones that expect neither, are what keep this wait honest in both directions.
     */
    async settleConfigWrites(count = 1) {
      for (let index = 0; index < count; index += 1) {
        const write = await new Promise<{ patch: { fallback?: unknown }; promise: Promise<unknown> }>((resolve) => {
          if (configChain.length > written) resolve(configChain[written]!)
          else writeWaiters.push(resolve)
        })

        written += 1
        await write.promise.catch(() => {})
      }
    },
    /** Every report the composer made through the toast API, in order, for the `at most once` claims. */
    reports,
    preferences: {
      store: preferences,
      set: setPreferences,
      ready: () => true,
      recent: () => preferences.recent,
      favorite: () => preferences.favorite,
    },
    data: {
      session: { get: (id: string) => state.sessions[id] },
      location: {
        agent: { list: () => state.agents, sync: async () => undefined },
        config: {
          list: () => (state.configLoaded ? [{ type: "document", info: { model: state.config } }] : undefined),
          sync: async () => {
            configLoads.push(state.connection)
          },
        },
        provider: { list: () => state.providers },
        model: { list: () => state.models },
        integration: { list: () => [] },
      },
    },
    sdk: {
      scope: ServerScope.local,
      connection: { status: () => state.connection },
      event: {
        on(type: string, handler: (event: Event) => void) {
          const handlers = events.get(type) ?? new Set()
          events.set(type, handlers)
          handlers.add(handler)

          return () => handlers.delete(handler)
        },
      },
    },
    emit(type: string, sessionID = "ses_a") {
      events.get(type)?.forEach((handler) => handler({ data: { sessionID } }))
    },
    configLoads,
    /** The next `count` saves of this workspace's document fail, the way a `setItem` that cannot store does. */
    failWrites(count = 1) {
      failingWrites = count
    },
    /** The next `count` config writes reject, the way a rejected config `PATCH` does. */
    failConfigWrites(count = 1) {
      set("configWriteFailures", count)
    },
    /** Ends the pending save window now, so a save's outcome is observed without waiting. */
    flush() {
      flushPersisted()
    },
    mount(draft = false, controls = false) {
      active = result
      let local!: ReturnType<typeof useLocal>
      let composer: ReturnType<typeof createComposerModelSelection> | undefined
      let fallback!: ReturnType<typeof createFallbackModelSelection>
      let composerControls: ReturnType<typeof createComposerControls> | undefined

      const dispose = createRoot((dispose) => {
        createComponent(ModelsProvider, {
          directory,
          get children() {
            return createComponent(LocalProvider, {
              get children() {
                local = useLocal()

                if (!controls) fallback = createFallbackModelSelection()

                if (draft) composer = createComposerModelSelection({ agent: local.agent.current })

                // The composer's own slots: the wrapped objects a real composer hands to its pickers, chips,
                // commands and submission, which is what a pair exchange drives and compensates. A draft composer
                // feeds its own selection in, the way `new-session/composer-adapter.ts:96` does, which is what makes
                // that slot's document failure a mirrored one.
                if (controls) composerControls = createComposerControls(draft ? { model: composer } : undefined)

                return null
              },
            })
          },
        })

        return dispose
      })

      cleanups.push(dispose)

      return { local, composer, fallback, controls: composerControls, dispose }
    },
  }

  const target = Persist.serverWorkspace(ServerScope.local, directory, "model-selection")
  cleanups.push(() => localStorage.removeItem(`${target.storage}:${target.key}`))

  // A `setItem` that could not store. `write()` in `storage.ts` catches it, dispatches its own storage failure and
  // returns `false`, which `persist.ts:93` reads as a failed save. The wrapper is inert until `failWrites` arms it, and
  // it only touches this fixture's own document. `setItem` is inherited from the storage prototype, so installing it
  // needs `defineProperty` rather than assignment, and restoring puts the original back the same way.
  const storage = globalThis.localStorage
  const stored = storage.setItem.bind(storage)

  const restore = () => {
    Object.defineProperty(storage, "setItem", { configurable: true, writable: true, value: stored })
  }

  Object.defineProperty(storage, "setItem", {
    configurable: true,
    writable: true,
    value: (name: string, value: string) => {
      if (name === `${target.storage}:${target.key}` && failingWrites > 0) {
        failingWrites -= 1

        throw new Error("storage unavailable")
      }

      return stored(name, value)
    },
  })
  cleanups.push(restore)

  return result
}

function stored(directory: string) {
  const target = Persist.serverWorkspace(ServerScope.local, directory, "model-selection")
  const raw = localStorage.getItem(`${target.storage}:${target.key}`)

  return raw === null ? undefined : JSON.parse(raw)
}

function selection(local: ReturnType<typeof useLocal>) {
  return {
    agent: local.agent.current()?.name,
    model: local.model.current()?.id,
    variant: local.model.variant.current(),
  }
}

test("restores durable agents even when the agent selector is hidden", () => {
  const f = fixture({ session: durable("b", "high", "plan") })
  f.set("visible", false)
  const { local } = f.mount()
  expect(local.agent.visible()).toBe(false)
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("waits for initial configuration and reloads it after reconnecting", () => {
  const f = fixture({ config: "provider/b" })
  f.set("configLoaded", false)
  const { local } = f.mount()
  expect(local.model.ready()).toBe(false)
  expect(local.model.current()).toBeUndefined()
  f.set("connection", "reconnecting")
  f.set("connection", "connected")
  expect(f.configLoads).toEqual(["connected", "reconnecting", "connected"])
  f.set("configLoaded", true)
  expect(local.model.ready()).toBe(true)
  expect(local.model.current()?.id).toBe("b")
})

test("new-session promotion does not mask a command's durable overrides", () => {
  const f = fixture({ session: durable("a", "low") })
  const { local } = f.mount()
  local.session.promote(f.directory, "ses_a", { agent: "build", model: key("a"), variant: "low", choices: {} })
  f.set("sessions", "ses_a", durable("b", "high", "plan"))
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("new-session drafts remember each agent's model and hand off inactive choices", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("b"))] })
  f.set("route", "id", undefined)
  const { local, composer } = f.mount(true)

  if (!composer) throw new Error("missing draft composer")
  composer.set(key("c"))
  composer.variant.set("high")
  local.agent.set("plan")
  expect(composer.current()?.id).toBe("b")
  expect(composer.variant.current()).toBeUndefined()
  local.agent.set("build")
  expect(composer.current()?.id).toBe("c")
  expect(composer.variant.current()).toBe("high")
  local.agent.set("plan")
  const choices = composer.remembered()
  f.set("sessions", "ses_a", durable("b", undefined, "plan"))
  local.session.promote(f.directory, "ses_a", { agent: "plan", model: key("b"), variant: undefined, choices })
  f.set("route", "id", "ses_a")
  local.agent.set("build")
  expect(local.model.current()?.id).toBe("c")
})

test("a promoted draft leaves the next draft empty even when its Session is never opened", () => {
  const f = fixture()
  f.set("route", "id", undefined)
  const { local } = f.mount()
  local.agent.set("plan")
  local.model.set(key("b"))
  local.model.variant.set("high")
  local.session.promote(f.directory, "ses_a", { agent: "plan", model: key("b"), variant: "high", choices: {} })
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: undefined })
  f.set("route", "id", "ses_a")
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("promoting into a workspace no provider shows writes it there and only there", () => {
  const draft = fixture()
  const worktree = fixture()
  draft.set("route", "id", undefined)
  const { local } = draft.mount()
  const choices = { plan: { providerID: "provider", modelID: "c", variant: { type: "named", value: "low" } } } as const
  local.session.promote(worktree.directory, "ses_wt", { agent: "build", model: key("b"), variant: "high", choices })
  local.session.promote(worktree.directory, "ses_other", {
    agent: "build",
    model: key("a"),
    variant: undefined,
    choices,
  })
  expect(stored(worktree.directory).session).toEqual({
    ses_wt: {
      agent: "build",
      choice: { providerID: "provider", modelID: "b", variant: { type: "named", value: "high" } },
      choices,
    },
    ses_other: {
      agent: "build",
      choice: { providerID: "provider", modelID: "a", variant: { type: "default" } },
      choices,
    },
  })
  expect(stored(draft.directory)).toBeUndefined()

  worktree.set("route", "id", "ses_wt")
  const opened = worktree.mount().local
  expect(selection(opened)).toEqual({ agent: "build", model: "b", variant: "high" })
  opened.agent.set("plan")
  expect(selection(opened)).toEqual({ agent: "plan", model: "c", variant: "low" })
  worktree.set("route", "id", "ses_other")
  expect(selection(opened)).toEqual({ agent: "build", model: "a", variant: undefined })
  opened.agent.set("plan")
  expect(selection(opened)).toEqual({ agent: "plan", model: "c", variant: "low" })
})

test("session model picks snapshot the variant rather than following another session's preferences", () => {
  const f = fixture({ session: durable("a") })
  const { local } = f.mount()
  f.setPreferences("variant", "provider/b", "low")
  local.model.set(key("b"))
  f.setPreferences("variant", "provider/b", "high")
  expect(local.model.variant.current()).toBe("low")
})

test("remembers distinct variants for agents using the same model, scoped to the session", () => {
  const f = fixture({ session: durable("a", "low"), agents: [agent("build", key("a")), agent("plan", key("a"))] })
  const { local } = f.mount()
  local.model.variant.set("high")
  local.agent.set("plan")
  local.model.variant.set("low")
  local.agent.set("build")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
  local.agent.set("plan")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })

  f.set("sessions", "ses_b", durable("b", "high"))
  f.set("route", "id", "ses_b")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "high" })
  f.set("route", "id", "ses_a")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
})

test("restores each agent's model and variant after provider remount", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("b"))] })
  const first = f.mount()
  first.local.model.variant.set("high")
  first.local.agent.set("plan")
  first.local.model.set(key("c"))
  first.local.model.variant.set("low")
  first.dispose()
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
  local.agent.set("build")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
  local.agent.set("plan")
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
})

test("changing models drops the old variant even when both models support it", () => {
  const f = fixture({ session: durable("a", "high") })
  const { local } = f.mount()
  local.model.set(key("b"))
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: undefined })
  f.setPreferences("variant", "provider/c", "low")
  local.model.set(key("c"))
  expect(local.model.variant.current()).toBe("low")
})

test("draft model picks keep the variant recorded for the model they select", () => {
  const f = fixture()
  f.set("route", "id", undefined)
  const { composer } = f.mount(true)

  if (!composer) throw new Error("missing draft composer")
  f.setPreferences("variant", "provider/b", "low")
  f.setPreferences("variant", "provider/c", "high")
  composer.set(key("b"))
  expect(composer.current()?.id).toBe("b")
  expect(composer.variant.current()).toBe("low")

  // Another model takes its own recorded variant, never the replaced model's (FR-011/FR-034).
  composer.set(key("c"))
  expect(composer.variant.current()).toBe("high")

  // The pick owns that variant, so a later preference change elsewhere cannot move it under the draft.
  f.setPreferences("variant", "provider/c", "low")
  expect(composer.variant.current()).toBe("high")

  // Nothing recorded for a model means that model's own default, not the variant it replaced.
  composer.set(key("a"))
  expect(composer.variant.current()).toBeUndefined()
})

test("a failed save of the workspace document reaches the selection with its own payload", () => {
  const f = fixture({ session: durable("a") })
  const { local } = f.mount()
  expect(local.model.recordFailure()).toBeUndefined()

  // A save that lands first, so a later failure can name a value storage is known to hold.
  local.model.set(key("b"))
  f.flush()
  expect(local.model.recordFailure()).toBeUndefined()

  f.failWrites()
  local.model.set(key("c"))
  f.flush()

  const failure = local.model.recordFailure()

  if (!failure) throw new Error("missing the failed save")
  // The payload is the document this store tried to write, and the fallback is what storage still holds.
  expect(JSON.parse(failure.attempted).session.ses_a.choice.modelID).toBe("c")
  expect(JSON.parse(failure.fallback!).session.ses_a.choice.modelID).toBe("b")

  // The failed save left the document's newest value unpersisted, so the observation waits: a later save of that
  // same document needs a further edit, and once it lands nothing still claims a failure.
  local.model.variant.set("low")
  f.flush()
  expect(local.model.recordFailure()).toBeUndefined()
})

test("a draft's selection reports the workspace document's failure, never its own", () => {
  const f = fixture()
  const { composer } = f.mount(true)

  if (!composer) throw new Error("missing draft composer")
  const { local } = f.mount()

  f.failWrites()
  local.model.set(key("b"))
  f.flush()

  const failure = local.model.recordFailure()

  if (!failure) throw new Error("missing the failed save")
  // The draft owns no durable record of its own: it shares this workspace document, and so shares what it reports.
  expect(composer.recordFailure()).toEqual(failure)
})

test("a rejected config write reaches the caller that asked for the outcome", async () => {
  const f = fixture()
  const { fallback } = f.mount()

  const reported: unknown[] = []
  const settled = Promise.withResolvers<unknown>()

  f.failConfigWrites()
  fallback.set(key("b"), {
    failed: (cause) => {
      reported.push(cause)
      settled.resolve(cause)
    },
  })

  // One write, one report: the owner keeps its own pending serialization and its own revert, so a pair owner that
  // passes `failed` learns the outcome instead of getting the default toast. The reverted display itself is covered by
  // the `fallback update ordering` table in src/session/composer/selection.test.ts.
  await settled.promise
  expect(reported.length).toBe(1)
})

test("restores durable selection ahead of agent, global, and saved variant defaults", () => {
  const f = fixture({
    session: durable("a", "low", "plan"),
    agents: [agent("build"), agent("plan", key("b"), "high")],
    config: { providerID: "provider", model: "c", variant: "high" },
    preferred: "high",
  })

  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
  local.session.restore({ sessionID: "ses_a", agent: "build", model: key("c") })
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
})

test("uses historical message selection only when durable and local selection are absent", () => {
  const f = fixture()
  const { local } = f.mount()
  local.session.restore({ sessionID: "ses_b", agent: "plan", model: key("b") })
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: undefined })
  local.session.restore({ sessionID: "ses_a", agent: "plan", model: { ...key("b"), variant: "low" } })
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "low" })
  local.model.variant.set("high")
  local.session.restore({ sessionID: "ses_a", agent: "build", model: key("c") })
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("sessions without a selection fall through agent, global, recent, and connected defaults", () => {
  const f = fixture({
    agents: [agent("build", key("b"), "low")],
    config: "provider/c",
  })

  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "low" })
  f.set("agents", [agent("build", key("removed"))])
  expect(local.model.current()?.id).toBe("c")
  f.setPreferences("recent", [key("removed"), key("b")])
  f.set("config", "provider/removed")
  expect(local.model.current()?.id).toBe("b")
  f.setPreferences("recent", [key("removed")])
  expect(local.model.current()?.id).toBe("a")
  f.set("providers", [])
  expect(local.model.current()).toBeUndefined()
})

test("global and agent model/variant defaults react to configuration replacement", () => {
  const f = fixture({ config: { providerID: "provider", model: "a", variant: "low" } })
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  f.set("config", { providerID: "provider", model: "b", variant: "high" })
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "high" })
  f.set("agents", [agent("build", key("a"), "low")])
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  f.set("agents", [agent("build", key("c"), "high")])
  expect(selection(local)).toEqual({ agent: "build", model: "c", variant: "high" })
  f.set("agents", [agent("build")])
  f.set("config", "provider/b")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: undefined })
})

test("durable and explicitly selected Default override a saved variant preference", () => {
  const f = fixture({
    session: durable("a"),
    preferred: "high",
    config: { providerID: "provider", model: "a", variant: "low" },
  })

  const { local } = f.mount()
  expect(local.model.variant.current()).toBeUndefined()
  local.model.variant.set(undefined)
  expect(f.preferences.store.variant["provider/a"]).toBe("default")
  f.set("route", "id", "ses_b")
  expect(local.model.variant.current()).toBeUndefined()
  f.set("route", "id", "ses_a")
  f.setPreferences("variant", "provider/a", "high")
  expect(local.model.variant.current()).toBeUndefined()
  f.set("route", "id", "ses_b")
  expect(local.model.variant.current()).toBe("high")
  f.set("route", "id", "ses_a")
  expect(local.model.variant.current()).toBeUndefined()
})

test("waits for both commit acknowledgments, then releases only the matching draft", () => {
  const f = fixture({ session: durable("b", "low") })
  const { local } = f.mount()
  local.agent.set("plan")
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "plan", model: key("a"), variant: "high" })
  f.set("sessions", "ses_a", durable("b", "low", "plan"))
  f.emit("session.agent.selected")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "high" })
  f.set("sessions", "ses_a", durable("a", "high", "plan"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "low", "plan"))
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
})

test.each(["a", "b"])("a delayed commit preserves the newer %s/low selection", (model) => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  local.model.set(key(model))
  local.model.variant.set("low")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "build", model, variant: "low" })
})

test("a delayed commit preserves a newer agent even when model and variant match", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("a"))] })
  const { local } = f.mount()
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  local.agent.set("plan")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "high" })
})

test("a commit received while its session is inactive does not discard its local selection", () => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  f.set("sessions", "ses_b", durable("b", "low"))
  f.set("route", "id", "ses_b")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "low" })
  f.set("sessions", "ses_a", durable("c", "low"))
  f.set("route", "id", "ses_a")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
})

test("a commit keeps waiting for its echo when the same folder's location reloads", () => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  f.set("locationLoads", 1)
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "low"))
  expect(selection(local)).toEqual({ agent: "build", model: "c", variant: "low" })
})

test("cancelling a failed commit retains the draft and does not cancel a newer commit", () => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  const cancel = local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  cancel()
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "low"))
  expect(local.model.current()?.id).toBe("a")

  local.model.set(key("b"))
  local.model.variant.set("low")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("b"), variant: "low" })
  cancel()
  f.set("sessions", "ses_a", durable("b", "low"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "high"))
  expect(selection(local)).toEqual({ agent: "build", model: "c", variant: "high" })
})

test.each([1, -1] as const)("cycles %p from outside recents to the correct end and wraps", (direction) => {
  const f = fixture({ session: durable("a") })
  f.setPreferences("recent", [key("removed"), key("b"), key("c")])
  const { local } = f.mount()
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "b" : "c")
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "c" : "b")
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "b" : "c")
})

// The pair exchange through the composer's own wrapped slots, driven the way a picker row click drives it: one
// `set()` on the slot the user acted in. These are the browser-owner halves of FR-032's two compensation directions,
// FR-018's supersession and T004's attribution rule; the pure-machine twins live in
// src/session/composer/selection.test.ts.
const pairOf = (controls: ReturnType<typeof createComposerControls>) => {
  const model = controls().model

  return {
    primary: model.selection.key()?.modelID,
    primaryVariant: model.selection.variant.current(),
    fallback: model.fallback.key()?.modelID,
    fallbackVariant: model.fallback.variant.current(),
    status: model.fallbackStatus,
  }
}

/**
 * The pair as the two owners display it, which is what every pair claim below reads.
 */

test("a model row click in either slot promotes the other slot's model and keeps each model's own variant", () => {
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  expect(model.selection.key()).toEqual(key("a"))
  expect(model.fallback.key()).toEqual(key("b"))
  expect(model.fallbackStatus).toBe("model")

  // FR-001/FR-002/FR-009: one row click in the primary picker exchanges the pair, and each model carries the variant
  // it had. Nothing else about the composer moves.
  model.selection.set(key("b"))
  expect(pairOf(controls)).toEqual({
    primary: "b",
    primaryVariant: "high",
    fallback: "a",
    fallbackVariant: "low",
    status: "model",
  })
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "high" })

  // And the other direction, from the fallback picker of a pair in its starting order: the same promotion, and no
  // separate affordance to click instead (FR-004).
  const g = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls: reverse } = g.mount(false, true)
  const backup = reverse().model

  expect(backup.selection.key()).toEqual(key("a"))
  expect(backup.fallback.key()).toEqual(key("b"))

  backup.fallback.set(key("a"))
  // FR-002: both directions from the same start settle on the same pairing, and each model keeps its own variant.
  expect(pairOf(reverse)).toEqual({
    primary: "b",
    primaryVariant: "high",
    fallback: "a",
    fallbackVariant: "low",
    status: "model",
  })
  // FR-003: `recent` moved only for the model the user clicked, never for the displaced one.
  expect(g.preferences.recent()).toEqual([key("a")])
})

test("a model the user hid stays hidden in the ordinary list after the pair exchanges", () => {
  // FR-024/FR-033: the write sites reveal unconditionally, so the exchange undoes that for a model the user hid,
  // while being offered in a picker at all changes nothing about the stored visibility.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b" })
  f.setPreferences("user", [{ ...key("b"), visibility: "hide" }])
  const { controls } = f.mount(false, true)
  const model = controls().model

  expect(model.selection.visible(key("b"))).toBe(false)

  model.selection.set(key("b"))
  expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })
  // Still hidden in the ordinary model list, which is what the picker keeper reads (FR-033).
  expect(model.selection.visible(key("b"))).toBe(false)
  // And `recent` moved only for the model the user clicked (FR-003).
  expect(f.preferences.recent()).toEqual([key("b")])
})

test("an exchange whose config write is rejected restores the primary and reports once", async () => {
  // FR-032 direction 1: the config chain reverts its own slot, so only the primary half is put back, once.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  f.failConfigWrites(2)
  model.selection.set(key("b"))

  // The rejected save's own display is optimistic, so the pair appears for a moment; the compensation follows the
  // rejection, which is why this waits for that save's outcome rather than asserting synchronously.
  await f.settleConfigWrites(1)

  expect(pairOf(controls)).toEqual({
    primary: "a",
    primaryVariant: "low",
    fallback: "b",
    fallbackVariant: "high",
    status: "model",
  })
  // One report, and one compensation: the config chain reverted its own slot, so only the primary half goes back.
  expect(f.reports.length).toBe(1)
  // The rejected write and the reverted display are what the config document holds: nothing was put back into it.
  expect(f.configFallback()).toBe("provider/b#high")
})

test("an exchange whose record write fails restores both halves through the owners", async () => {
  // FR-032 direction 2: the document rolled back wholly, so `publish(undefined)` cannot carry the fallback back;
  // both halves are re-written explicitly (~100 ms later, or now, under a flush).
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  f.failWrites()
  model.selection.set(key("b"))
  f.flush()

  expect(pairOf(controls)).toEqual({
    primary: "a",
    primaryVariant: "low",
    fallback: "b",
    fallbackVariant: "high",
    status: "model",
  })
  // The display alone cannot show that the FALLBACK half went back through its own owner: that owner's config write
  // LANDED, so its slot reads the stored field, which is the exchanged pair until a compensation writes it again. The
  // config document is the direct evidence that both issued writes reached the right owner — the exchange's own PATCH
  // and then the restoration of B with B's own variant — and one report for the attempt (FR-026: one pair write and
  // one compensation per half, never a chain of restorations).
  await f.settleConfigWrites(2)
  expect(f.configWrites()).toEqual([
    { fallback: { providerID: "provider", model: "a", variant: "low" } },
    { fallback: { providerID: "provider", model: "b", variant: "high" } },
  ])
  expect(f.configFallback()).toMatchObject({ providerID: "provider", model: "b", variant: "high" })
  expect(f.reports.length).toBe(1)
  // And the session half went back through ITS owner: this is what the record document holds afterwards.
  f.flush()
  expect(stored(f.directory)?.session?.ses_a?.choice?.modelID).toBe("a")
})

test("a compensation that also fails reports once, retries nothing, and leaves the pair collision-free", async () => {
  // FR-032's honesty limit: one report per attempt, no loop, and the display never shows one model in both slots.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  // Both the pair's config write and the compensation of it fail.
  f.failConfigWrites(4)
  model.selection.set(key("b"))

  // Draining the chain also drains the compensation's own write, which fails the same way: the loop ends when the
  // owner has no further save queued, so nothing can still be in flight behind these assertions.
  await f.settleConfigWrites(1)

  expect(f.reports.length).toBe(1)

  const pair = pairOf(controls)
  expect(pair.primary).toBe("a")
  expect(pair.primary).not.toBe(pair.fallback)
  // The config document never took the exchanged pair, and only that one config write was ever attempted: the
  // compensation of a config rejection rewrites the SESSION half, not the field that just refused it.
  expect(f.configFallback()).toBe("provider/b#high")
  expect(f.configWrites().length).toBe(1)
})

test("a superseded exchange never compensates: A/B, exchange to B/A, select C, old write fails, settling C/B", async () => {
  // FR-018 outranks FR-032, and this is the required sequence. The rejected config write is reverted by the fallback
  // owner's own chain (its optimistic override is dropped, so the slot shows the config's stored value again), while
  // the machine writes nothing: a compensation here would resurrect A, which is no one's current intent.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  model.selection.set(key("b"))
  expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })

  // The user selects C in the primary picker: a newer write, which drops the pending exchange.
  model.selection.set(key("c"))
  expect(model.selection.key()).toEqual(key("c"))

  // The exchange's config save is the one that fails, and it lands after the newer intent, so it can only revert
  // itself: draining that write's outcome is where the old attempt's rejection handling would have run.
  f.failConfigWrites(2)
  await f.settleConfigWrites(1)

  const pair = pairOf(controls)
  expect(pair.primary).toBe("c")
  expect(pair.fallback).toBe("b")
  expect(pair.primary).not.toBe(pair.fallback)
  // And it reports nothing: the attempt had already been dropped by the newer intent, so its outcome neither restores
  // nor tells the user about a superseded action (FR-018 outranks FR-032 once superseded). FR-019's honesty limit is
  // not crossed, because what is on display is exactly what the config holds after its own revert.
  expect(f.reports.length).toBe(0)
  // A machine that compensated would have written A back and failed the assertion above; a machine that reported
  // would fail this one.
})

test("a draft's mirrored document failure never compensates the draft's exchange", () => {
  // T004's exception at the owner level: `createComposerModelSelection` mirrors this workspace's model-selection
  // document (`composer/selection.ts:236-242`), so a failure of that document says nothing about a draft's own write
  // and can never justify putting a pair back. A wrong implementation would restore the pre-exchange pair A/B here.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, composer, controls } = f.mount(true, true)
  const model = controls().model

  // The draft holds A/low in its own prompt state, and the config names B/high, so there is a pair to exchange.
  composer.set(key("a"))
  composer.variant.set("low")
  // A draft's key carries its variant, so this reads as an object match.
  expect(model.selection.key()).toMatchObject(key("a"))
  expect(model.fallback.key()).toEqual(key("b"))

  // A failed save of the workspace document, from an edit that has nothing to do with this draft.
  f.failWrites()
  local.model.set(key("c"))
  f.flush()
  expect(local.model.recordFailure?.()).toBeDefined()

  // The draft exchanges its pair with the config slot, and the outstanding observation is not evidence about it.
  model.selection.set(key("b"))
  f.flush()

  const pair = pairOf(controls)
  expect(pair.primary).toBe("b")
  expect(pair.fallback).toBe("a")
  expect(f.reports.length).toBe(0)
})

test("a failure observation is admitted only when the payload carries this pair, since no save landed, and the attempt is held", () => {
  // T004's three conditions, at the owner level. (i) an earlier save window's payload; (ii) one answered by a later
  // successful save; (iv) the payload does carry the pair while another session dirties the same document.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  // (i) A failure from an earlier save window, whose payload predates the exchanged pair, is not evidence: the
  // exchange claims behind it, and the same observation cannot justify putting the pair back.
  f.failWrites()
  local.model.set(key("a"))
  f.flush()
  model.selection.set(key("b"))
  f.flush()
  expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })

  // (ii) A later successful save of that document answers the outstanding failure, so nothing is known unpromoted.
  f.flush()
  local.model.variant.set("high")
  f.flush()
  model.selection.set(key("a"))
  f.flush()
  expect(pairOf(controls)).toMatchObject({ primary: "a", fallback: "b" })

  // (iv) The payload carries this exchange's pair for this session while another session's edit is in the same
  // document: compensation runs once and reports once, and nothing here claims which session's edit failed.
  f.set("sessions", "ses_b", durable("c", "low", "build"))
  f.failWrites()
  model.selection.set(key("b"))
  f.flush()

  // The observation is still outstanding, and its payload names THIS composer's exchanged pair: model `b` with the
  // variant this exchange wrote into the primary slot, under THIS composer's Session key — and the same document
  // carries the other Session's entry, which is why the payload is read by key rather than scanned (FR-014/T004).
  const failure = local.model.recordFailure()

  if (!failure) throw new Error("the shared document's failed save is still outstanding")

  expect(payloadChoice(failure.attempted, "ses_a")).toEqual({
    model: { providerID: "provider", modelID: "b" },
    variant: "high",
  })
  // The payload has an entry for THIS composer's Session and none for the other one: the guard reads the key, it does
  // not scan the document, so a pair appearing anywhere in a shared window cannot credit this attempt (FR-014/T004).
  expect(payloadChoice(failure.attempted, "ses_b")).toBeUndefined()

  const compensated = pairOf(controls)
  expect(compensated.primary).toBe("a")
  expect(compensated.fallback).toBe("b")
  expect(compensated.primary).not.toBe(compensated.fallback)
  // One compensation, one report: the observation is evidence that THIS composer's record may not be durable, and
  // nothing more — it does not say which session's edit failed, and it is not a per-write causation claim (FR-019).
  expect(f.reports.length).toBe(1)
  // The restore went to this composer's own record, which is what the document holds afterwards.
  expect(stored(f.directory)?.session?.ses_a?.choice?.modelID).toBe("a")
})

test("an inherited pair that would repeat its own primary model is never exchanged, and neither owner is written", async () => {
  // FR-006/FR-017/FR-029/FR-030/FR-034 through the real owners: this Session has no selection of its own, its
  // configured model is A, and the config's `fallback` field names A too, so the composer shows one model and a
  // fallback that would repeat it. There is no pair of records to swap, so reselecting A in either picker writes
  // NOTHING AT ALL: no model write, no variant write, no `recent` push, and no rewrite of a config field that already
  // names it — which is what keeps an unconfigured field distinguishable from a saved no-fallback value.
  const f = fixture({ session: { agent: "build" }, config: "provider/a", fallback: "provider/a" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  expect(model.fallbackStatus).toBe("inactive")

  // No-variant reselects of the model each slot already shows: the pair rule refuses to promote an A/A display, and
  // the write itself has nothing to change. `preferences.recent` is the immediate evidence — the owner's setter pushes
  // that synchronously, and it also publishes its optimistic value synchronously (`fallback-update.ts:36`), before
  // the save itself is queued — so the untouched pair below cannot be a write that has not landed yet. The Session's
  // own record is the other half: a model write would have created this entry, and after the flush there is none.
  model.selection.set(key("a"), { recent: true })
  model.fallback.set(key("a"), { recent: true })
  f.flush()

  expect(f.preferences.recent()).toEqual([])
  expect(stored(f.directory)?.session?.ses_a).toBeUndefined()
  expect(local.model.current()?.id).toBe("a")
  expect(pairOf(controls)).toMatchObject({ primary: "a", fallback: "a", status: "inactive" })

  // A model in neither slot is still an ordinary selection: the dedicated control writes its own slot, and that
  // write is the point of FR-017 rather than a side effect of a pair rule. This is also the positive control for the
  // claim above — the same fixture and the same setter, one write reaching its outcome.
  model.fallback.set(key("c"))
  await f.settleConfigWrites(1)
  expect(f.configWrites()).toEqual([{ fallback: { providerID: "provider", model: "c" } }])
  expect(f.configFallback()).toMatchObject({ providerID: "provider", model: "c" })
})

test("the variant the picker names belongs to the exchange that chose the model; a later variant action supersedes it", async () => {
  // T013/T014/T015 (FR-036 with FR-032 and FR-018). A row click whose flyout named a variant writes the model AND
  // that variant in ONE call (`select-dialog.tsx:536`), so the intent is named at the call site rather than inferred
  // from a second write: the config rejection lands after both, and the attempt has to still be held when it does,
  // with the named variant winning over the one the pair carried.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  f.failConfigWrites(2)
  model.selection.set(key("b"), { recent: true, variant: "low" })
  expect(pairOf(controls)).toMatchObject({ primary: "b", primaryVariant: "low", fallback: "a", fallbackVariant: "low" })

  await f.settleConfigWrites(1)

  // Still one compensation, and it restores the pair the OWNERS held before this action: A with A's own variant `low`,
  // B with B's own `high` — never each model with the other's variant, which is FR-009 read with FR-032.
  expect(pairOf(controls)).toEqual({
    primary: "a",
    primaryVariant: "low",
    fallback: "b",
    fallbackVariant: "high",
    status: "model",
  })
  expect(f.reports.length).toBe(1)
  // One config write attempted, the rejected one: the compensation of a config rejection writes the session half.
  expect(f.configWrites().length).toBe(1)

  // The same exchange again, and this time a contradicting variant write follows the click: a later variant-only
  // action, for the same model in the same slot, with no model identity changing at all, is a newer intent, so the
  // pending exchange is dropped with no restore, and the rejection that lands afterwards reports nothing. The config's
  // own revert leaves the pair colliding, which the composer presents as an inactive fallback rather than two
  // identical active models (FR-029).
  f.failConfigWrites(2)
  model.selection.set(key("b"), { recent: true, variant: "low" })
  model.selection.variant.set("high")

  await f.settleConfigWrites(1)

  expect(pairOf(controls)).toMatchObject({ primary: "b", primaryVariant: "high", fallback: "b", status: "inactive" })
  expect(f.reports.length).toBe(1)
})

test("changing the Session this composer belongs to ends its pending exchange, and the old target's outcome cannot act", async () => {
  // FR-014/T027 through the driver: the route's Session, its workspace and its server together are the target, so
  // moving to another Session drops the pending exchange (and its claims). The rejected config write of the old
  // target lands afterwards: it restores nothing in the new Session and reports nothing about the old one.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  f.failConfigWrites(2)
  model.selection.set(key("b"))
  expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })

  // A second Session with its own durable selection, then the route moves to it. The new Session's own model applies
  // at once; the fallback slot still shows the old action's optimistic value, which its own chain reverts when the
  // rejection lands.
  f.set("sessions", "ses_b", durable("c", "low"))
  f.set("route", "id", "ses_b")

  expect(pairOf(controls)).toMatchObject({ primary: "c", status: "model" })

  await f.settleConfigWrites(1)

  // The rejected write of the previous target reverts its own slot and nothing else: a compensation would have put
  // `a` into this Session's primary slot, and a report would be about an action taken in another Session.
  expect(pairOf(controls)).toMatchObject({ primary: "c", fallback: "b", status: "model" })
  expect(f.reports.length).toBe(0)
})

test("disposing the composer or changing its server ends the pending exchange, and its outcome acts on nothing", async () => {
  // FR-014/T028 at the driver's own edge, where the identity is wired rather than decided: the target is the route's
  // Session, its workspace and its server together (`composer/selection.ts`'s `targetSignature`, mirroring the real
  // `/server/:serverKey/session/:id` route at `shell/routes/routes.tsx:58`), and the composer going away is the same
  // kind of change as a new target arriving — `onCleanup` dispatches `disposed` instead of leaving a flag behind.
  // What may still happen after either is the config owner's OWN revert of its rejected write; what may not is a
  // restore into a target this action no longer belongs to, or a report about an action nobody is looking at.
  for (const leave of ["disposed", "server"] as const) {
    const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
    const { controls, dispose } = f.mount(false, true)
    const model = controls().model

    f.failConfigWrites(1)
    model.selection.set(key("b"))
    expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })

    if (leave === "disposed") dispose()
    else f.set("route", "serverKey", "other-server")

    // The rejection lands after the target is gone: the owner's chain still reverts its own optimistic override, which
    // is that owner's behaviour and not the pair rule's, and the machine is left with no attempt to compensate for.
    await f.settleConfigWrites(1)

    // One write was attempted, the exchange's own, and nothing wrote a restoration of the pre-exchange pair back into
    // the config chain; nothing was reported about an action the driver had already dropped (FR-018/FR-032/FR-014).
    expect(f.configWrites().length).toBe(1)
    expect(f.reports.length).toBe(0)
    // The record document is the other half of the evidence: it holds the exchanged pair the action displayed, and a
    // machine that compensated would have put the pre-exchange model `a` there instead.
    f.flush()
    expect(stored(f.directory)?.session?.ses_a?.choice?.modelID).toBe("b")
  }
})

test("deleting this composer's own Session ends its pending exchange, while a deletion elsewhere leaves it running", async () => {
  // FR-014/T026 at the driver's event wiring, which is where the identity rule has to bite: `session.deleted` naming
  // THIS composer's Session is a target change, so the pending exchange and its claims are dropped before the rejected
  // write lands; `session.deleted` naming any other Session is not a change here, and that exchange still compensates
  // and reports exactly once. In both halves the config owner's OWN chain keeps behaving, since it is keyed per server
  // rather than per composer or Session (`providers/models/fallback-update.ts:13-28`).
  {
    // The Session's own durable model is `c#high` and the recorded fallback is `provider/c#high`, so the composer
    // starts inactive; a plain selection puts `b` in the primary slot, which makes an exchange possible.
    const f = fixture({ session: durable("c", "high"), fallback: "provider/c#high" })
    const { controls } = f.mount(false, true)
    const model = controls().model

    model.selection.set(key("b"))
    expect(pairOf(controls)).toEqual({
      primary: "b",
      primaryVariant: undefined,
      fallback: "c",
      fallbackVariant: "high",
      status: "model",
    })

    // The exchange that promotes C, with its config half armed to be rejected: the attempt is still waiting for that
    // outcome when the Session goes away, and its record half — the document entry naming C — landed.
    f.failConfigWrites(1)
    model.selection.set(key("c"))
    expect(pairOf(controls)).toEqual({
      primary: "c",
      primaryVariant: "high",
      fallback: "b",
      fallbackVariant: undefined,
      status: "model",
    })

    f.emit("session.deleted", "ses_a")

    // The displayed pair did not move: the document entry naming C is gone, so the primary slot falls back to THIS
    // Session's own durable model — the very model and variant the exchange had put there — and the config chain still
    // holds the fallback half this exchange wrote. That is why the deletion itself has to end the composer's target:
    // the pair watch (FR-018) drops a phase only when the pair moved, and here it did not.
    expect(pairOf(controls)).toEqual({
      primary: "c",
      primaryVariant: "high",
      fallback: "b",
      fallbackVariant: undefined,
      status: "model",
    })

    await f.settleConfigWrites(1)

    // The rejection lands after the target is gone. What may still happen is the config owner's OWN revert of its
    // rejected write; what may not is a compensation into the deleted Session or a report about an action taken there.
    // One write was attempted — the exchange's own, of B into the config chain — and nothing patched the pre-exchange
    // pair back. Both slots end up naming C, which the composer presents as an inactive fallback (FR-029), and the
    // deleted Session's own record entry is gone, which is the deletion's owner rather than the pair rule.
    expect(f.reports.length).toBe(0)
    expect(f.configWrites()).toEqual([{ fallback: { providerID: "provider", model: "b" } }])
    expect(f.configFallback()).toBe("provider/c#high")
    expect(pairOf(controls)).toEqual({
      primary: "c",
      primaryVariant: "high",
      fallback: "c",
      fallbackVariant: "high",
      status: "inactive",
    })
    expect(stored(f.directory)?.session?.ses_a).toBeUndefined()
    // Measured against the driver without this deletion mapping: `reports` is 1 and the primary slot reads `b`, the
    // pre-exchange model, restored through the primary owner into a Session nobody is looking at any more. That is the
    // regression this case fails on, and the `sessionID` guard above is what the other half below protects: drop the
    // guard there and that half sees zero reports instead of one.
  }

  {
    // Another Session's deletion, while this composer's exchange is still pending: nothing about this pair changes,
    // so the rejection compensates once and reports once, the way the config-rejection keeper above does.
    const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
    const { controls } = f.mount(false, true)
    const model = controls().model

    f.failConfigWrites(1)
    model.selection.set(key("b"))
    expect(pairOf(controls)).toMatchObject({ primary: "b", fallback: "a" })

    f.emit("session.deleted", "ses_other")

    await f.settleConfigWrites(1)

    // The pair is back to what it was, one report, one write, and the config holds the fallback the exchange had
    // attempted to replace — every assertion the un-perturbed case makes.
    expect(pairOf(controls)).toEqual({
      primary: "a",
      primaryVariant: "low",
      fallback: "b",
      fallbackVariant: "high",
      status: "model",
    })
    expect(f.reports.length).toBe(1)
    expect(f.configWrites().length).toBe(1)
    expect(f.configFallback()).toBe("provider/b#high")
  }
})

test("a ten-selection ordering settles on the last intended pair, with every older intent superseded", async () => {
  // T027 (FR-018 read with FR-011 and FR-032): a rapid run of actions across both slots — an exchange, a variant-only
  // action, ordinary selections, an exchange in the other direction, a rejected write behind an older attempt, and a
  // session that never changes. What the two owners finally hold is the LAST intent's pair; no older attempt writes
  // anything back, and the one report is the one the newest live attempt has to make.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  // 1. A row click in the primary picker exchanges A/B into B/A, each model keeping its own variant.
  model.selection.set(key("b"))
  expect(pairOf(controls)).toEqual({ primary: "b", primaryVariant: "high", fallback: "a", fallbackVariant: "low", status: "model" })
  await f.settleConfigWrites(1)
  f.flush()

  // 2. A variant-only action for the primary slot is a newer intent than nothing, so it simply lands.
  model.selection.variant.set("low")
  expect(pairOf(controls)).toMatchObject({ primary: "b", primaryVariant: "low" })

  // 3. A model in neither slot is an ordinary selection, and it supersedes anything still pending.
  model.selection.set(key("c"), { recent: true })
  expect(pairOf(controls)).toMatchObject({ primary: "c", fallback: "a" })
  f.flush()

  // 4. The fallback picker naming the model now in the PRIMARY slot exchanges again, in the other direction.
  model.fallback.set(key("c"))
  expect(pairOf(controls)).toMatchObject({ primary: "a", fallback: "c" })
  await f.settleConfigWrites(1)
  f.flush()

  // 5-6. Two variant writes in quick succession, one per slot: the pair is untouched, the variants land.
  model.fallback.variant.set("high")
  model.selection.variant.set("high")
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "high", fallback: "c", fallbackVariant: "high" })

  // The fallback owner's variant write is a config save of its own, queued behind the previous one: settling it HERE is
  // what makes the next row's armed failure belong to THAT row's write rather than to a save still in the queue.
  await f.settleConfigWrites(1)

  // 7. An exchange whose config write is REJECTED, taken while no newer action is open: the attempt is still held when
  // the rejection lands, so it compensates ONCE — putting back the pair the owners held before this click, each model
  // with its own variant — and reports once.
  f.failConfigWrites(1)
  model.selection.set(key("c"))
  expect(pairOf(controls)).toMatchObject({ primary: "c", fallback: "a" })
  await f.settleConfigWrites(1)
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "high", fallback: "c" })
  expect(f.reports.length).toBe(1)
  f.flush()

  // 8. A record failure of this document whose payload no longer carries the pair on display admits nothing, and
  // re-selecting the model this slot already shows writes nothing at all — neither is evidence, and neither is a pair
  // to swap (FR-019 read with FR-029).
  f.failWrites()
  local.model.set(key("c"))
  f.flush()
  model.selection.set(key("a"))
  f.flush()
  expect(pairOf(controls)).toMatchObject({ primary: "a", fallback: "c" })
  expect(f.reports.length).toBe(1)

  // 9. A click naming the model sitting in the other slot is a promotion again: the exchange lands, both halves move.
  model.selection.set(key("c"))
  expect(pairOf(controls)).toMatchObject({ primary: "c", fallback: "a" })
  await f.settleConfigWrites(1)
  f.flush()

  // 10. The final intent: the fallback picker names B, which sits in neither slot, so it writes only its own slot.
  model.fallback.set(key("b"))
  await f.settleConfigWrites(1)
  f.flush()

  // The pair the two owners finally hold is the LAST intent's, and the older superseded attempts wrote nothing back:
  // the newest action's writes are the ones the document and the config keep.
  expect(pairOf(controls)).toMatchObject({ primary: "c", primaryVariant: "high", fallback: "b", status: "model" })
  expect(local.model.current()?.id).toBe("c")
  expect(stored(f.directory)?.session?.ses_a?.choice?.modelID).toBe("c")
  expect(f.configFallback()).toMatchObject({ providerID: "provider", model: "b" })
  // One report for the whole sequence: every superseded attempt reported nothing.
  expect(f.reports.length).toBe(1)
})

test("a refused promotion in either picker writes nothing, and a direct exchange call is validated", async () => {
  // FR-006/FR-017/FR-020 (B2/B3 at the owner level). With fallback explicitly off, the fallback picker naming the
  // primary model is promotion-SHAPED but refused: no model change, no variant change, no config PATCH, and no
  // implicit enabling of a fallback the user switched off. A direct `exchange` call naming a target that is not the
  // other slot's model returns `false` and performs zero writes of its own.
  const f = fixture({ session: durable("a", "low"), fallback: null })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  expect(model.fallbackStatus).toBe("off")
  expect(model.fallback.key()).toBeUndefined()

  model.fallback.set(key("a"), { recent: true, variant: "high" })
  f.flush()

  // The evidence is immediate, and that is what makes the `[]` below a claim rather than a race: an owner that WAS
  // asked to write publishes its optimistic value synchronously (`fallback-update.ts:36`) and pushes `recent` in the
  // same call, and a session model write would have created this document's entry, which the flush has settled.
  expect(f.preferences.recent()).toEqual([])
  // Zero config saves attempted either: the stored field staying `null` would also be what a write of the same
  // value leaves it as, so the write list is the evidence that the refused promotion asked the config owner for
  // nothing at all (FR-006/FR-017/FR-029/FR-030).
  expect(f.configWrites()).toEqual([])
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  expect(stored(f.directory)?.session?.ses_a).toBeUndefined()
  expect(model.fallback.key()).toBeUndefined()
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "low", status: "off" })

  // The public entry, called directly with a target that is not the model sitting in the other slot: C is in neither
  // slot, and A is this slot's own model, and the fallback is off. All three are refused, and none of them writes.
  expect(model.exchange(key("c"), "primary")).toBe(false)
  expect(model.exchange(key("a"), "primary")).toBe(false)
  expect(model.exchange(key("a"), "fallback")).toBe(false)
  expect(f.configFallback()).toBeNull()
  expect(f.preferences.recent()).toEqual([])
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })

  // The same entry with the pair the guard admits: one promotion, both halves written once each — which is what
  // makes the refusals above about the guard rather than about an entry point that never writes at all.
  const g = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls: direct, local: directLocal } = g.mount(false, true)
  expect(direct().model.exchange(key("b"), "primary")).toBe(true)
  expect(pairOf(direct)).toEqual({ primary: "b", primaryVariant: "high", fallback: "a", fallbackVariant: "low", status: "model" })
  await g.settleConfigWrites(1)
  g.flush()
  expect(g.configWrites()).toEqual([{ fallback: { providerID: "provider", model: "a", variant: "low" } }])
  expect(directLocal.model.current()?.id).toBe("b")
  expect(stored(g.directory)?.session?.ses_a?.choice?.modelID).toBe("b")
})

// The "None" row's action (T019). It reaches the owner as `set(undefined)`, which is the only form of the fallback
// owner's setter that persists an explicit `null` rather than clearing the field, so these cases read the config
// DOCUMENT itself: the difference between `null` and an absent `fallback` is what tells a reload between the user
// switching recovery off and a config that never named one.
test("the fallback picker's None row writes one explicit null and leaves every other value alone", async () => {
  // FR-012/FR-013 at the owner: the action belongs to the fallback slot and to nothing else.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  expect(model.fallbackStatus).toBe("model")
  expect(model.fallback.enabled()).toBe(true)

  model.fallback.set(undefined)

  // The pair as the chip displays it: the primary half did not move, and the fallback now names nothing.
  expect(pairOf(controls)).toEqual({
    primary: "a",
    primaryVariant: "low",
    fallback: undefined,
    fallbackVariant: undefined,
    status: "off",
  })
  expect(model.fallback.enabled()).toBe(false)
  // The session's own selection and its durable record are untouched, and `recent` gained no entry for an action that
  // selected no model.
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  expect(f.preferences.recent()).toEqual([])

  await f.settleConfigWrites(1)
  // One PATCH, whose field is the literal `null` the field must hold after a reload for recovery to stay off.
  expect(f.configWrites()).toEqual([{ fallback: null }])
  expect(f.configFallback()).toBeNull()
})

/**
 * Drains the config owner's own save queue. `fallback-update.ts:24` issues a save one reaction behind the previous
 * save's outcome, so once `settleConfigWrites` has returned the chain is at its end and a save that WAS asked for
 * already sits in `configWrites()`. The hops are that chain's own shape, not a wait for wall time: this is what makes
 * the `[]` below a claim about what the wrapped setter ASKED the owner for.
 */
const drained = async () => {
  for (let hop = 0; hop < 4; hop += 1) await Promise.resolve()
}

test("a fallback that is already off takes nothing from another None", async () => {
  // FR-013 read with FR-018 (T019): the row the picker marks as current is not a newer intent, so a repeat must
  // neither ask the config owner again nor supersede an exchange that has nothing to do with it.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { controls } = f.mount(false, true)
  const model = controls().model

  model.fallback.set(undefined)
  await f.settleConfigWrites(1)
  expect(f.configWrites()).toEqual([{ fallback: null }])
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "low", status: "off" })

  // The second and third clicks on the row that is already the current entry: still the one PATCH, still the pair
  // the first click left.
  model.fallback.set(undefined)
  model.fallback.set(undefined)
  await drained()
  expect(f.configWrites()).toEqual([{ fallback: null }])
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "low", status: "off" })

  // From a config that already holds the `null`, even the FIRST None writes nothing at all: `off` is already the
  // state this action would leave, and here `off` is that explicit state, never an absent field (FR-013 read with
  // FR-029's `writes nothing at all`).
  const g = fixture({ session: durable("a", "low"), fallback: null })
  const { controls: disabled } = g.mount(false, true)

  expect(pairOf(disabled)).toMatchObject({ status: "off" })
  disabled().model.fallback.set(undefined)
  await drained()
  expect(g.configWrites()).toEqual([])
  expect(g.preferences.recent()).toEqual([])
  expect(pairOf(disabled)).toMatchObject({ primary: "a", primaryVariant: "low", status: "off" })
})

test("the fallback picker's next model choice turns the fallback back on without moving the primary", async () => {
  // FR-013/FR-021: `None` is reversible by an ordinary row click in the same picker, through the same owner that
  // always wrote this slot, and the primary slot never passes through a collision on the way back.
  const f = fixture({ session: durable("a", "low"), fallback: "provider/b#high" })
  const { local, controls } = f.mount(false, true)
  const model = controls().model

  model.fallback.set(undefined)
  await f.settleConfigWrites(1)
  expect(f.configFallback()).toBeNull()
  expect(pairOf(controls)).toMatchObject({ primary: "a", status: "off" })

  model.fallback.set(key("c"), { recent: true })
  expect(model.fallback.enabled()).toBe(true)
  expect(pairOf(controls)).toEqual({
    primary: "a",
    primaryVariant: "low",
    fallback: "c",
    fallbackVariant: undefined,
    status: "model",
  })
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  expect(f.preferences.recent()).toEqual([key("c")])

  await f.settleConfigWrites(1)
  // Two PATCHs in order: the one that switched recovery off, then the one that named a model again. Nothing else
  // was written in between, and the second one replaced the `null` rather than adding to it.
  expect(f.configWrites()).toEqual([
    { fallback: null },
    { fallback: { providerID: "provider", model: "c" } },
  ])
  expect(f.configFallback()).toMatchObject({ providerID: "provider", model: "c" })
})

test("a fallback the config never names keeps the shipped default until None writes it off", async () => {
  // FR-013/SC-007: an ABSENT `fallback` field is not the off state. It answers with the model that shipped before
  // the field existed, and only a None's write can make the next load answer nothing (T019).
  const f = fixture({ session: durable("a", "low") })
  const { controls } = f.mount(false, true)
  const model = controls().model

  expect(f.configFallback()).toBeUndefined()
  expect(model.fallback.enabled()).toBe(true)
  expect(pairOf(controls)).toMatchObject({ status: "model" })
  expect(model.fallback.key()).toEqual({ providerID: "mlx", modelID: "qwen3.8-27b" })

  model.fallback.set(undefined)
  expect(model.fallback.enabled()).toBe(false)
  expect(model.fallback.key()).toBeUndefined()
  expect(pairOf(controls)).toMatchObject({ primary: "a", primaryVariant: "low", status: "off" })

  await f.settleConfigWrites(1)
  // The legacy default was never written on the way: the only PATCH is the one the user asked for, and it holds the
  // `null` that a reload has to read as nothing rather than as an unconfigured field.
  expect(f.configWrites()).toEqual([{ fallback: null }])
  expect(f.configFallback()).toBeNull()
})


