import { describe, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { createContext, useContext } from "solid-js"

let params: { id?: string } = { id: "session" }
const provider = {
  id: "provider",
  name: "provider",
  models: {
    primary: { id: "primary", name: "primary", variants: { high: {}, low: {} }, release_date: "2026-01-01" },
    other: { id: "other", name: "other", variants: { high: {}, low: {} }, release_date: "2026-01-01" },
  },
}
const catalog = Object.values(provider.models).map((item) => ({ ...item, provider, latest: true }))
const models = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  find: (key: { providerID: string; modelID: string }) => catalog.find((item) => item.id === key.modelID),
  recent: { list: () => [], push: () => {} },
  visible: () => true,
  setVisibility: () => {},
  commitSelection: () => {},
  variant: { get: () => undefined, set: () => {}, commit: () => {} },
}
const serverSync = {
  data: { config: { model: undefined, fallback: { model: "provider/other", variant: "low" } } },
  set: (_scope: string, _key: string, value: unknown) => {
    serverSync.data.config.fallback = value as { model: string; variant: string | null }
  },
  updateConfig: async () => {
    if (!controlledUpdate) throw new Error("rejected")
    await new Promise<void>((_resolve, reject) => {
      rejectPendingUpdate = reject
    })
  },
}
let controlledUpdate = false
let rejectPendingUpdate: ((error: Error) => void) | undefined

mock.module("@solidjs/router", () => ({
  useParams: () => params,
  useLocation: () => ({}),
  useNavigate: () => () => {},
  useSearchParams: () => [{}],
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/repo" }) }))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    data: {
      agent: [
        { name: "build", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "primary" }, variant: "high" },
        { name: "other", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "other" }, variant: "low" },
      ],
      config: { model: undefined },
    },
  }),
}))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "scope", server: "server" }) }))
mock.module("@/context/settings", () => ({ useSettings: () => ({ visibility: { customAgents: () => true } }) }))
mock.module("@/context/models", () => ({ useModels: () => ({ ...models, list: () => catalog }) }))
mock.module("@/context/local-agent", () => ({
  hasCustomAgent: () => true,
  resolveAgent: (items: Array<{ name: string }>, name?: string) => items.find((item) => item.name === name),
}))
mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    connected: () => [provider],
    all: () => new Map([[provider.id, provider]]),
    default: () => ({ provider: "primary" }),
    defaultModel: () => undefined,
    paid: () => [provider],
  }),
}))
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => serverSync }))
mock.module("@/utils/persist", () => ({
  Persist: { serverWorkspace: () => "target" },
  PersistTesting: {},
  draftPersistedKeys: () => [],
  removePersisted: () => {},
  persisted: (_target: unknown, initial: readonly [unknown, unknown]) => {
    return [initial[0], initial[1], undefined, Object.assign(() => true, { promise: Promise.resolve(true) })]
  },
}))
mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: (props: unknown) => unknown }) => {
    const context = createContext<unknown>()
    return {
      use: () => useContext(context),
      provider: (props: { children?: unknown }) =>
        createComponent(context.Provider, { value: input.init(props), get children() { return props.children } }),
    }
  },
}))

const loadLocal = async () => await import("@/context/local")

describe("real local model selection rollback", () => {
  test("preserves newer agent state during failed fallback-only persistence", async () => {
    params = { id: "session" }
    const { LocalProvider, useLocal } = await loadLocal()
    await createRoot(async (dispose) => {
      let finished!: () => void
      const done = new Promise<void>((resolve) => (finished = resolve))
      const Probe = () => {
        const local = useLocal()
        void (async () => {
          const { createModelPairController } = await import("@/pages/session/composer/prompt-model-selection")
          const pair = createModelPairController({ selection: local.model })
          const fallbackItem = catalog.find((item) => item.id === "other")!
          controlledUpdate = true
          const failedPrimary = pair.selectPrimary(fallbackItem)
          for (let attempt = 0; attempt < 10 && !rejectPendingUpdate; attempt++) await Promise.resolve()
          local.agent.set("other")
          rejectPendingUpdate!(new Error("rejected"))
          await failedPrimary
          expect(local.agent.current()?.name).toBe("other")
          expect(local.model.current()?.id).toBe("other")
          expect(local.model.variant.current()).toBe("low")

          controlledUpdate = false
          const operation = pair.selectFallbackVariant("high")
          await operation
          expect(local.agent.current()?.name).toBe("other")
          expect(local.model.current()?.id).toBe("other")
          expect(local.model.variant.current()).toBe("low")

          const newerOperation = pair.selectFallbackVariant("high")
          local.agent.set("other")
          await newerOperation
          expect(local.agent.current()?.name).toBe("other")
          expect(local.model.current()?.id).toBe("other")
          expect(local.model.variant.current()).toBe("low")
          rejectPendingUpdate = undefined
          controlledUpdate = false
          finished()
        })()
        return null
      }
      createComponent(LocalProvider, { get children() { return createComponent(Probe, {}) } })
      await done
      dispose()
    })
  })

  test("restores only the no-ID draft model fields", async () => {
    params = {}
    const { LocalProvider, useLocal } = await loadLocal()
    await createRoot(async (dispose) => {
      let finished!: () => void
      const done = new Promise<void>((resolve) => (finished = resolve))
      const Probe = () => {
        const local = useLocal()
        const snapshot = local.model.snapshot()
        void local.model.set({ providerID: "provider", modelID: "other" }).then(() => {
          snapshot.restore()
          expect(local.model.current()?.id).toBe("primary")
          finished()
        })
        return null
      }
      createComponent(LocalProvider, { get children() { return createComponent(Probe, {}) } })
      await done
      dispose()
    })
  })
})
