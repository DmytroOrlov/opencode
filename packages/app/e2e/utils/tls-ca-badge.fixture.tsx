import { MemoryRouter, createMemoryHistory, useLocation, useNavigate } from "@solidjs/router"
import type { Bridge } from "@opencode/plugin/gui/host"
import { base64Encode } from "@opencode/util/encode"
import { createMemo, createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { PlatformProvider, type Platform } from "../../src/runtime/platform/platform"
import { createWebPlatform } from "../../src/runtime/platform/web"
import { ServerConnection } from "../../src/runtime/server/registry"
import { useGlobal } from "../../src/runtime/server/runtime"
import { useTabs } from "../../src/shell/tabs/tabs"

type FixtureServerID = "a" | "b" | "sidecar"

type FixtureLayoutWrite = { server?: string; directory?: string }

export const TLS_CA_BADGE_SERVERS = {
  a: "http://127.0.0.1:4096",
  b: "http://127.0.0.1:4097",
} as const

const sessionA = "ses_server_a"
const sessionB = "ses_server_b"
const sessionSidecar = "ses_server_a"
const draftID = "fixture-draft"

const routes = {
  home: "/",
  sessionA: `/server/${base64Encode(TLS_CA_BADGE_SERVERS.a)}/session/${sessionA}`,
  sessionB: `/server/${base64Encode(TLS_CA_BADGE_SERVERS.b)}/session/${sessionB}`,
  sidecarSession: `/server/${base64Encode("sidecar")}/session/${sessionSidecar}`,
  draft: `/new-session?draftId=${encodeURIComponent(draftID)}`,
  settings: "/settings",
  settingsModelsA: `/settings?${new URLSearchParams({ server: TLS_CA_BADGE_SERVERS.a, tab: "models" })}`,
  settingsProjectA: `/settings?${new URLSearchParams({
    server: TLS_CA_BADGE_SERVERS.a,
    project: "/work/a",
    tab: "general",
  })}`,
}

declare global {
  interface Window {
    __tlsCaFixture?: {
      routes: typeof routes
      present(): Record<FixtureServerID, boolean>
      add(id: FixtureServerID): void
      remove(id: FixtureServerID): void
      replaceAPassword(password: string): void
      releaseStorage(): void
      layoutWrites(): FixtureLayoutWrite[]
      path(): string
      navigate(path: string): void
      draftServer(id: string): string | undefined
      health(key: string): { type: string; tlsCaMode?: "bundled" | "system" } | undefined
    }
  }
}

/**
 * Mounts the real app with three identities: two HTTP servers on separate ports and the desktop sidecar, which
 * shares HTTP A's endpoint but has its own key and credentials. Controls change the registry's provided list,
 * navigate the MemoryRouter and release held storage.
 */
export function mount(input: { route?: string | null; hold?: string | null; platform?: string | null }) {
  const root = document.getElementById("root")

  if (!root) throw new Error("Missing fixture root")

  const history = createMemoryHistory()
  history.set({ value: input.route ?? "/", replace: true, scroll: false })

  const [entries, setEntries] = createSignal<Record<FixtureServerID, ServerConnection.Any>>({
    a: {
      type: "http",
      displayName: "Server A",
      http: { url: TLS_CA_BADGE_SERVERS.a, password: "fixture-a" },
    },
    b: {
      type: "http",
      displayName: "Server B",
      http: { url: TLS_CA_BADGE_SERVERS.b, password: "fixture-b" },
    },
    sidecar: {
      type: "sidecar",
      variant: "base",
      displayName: "Desktop background server",
      http: { url: TLS_CA_BADGE_SERVERS.a, password: "fixture-sidecar" },
    },
  })

  const [present, setPresent] = createSignal<Record<FixtureServerID, boolean>>({
    a: true,
    b: true,
    sidecar: true,
  })

  const connections = createMemo(() =>
    (["a", "b", "sidecar"] as const).flatMap((id) => (present()[id] ? [entries()[id]] : [])),
  )

  const held = Promise.withResolvers<void>()
  const hold = input.hold ? new RegExp(input.hold) : undefined
  const [layoutWrites, setLayoutWrites] = createSignal<FixtureLayoutWrite[]>([])

  const storage = (name?: string) => {
    const item = (key: string) => (name ? `${name}:${key}` : key)

    return {
      getItem: async (key: string) => {
        if (hold?.test(item(key))) await held.promise

        return localStorage.getItem(item(key))
      },
      setItem: async (key: string, value: string) => {
        const stored = item(key)

        localStorage.setItem(stored, value)

        if (stored !== "opencode.global.dat:layout") return
        const home = JSON.parse(value)?.home?.selection as FixtureLayoutWrite | undefined

        if (home) setLayoutWrites((writes) => [...writes, { server: home.server, directory: home.directory }])
      },
      removeItem: async (key: string) => localStorage.removeItem(item(key)),
    }
  }

  const unused = async () => {
    throw new Error("Unexpected fixture action")
  }

  // A desktop window with main's plugin host reporting no plugin GUIs. Without it the startup gate waits out its
  // activation and server timeouts before the app interface mounts.
  const bridge: Bridge = {
    packaged: false,
    call: unused,
    // SSH is the only built-in contributing servers on this platform; an empty live state settles startup without
    // waiting for the server gate's timeout.
    subscribe: async (ipc) =>
      ipc === "ssh" ? { available: true, state: { revision: 0, servers: [] } } : { available: false },
    on: () => () => undefined,
    embed: () => undefined,
    capture: async () => undefined,
    runMenubarItem: () => undefined,
    configure: () => undefined,
    pluginGuis: async () => ({ plugins: [], reserved: [] }),
    manager: {
      list: async () => [],
      enable: async () => undefined,
      disable: async () => undefined,
      reload: async () => undefined,
    },
  }

  const desktop: Platform = {
    platform: "desktop",
    os: "linux",
    windowID: "browser",
    openExternal: () => undefined,
    openDirectoryPickerDialog: async () => null,
    notify: async () => undefined,
    restart: unused,
    storage,
    plugins: bridge,
  }

  // The health lifecycle needs no desktop-only surface; the web platform keeps terminal support, another `/api/info`
  // client, out of those identity-level request counts.
  const platform = input.platform === "web" ? createWebPlatform("tls-ca-badge").platform : desktop

  let navigate: (path: string) => void = () => undefined
  let path = () => ""
  let draftServer = (_id: string): string | undefined => undefined
  let health = (_key: string): { type: string; tlsCaMode?: "bundled" | "system" } | undefined => undefined

  window.__tlsCaFixture = {
    routes,
    present,
    add(id) {
      setPresent((current) => ({ ...current, [id]: true }))
    },
    remove(id) {
      setPresent((current) => ({ ...current, [id]: false }))
    },
    replaceAPassword(password) {
      setEntries((current) => ({
        ...current,
        a: current.a.type === "http" ? { ...current.a, http: { ...current.a.http, password } } : current.a,
      }))
    },
    releaseStorage() {
      held.resolve()
    },
    layoutWrites,
    path: () => path(),
    navigate(target) {
      navigate(target)
    },
    draftServer: (id) => draftServer(id),
    health: (key) => health(key),
  }

  function FixtureNavigation() {
    const location = useLocation()
    const go = useNavigate()
    const tabs = useTabs()
    const global = useGlobal()

    path = () => `${location.pathname}${location.search}`

    draftServer = (id) => tabs.store.find((item) => item.type === "draft" && item.draftID === id)?.server

    health = (key) => {
      const record = global.servers.health[key as ServerConnection.Key]

      if (!record) return undefined

      return record.type === "healthy"
        ? { type: record.type, ...(record.tlsCaMode ? { tlsCaMode: record.tlsCaMode } : {}) }
        : { type: record.type }
    }

    onMount(() => {
      navigate = (target) => go(target)
    })

    return null
  }

  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale="en">
          <AppInterface
            servers={connections()}
            canonicalLocalServer={ServerConnection.key(entries().sidecar)}
            router={(props) => <MemoryRouter {...props} history={history} />}
          >
            <FixtureNavigation />
          </AppInterface>
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
