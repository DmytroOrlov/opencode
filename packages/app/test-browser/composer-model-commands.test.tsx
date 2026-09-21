import { describe, expect, mock, test } from "bun:test"
import { createComponent, createContext, createRoot, useContext } from "solid-js"

;(globalThis as typeof globalThis & { React?: { createElement: (component: (props: unknown) => unknown, props: unknown) => unknown } }).React = {
  createElement: (component, props) => component(props),
}

let registered!: () => Array<{ id: string; onSelect?: () => unknown }>
let dialogProps: {
  model: unknown
  items: () => unknown[]
  onSelect: (item: unknown) => unknown
} | undefined

const command = {
  register: (_scope: string, options: () => Array<{ id: string; onSelect?: () => unknown }>) => {
    registered = options
  },
}
mock.module("@/context/command", () => ({ useCommand: () => command }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/layout", () => ({
  useLayout: () => ({ view: () => ({ reviewPanel: {} }), tabs: () => ({ active: () => undefined }) }),
}))
mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
  useLocation: () => ({}),
  useNavigate: () => () => {},
  useSearchParams: () => [{}],
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/repo" }) }))
mock.module("@/context/sync", () => ({ useSync: () => () => ({ data: { agent: [], config: { model: undefined } } }) }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "scope" }) }))
mock.module("@/context/settings", () => ({ useSettings: () => ({ visibility: { customAgents: () => true } }) }))
mock.module("@/context/models", () => ({
  useModels: () => ({
    ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
    find: () => undefined,
    list: () => [],
    recent: { list: () => [], push: () => {} },
    visible: () => true,
    setVisibility: () => {},
    commitSelection: () => {},
    variant: { get: () => undefined, set: () => {}, commit: () => {} },
  }),
}))
mock.module("@/context/local-agent", () => ({
  hasCustomAgent: () => true,
  resolveAgent: (items: Array<{ name: string }>, name?: string) => items.find((item) => item.name === name),
}))
mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    connected: () => [],
    all: () => new Map(),
    default: () => ({}),
    defaultModel: () => undefined,
    paid: () => [],
  }),
}))
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
mock.module("@tanstack/solid-query", () => ({
  createQuery: () => ({ isLoading: false }),
  useQuery: () => ({ isLoading: false }),
  useQueries: () => [],
  useMutation: () => ({ isPending: false, mutateAsync: async () => {} }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  queryOptions: (value: unknown) => value,
}))
mock.module("@/components/directory-picker", () => ({ useDirectoryPicker: () => () => {} }))
mock.module("@/context/global", () => ({ useGlobal: () => ({ ensureServerCtx: () => ({}) }) }))
mock.module("@/context/server", () => ({
  useServer: () => ({ list: [] }),
  serverName: () => "server",
  ServerConnection: { key: () => "server" },
}))
mock.module("@/context/tabs", () => ({ useTabs: () => ({}) }))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: async (render: () => unknown) => render(),
  }),
}))
mock.module("@/components/prompt-input/editor-dom", () => ({
  createTextFragment: () => document.createTextNode(""),
  getCursorPosition: () => 0,
  setCursorPosition: () => {},
  setRangeEdge: () => {},
}))
mock.module("@/components/dialog-select-model", () => ({
  DialogSelectModel: (props: typeof dialogProps) => {
    dialogProps = props as typeof dialogProps
    return null
  },
  ModelSelectorPopover: (props: unknown) => {
    ;(globalThis as typeof globalThis & { __legacyPaidSelector?: unknown }).__legacyPaidSelector = props
    return null
  },
  ModelSelectorPopoverV2: () => null,
}))
mock.module("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ sessionKey: () => "session" }) }))

const runCommandCase = async (controls: {
  selection: object
  pair: {
    primaryModels: () => unknown[]
    selectPrimary: (item: unknown) => unknown
    cycleVariant: () => unknown
  }
}) => {
  const { useComposerCommands } = await import("@/pages/session/use-composer-commands")
  const { LocalProvider } = await import("@/context/local")
  await createRoot(async (dispose) => {
    let finished!: () => void
    const done = new Promise<void>((resolve) => (finished = resolve))
    const Probe = () => {
      void (async () => {
        useComposerCommands({ model: controls })
        const choose = registered().find((item) => item.id === "model.choose")!
        await choose.onSelect?.()
        const props = dialogProps!
        expect(props.model).toBe(controls.selection)
        expect(props.items).toBe(controls.pair.primaryModels)
        expect(props.onSelect).toBe(controls.pair.selectPrimary)
        finished()
      })()
      return null
    }
    createComponent(LocalProvider, { get children() { return createComponent(Probe, {}) } })
    await done
    dispose()
  })
}

describe("registered composer model command boundary", () => {
  test("normal session uses the controls pair and never calls selection.set", async () => {
    let directSet = 0
    let selected: unknown
    const hiddenFallback = { id: "fallback", hidden: true }
    const pair = {
      primaryModels: () => [hiddenFallback],
      selectPrimary: (item: unknown) => {
        selected = item
      },
      cycleVariant: () => {},
    }
    const selection = { set: () => directSet++ }
    await runCommandCase({ selection, pair })
    await dialogProps!.onSelect(hiddenFallback)
    expect(selected).toBe(hiddenFallback)
    expect(directSet).toBe(0)
    expect(pair.primaryModels()).toContain(hiddenFallback)
  })

  test("legacy no-ID and dedicated new-session paths preserve their authoritative pair instances", async () => {
    const cases = [
      { name: "legacy no-ID", selection: {}, pair: { primaryModels: () => [], selectPrimary: () => {}, cycleVariant: () => {} } },
      { name: "dedicated new-session", selection: {}, pair: { primaryModels: () => [], selectPrimary: () => {}, cycleVariant: () => {} } },
    ]
    for (const controls of cases) {
      await runCommandCase(controls)
      expect(dialogProps!.onSelect).toBe(controls.pair.selectPrimary)
      expect(dialogProps!.model).toBe(controls.selection)
    }
  })

  test("dedicated new-session controls reuse the prompt selection pair", async () => {
    const { createPromptInputController } = await import("@/pages/session/composer/session-composer-controls")
    const { LocalProvider } = await import("@/context/local")
    const authoritativePair = {
      primaryModels: () => [],
      selectPrimary: () => {},
      cycleVariant: () => {},
    }
    const selection = { pair: authoritativePair }
    let controls!: ReturnType<typeof createPromptInputController>
    await createRoot(async (dispose) => {
      let finished!: () => void
      const done = new Promise<void>((resolve) => (finished = resolve))
      const Probe = () => {
        controls = createPromptInputController({
          sessionKey: () => "new-session",
          sessionID: () => undefined,
          queryOptions: { agents: () => ({}), providers: () => ({}) },
          model: selection,
        })
        finished()
        return null
      }
      createComponent(LocalProvider, { get children() { return createComponent(Probe, {}) } })
      await done
      dispose()
    })
    expect(controls().model.pair).toBe(authoritativePair)
  })
})
