import { expect, test, type Page, type Request, type Route } from "@playwright/test"
import { base64Encode } from "@opencode/util/encode"
import { holdRoute, project, provider, seed, session, type SeedInput } from "../utils/app"
import { mockServers } from "../utils/mock-server"

const A = "http://127.0.0.1:4096"
const B = "http://127.0.0.1:4097"
const directoryA = "/work/a"
const directoryB = "/work/b"
const sessionA = session({ id: "ses_server_a", directory: directoryA, title: "Server A session" })
const sessionB = session({ id: "ses_server_b", directory: directoryB, title: "Server B session" })
const draftID = "fixture-draft"
const FIXTURE = "/e2e/utils/tls-ca-badge.html"

const routes = {
  home: "/",
  sessionA: `/server/${base64Encode(A)}/session/${sessionA.id}`,
  sessionB: `/server/${base64Encode(B)}/session/${sessionB.id}`,
  sidecarSession: `/server/${base64Encode("sidecar")}/session/${sessionA.id}`,
  settingsProjectA: `/settings?${new URLSearchParams({ server: A, project: directoryA, tab: "general" })}`,
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
}

type TlsCaMode = "bundled" | "system" | undefined
type AliasAnswer = { status?: number; tlsCaMode?: TlsCaMode }
type AliasGate = {
  answer: AliasAnswer
  arrived: PromiseWithResolvers<Request>
  release: PromiseWithResolvers<void>
  done: PromiseWithResolvers<void>
}

const auth = (password: string) => `Basic ${btoa(`opencode:${password}`)}`
const authA = new Set([auth("fixture-a"), auth("fixture-a2")])
const authSidecar = auth("fixture-sidecar")

test.use({ serviceWorkers: "block" })

function fixtureUrl(params: Record<string, string> = {}) {
  return `${FIXTURE}?${new URLSearchParams(params)}`
}

function badge(page: Page) {
  return page.locator('[data-slot="titlebar-v2"] [role="status"]')
}

async function expectBadge(
  page: Page,
  label: "CA:BUNDLED" | "CA:SYSTEM" | "CA:UNKNOWN",
  timeout = 30_000,
) {
  const element = badge(page)
  const tone = label === "CA:BUNDLED" ? "success" : label === "CA:SYSTEM" ? "warning" : "danger"

  await expect(element).toHaveText(label, { timeout })
  await expect(element).toHaveClass(new RegExp(`bg-v2-state-bg-${tone}`))
  await expect(element).toHaveClass(new RegExp(`text-v2-state-fg-${tone}`))
}

async function expectBadgeTooltip(page: Page, text: string) {
  await badge(page).hover()
  await expect(page.getByRole("tooltip")).toHaveText(text)
}

async function openSettings(page: Page) {
  const mac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))

  await page.keyboard.press(mac ? "Meta+," : "Control+,")
  await expect(page.getByTestId("settings-screen")).toBeVisible()
}

async function openSettingsFromSidebar(page: Page) {
  await page.locator('[data-action="vertical-tabs-settings"]').click()
  await expect(page.getByTestId("settings-screen")).toBeVisible()
}

function serverConfig(directory: string, sessions: ReturnType<typeof session>[], extra: Record<string, unknown> = {}) {
  return {
    directory,
    project: project({ id: `proj_${directory.replace(/\W/g, "_")}`, directory }),
    provider: provider({ id: "test", name: "Test" }),
    sessions,
    pageMessages: () => ({ items: [] }),
    fileList: () => [],
    ...extra,
  }
}

async function installAliasInfo(page: Page, defaults: { a?: AliasAnswer; sidecar?: AliasAnswer } = {}) {
  const answers: Record<"a" | "sidecar", AliasAnswer> = {
    a: defaults.a ?? { tlsCaMode: "bundled" },
    sidecar: defaults.sidecar ?? {},
  }
  const counts = { a: 0, sidecar: 0 }
  const gates: Record<"a" | "sidecar", AliasGate[]> = { a: [], sidecar: [] }

  const fulfill = (route: Route, answer: AliasAnswer) => {
    if (answer.status === 401)
      return route.fulfill({
        status: 401,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }),
      })

    return route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        version: "2.0.0",
        pid: 1,
        urls: [A],
        paths: { tmp: "/tmp/opencode" },
        ...(answer.tlsCaMode ? { tlsCaMode: answer.tlsCaMode } : {}),
      }),
    })
  }

  await page.route(`${A}/api/info`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors })
    const authorization = await route.request().headerValue("authorization")
    const identity = authA.has(authorization ?? "")
      ? "a"
      : authorization === authSidecar
        ? "sidecar"
        : undefined

    if (!identity) return fulfill(route, { status: 401 })

    counts[identity] += 1
    const gate = gates[identity].shift()

    if (!gate) return fulfill(route, answers[identity])

    gate.arrived.resolve(route.request())
    await gate.release.promise
    await fulfill(route, gate.answer)
    gate.done.resolve()
  })

  return {
    counts,
    set(identity: "a" | "sidecar", answer: AliasAnswer) {
      answers[identity] = answer
    },
    hold(identity: "a" | "sidecar", answer: AliasAnswer) {
      const gate: AliasGate = {
        answer,
        arrived: Promise.withResolvers<Request>(),
        release: Promise.withResolvers<void>(),
        done: Promise.withResolvers<void>(),
      }

      gates[identity].push(gate)

      return {
        arrived: gate.arrived.promise,
        release: () => gate.release.resolve(),
        done: gate.done.promise,
      }
    },
  }
}

function infoIdentity(request: Request): "a" | "b" | "sidecar" | undefined {
  if (request.method() !== "GET") return
  const url = new URL(request.url())

  if (url.pathname !== "/api/info") return

  if (url.origin === B) return "b"

  if (url.origin !== A) return
  const authorization = request.headers()["authorization"]

  if (authA.has(authorization ?? "")) return "a"

  if (authorization === authSidecar) return "sidecar"
}

function infoRequests(page: Page) {
  const counts = { a: 0, b: 0, sidecar: 0 }
  const pending = new Set<Request>()
  const settle = (request: Request) => {
    pending.delete(request)
  }

  page.on("request", (request) => {
    const identity = infoIdentity(request)

    if (!identity) return
    counts[identity]++
    pending.add(request)
  })
  page.on("requestfinished", settle)
  page.on("requestfailed", settle)

  return { counts, pending: () => pending.size }
}

async function setup(
  page: Page,
  input: {
    seed?: SeedInput
    empty?: boolean
    aDefaults?: { a?: AliasAnswer; sidecar?: AliasAnswer }
    b?: { mode?: TlsCaMode; password?: string }
  } = {},
) {
  const b = { mode: input.b?.mode ?? "system", password: input.b?.password ?? "fixture-b" }
  const info = infoRequests(page)
  const requests = info.counts

  await mockServers(page, {
    [A]: {
      ...serverConfig(
        directoryA,
        input.empty ? [] : [sessionA],
        input.empty ? { projects: [] } : {},
      ),
      tlsCaMode: undefined,
    },
    [B]: {
      ...serverConfig(
        directoryB,
        input.empty ? [] : [sessionB],
        input.empty ? { projects: [] } : {},
      ),
      password: () => b.password,
      tlsCaMode: () => b.mode,
    },
  })

  const alias = await installAliasInfo(page, input.aDefaults)

  if (input.seed) await seed(page, input.seed)

  return { alias, requests, pendingInfo: info.pending, b }
}

async function focusHomeServer(page: Page, name: string) {
  await page
    .locator("[data-home-row]")
    .filter({ hasText: name })
    .getByRole("button", { name: new RegExp(name) })
    .click()
}

// Focuses a server whose health the test still holds: the row itself is disabled while checking, but its real add
// project action selects the resolved server once the folder is added.
async function addHomeProjectToServer(page: Page, name: string) {
  const row = page.locator("[data-home-row]").filter({ hasText: name })

  await row.hover()
  await row.getByRole("button", { name: "Add project", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Select folder", exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => window.__tlsCaFixture?.navigate(path), path)
}

test("tabless Home follows the focused server and resolves each identity without extra probes", async ({ page }) => {
  await page.clock.install()
  const { alias, requests } = await setup(page, { aDefaults: { sidecar: {} } })
  const heldA = alias.hold("a", { tlsCaMode: "bundled" })
  const heldB = await holdRoute(page, `${B}/api/info`, { method: "GET" })

  await page.goto(fixtureUrl())
  await heldA.arrived
  await heldB.arrived

  // A is still checking, so its own answer is not accepted yet. B is checking too; the sidecar reports no mode.
  await expectBadge(page, "CA:UNKNOWN")
  await expect(page.locator("[data-home-row]").filter({ hasText: "Server B" })).toBeVisible()

  heldA.release()
  await expectBadge(page, "CA:BUNDLED")
  await expect.poll(() => ({ ...requests })).toEqual({ a: 1, b: 1, sidecar: 1 })
  await expectBadgeTooltip(page, "Bundled CA trust set verified at startup.")

  // Switching to a still-checking identity shows unknown until that identity's own answer arrives. Neither the
  // focused Home binding nor the badge needs another navigation to accept it.
  await addHomeProjectToServer(page, "Server B")
  await expectBadge(page, "CA:UNKNOWN")
  heldB.release()
  await expectBadge(page, "CA:SYSTEM")
  await expectBadgeTooltip(page, "System CA trust set verified at startup.")

  await focusHomeServer(page, "Desktop background server")
  await expectBadge(page, "CA:UNKNOWN")
  await expectBadgeTooltip(page, "TLS CA trust set was not verified.")

  await focusHomeServer(page, "Server A")
  await expectBadge(page, "CA:BUNDLED")

  // Context switching does not add a probe. One second stays inside the 10-second poll and past the 750 ms cache.
  await page.clock.fastForward(1_000)
  expect({ ...requests }).toEqual({ a: 1, b: 1, sidecar: 1 })

  await navigate(page, routes.sessionB)
  await expectBadge(page, "CA:SYSTEM")
  await expect(page.getByRole("heading", { name: sessionB.title })).toBeVisible()

  // The session route and its Settings surface let the terminal capability owner make its one B support check. The
  // titlebar adds none: the same count remains across this cycle and every later route/Settings cycle.
  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")
  await expect.poll(() => requests.b).toBe(2)
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  expect({ ...requests }).toEqual({ a: 1, b: 2, sidecar: 1 })
  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")

  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")
  await page.getByTestId("settings-screen").getByRole("button", { name: "Back to app", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")

  await navigate(page, routes.home)
  await expectBadge(page, "CA:BUNDLED")
  expect({ ...requests }).toEqual({ a: 1, b: 2, sidecar: 1 })

  await page.clock.fastForward(1_000)
  expect({ ...requests }).toEqual({ a: 1, b: 2, sidecar: 1 })
})

test("tabless Home with an empty database keeps its captured context in Settings", async ({ page }) => {
  await setup(page, { empty: true, aDefaults: { sidecar: {} } })
  await page.goto(fixtureUrl())

  // The empty project and session inventories still render the real Home with the local server's verified mode.
  await expectBadge(page, "CA:BUNDLED")
  await expect(page.getByText("Nothing here yet", { exact: true })).toBeVisible()
  await expect(page.getByText("Create a session to get started", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="home-project-row"]')).toHaveCount(0)
  await expect(page.locator('[data-component="home-session-row-container"]')).toHaveCount(0)
  await expect(page.locator("[data-home-row]").filter({ hasText: "Server B" })).toBeVisible()

  // Opening Settings from Home captures A even though no session exists to open.
  await openSettings(page)
  await expectBadge(page, "CA:BUNDLED")
  await page.getByTestId("settings-screen").getByRole("button", { name: "Back to app", exact: true }).click()
  await expectBadge(page, "CA:BUNDLED")

  // The empty B server is still a real Home selection and Settings captures its system mode.
  await focusHomeServer(page, "Server B")
  await expectBadge(page, "CA:SYSTEM")
  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")
})

test("route ownership resolves session, draft and removed identities exactly", async ({ page }) => {
  await setup(page, { aDefaults: { sidecar: {} } })
  await page.goto(fixtureUrl())

  await expectBadge(page, "CA:BUNDLED")
  const metadata = await holdRoute(page, new RegExp(`/api/session/${sessionB.id}(\\?|$)`), { method: "GET" })

  await navigate(page, routes.sessionB)
  await metadata.arrived
  // No tab exists yet; the route's own server still owns the badge.
  await expectBadge(page, "CA:SYSTEM")

  await navigate(page, routes.home)
  await expectBadge(page, "CA:BUNDLED")

  // Remove only A. Its route keeps the exact key, and no other healthy server fills in.
  await navigate(page, routes.sessionA)
  await expectBadge(page, "CA:BUNDLED")
  await page.evaluate(() => window.__tlsCaFixture!.remove("a"))
  await expectBadge(page, "CA:UNKNOWN")
  await page.evaluate(() => window.__tlsCaFixture!.add("a"))
  await expectBadge(page, "CA:BUNDLED")

  metadata.release()
  await expectBadge(page, "CA:BUNDLED")
})

test("a direct session route owns the badge before its session tab exists", async ({ page }) => {
  await setup(page, { aDefaults: { sidecar: {} } })
  const metadata = await holdRoute(page, new RegExp(`/api/session/${sessionB.id}(\\?|$)`), { method: "GET" })

  await page.goto(fixtureUrl({ route: routes.sessionB }))
  await metadata.arrived

  // The route names B from the first frame, with no Home badge and no session tab to borrow.
  await expectBadge(page, "CA:SYSTEM")
  await expect(page.locator("[data-titlebar-tab]")).toHaveCount(0)
  metadata.release()
})

test("Settings opened from a resolved session keeps that session server", async ({ page }) => {
  await setup(page, { aDefaults: { sidecar: {} } })

  await page.goto(fixtureUrl({ route: routes.sessionB }))
  await expect(page.getByRole("heading", { name: sessionB.title })).toBeVisible()
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toBeVisible()

  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
})

test("a draft resolves only once its own tab exists", async ({ page }) => {
  const { alias } = await setup(page, {
    empty: true,
    seed: {
      tabs: [{ draft: draftID, directory: directoryB, server: B }],
      storage: {
        "opencode.global.dat:layout": { home: { selection: { server: A } } },
      },
    },
  })
  await page.goto(
    fixtureUrl({
      route: `/new-session?draftId=${encodeURIComponent(draftID)}`,
      hold: "^opencode\\.window\\.browser\\.dat:tabs$",
    }),
  )

  // The draft is not in the store yet. Home's stored selection is A, but an unresolved draft borrows neither.
  await expectBadge(page, "CA:UNKNOWN")
  await expect(page.getByText(sessionA.title, { exact: true })).toHaveCount(0)

  await page.evaluate(() => window.__tlsCaFixture!.releaseStorage())
  await expectBadge(page, "CA:SYSTEM")
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toBeVisible()
  expect(alias.counts.a).toBeGreaterThan(0)
})

test("Settings keeps the captured source, follows server-scoped pages and keeps project identity exact", async ({
  page,
}) => {
  const { alias } = await setup(page, {
    aDefaults: { sidecar: { tlsCaMode: "system" } },
  })
  // The plugin-server inventory stays pending, so Settings keeps the exact project route until the fixture releases
  // the real readiness boundary below.
  await page.goto(fixtureUrl({ hold: "^opencode\\.global\\.dat:plugin\\.servers$" }))
  await expectBadge(page, "CA:BUNDLED")

  await navigate(page, routes.sessionB)
  await expectBadge(page, "CA:SYSTEM")
  await expect(page.getByRole("heading", { name: sessionB.title })).toBeVisible()

  await openSettings(page)
  const settings = page.getByTestId("settings-screen")

  await expectBadge(page, "CA:SYSTEM")
  await settings.getByRole("tab", { name: "Models", exact: true }).click()
  const switcher = settings.locator('[data-action="settings-server-select"]:visible')
  await switcher.click()
  await page.getByRole("menuitemradio", { name: /^Server A/ }).click()
  await expectBadge(page, "CA:BUNDLED")

  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
    .toBe(`/settings?${new URLSearchParams({ server: A, tab: "general" })}`)

  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__tlsCaFixture!.path())).toBe(routes.sessionB)
  await expectBadge(page, "CA:SYSTEM")

  await openSettings(page)
  await navigate(page, routes.settingsProjectA)
  await expect(settings.getByRole("button", { name: "Back to projects", exact: true })).toBeVisible()
  await expectBadge(page, "CA:BUNDLED")
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
    .toContain(`project=${encodeURIComponent(directoryA)}`)

  // While the exact project route is still current, removing its server leaves unknown even though both remaining
  // servers have a verified mode. The readiness gate legitimately defers the redirect until it is released.
  await page.evaluate(() => window.__tlsCaFixture!.remove("a"))
  await expect(settings.getByRole("button", { name: "Back to projects", exact: true })).toHaveCount(0)
  await expectBadge(page, "CA:UNKNOWN")
  expect(await page.evaluate(() => window.__tlsCaFixture!.path())).toContain(`project=${encodeURIComponent(directoryA)}`)

  await page.evaluate(() => window.__tlsCaFixture!.releaseStorage())
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
    .toBe("/settings?tab=projects")
  await expect(settings.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute("aria-selected", "true")
  // The selected root is the local sidecar, whose verified mode is system.
  await expectBadge(page, "CA:SYSTEM")
  expect(alias.counts.a).toBeGreaterThan(0)
})

test("an explicit unresolved Settings source stays unknown through replacements", async ({ page }) => {
  const { alias } = await setup(page, {
    seed: {
      // A real draft B exists, but its tabs store is still hydrating, so it cannot resolve when Settings opens.
      tabs: [{ draft: "missing-draft", directory: directoryB, server: B }],
      storage: { "opencode.global.dat:layout": { home: { selection: { server: A } } } },
      settings: { appearance: { tabLayout: "vertical" }, general: { sidebarOrganize: "projects" } },
    },
  })
  await page.goto(
    fixtureUrl({
      route: `/new-session?draftId=${encodeURIComponent("missing-draft")}`,
      hold: "^opencode\\.window\\.browser\\.dat:tabs$",
    }),
  )

  // The vertical sidebar's Settings action opens the surface while the draft has no tab, so the source is explicitly
  // unresolved. Switch to top tabs only to make the badge visible.
  await openSettingsFromSidebar(page)
  const settings = page.getByTestId("settings-screen")
  const layout = settings.getByRole("group", { name: "Interface layout", exact: true })
  await layout.getByText("Top tabs", { exact: true }).click()
  await expectBadge(page, "CA:UNKNOWN")

  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:UNKNOWN")
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:UNKNOWN")

  // Releasing hydration makes the real draft B resolvable and B healthy, but the captured null cannot become B.
  await page.evaluate(() => window.__tlsCaFixture!.releaseStorage())
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.draftServer("missing-draft")))
    .toBe(B)
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), B))
    .toEqual({ type: "healthy", tlsCaMode: "system" })

  await expectBadge(page, "CA:UNKNOWN")
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:UNKNOWN")
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:UNKNOWN")
  await expect(settings).toBeVisible()
  expect(alias.counts.a).toBe(1)
})

test("missing legacy Settings state uses the existing Home source resolution", async ({ page }) => {
  await setup(page, { aDefaults: { sidecar: {} } })
  await page.goto(fixtureUrl({ route: "/settings" }))

  await expect(page.getByTestId("settings-screen")).toBeVisible()
  await expectBadge(page, "CA:BUNDLED")

  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:BUNDLED")
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:BUNDLED")
})

test("Home override is visible before hydration settles and Settings preserves it", async ({ page }) => {
  await setup(page, {
    aDefaults: { sidecar: {} },
    seed: {
      storage: {
        "opencode.global.dat:layout": { home: { selection: { server: A } } },
      },
    },
  })
  await page.goto(fixtureUrl({ hold: "^opencode\\.global\\.dat:layout$" }))
  await expectBadge(page, "CA:BUNDLED")

  // The real Home controller picks B while its persisted layout is still hydrating and writes nothing yet.
  await focusHomeServer(page, "Server B")
  await expectBadge(page, "CA:SYSTEM")
  expect(await page.evaluate(() => window.__tlsCaFixture!.layoutWrites())).toEqual([])

  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")

  // Home has unmounted, so its transient B override no longer owns persistence.
  // Releasing hydration restores stored A, but Settings must retain captured B.
  await page.evaluate(() => window.__tlsCaFixture!.releaseStorage())
  await expectBadge(page, "CA:SYSTEM")
  // The stored A hydrates into the Layout and Home, but the open Settings surface keeps the B it captured.
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.layoutWrites()))
    .toContainEqual({ server: A, directory: undefined })

  await page.getByTestId("settings-screen").getByRole("button", { name: "Back to app", exact: true }).click()
  await expectBadge(page, "CA:BUNDLED")
})

test("a Home override persists when Home stays mounted through hydration", async ({ page }) => {
  await setup(page, {
    aDefaults: { sidecar: {} },
    seed: {
      storage: {
        "opencode.global.dat:layout": { home: { selection: { server: A } } },
      },
    },
  })
  await page.goto(fixtureUrl({ hold: "^opencode\\.global\\.dat:layout$" }))
  await expectBadge(page, "CA:BUNDLED")

  await focusHomeServer(page, "Server B")
  await expectBadge(page, "CA:SYSTEM")
  expect(await page.evaluate(() => window.__tlsCaFixture!.layoutWrites())).toEqual([])

  await page.evaluate(() => window.__tlsCaFixture!.releaseStorage())
  await expectBadge(page, "CA:SYSTEM")
  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.layoutWrites()))
    .toContainEqual({ server: B, directory: undefined })
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:layout")!).home.selection))
    .toEqual({ server: B })
})

test("project-navigation Home binds its resolved loading target and keeps the badge hidden while vertical", async ({
  page,
}) => {
  const absent = "http://127.0.0.1:4999"
  const { alias } = await setup(page, {
    aDefaults: { sidecar: {} },
    seed: {
      settings: { appearance: { tabLayout: "vertical" }, general: { sidebarOrganize: "projects" } },
      storage: {
        "opencode.global.dat:layout": { home: { selection: { server: absent } } },
      },
    },
  })
  const projects = await holdRoute(
    page,
    (url) => url.origin === A && url.pathname === "/api/project",
    { method: "GET" },
  )

  await page.goto(fixtureUrl())
  await projects.arrived
  const loading = page.getByRole("button", { name: "Loading", exact: true })
  await expect(loading).toBeVisible()
  // The loading action resolves the absent stored server to the first listed connection, and it names that exact
  // connection while the project inventory is still pending.
  await expect(loading.locator("..").getByText("Server A", { exact: true })).toBeVisible()
  await expect(badge(page)).toHaveCount(0)

  // Project navigation must not repair the stored selection merely because it is not listed.
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:layout")!).home.selection),
    )
    .toEqual({ server: absent })

  await openSettingsFromSidebar(page)

  const settings = page.getByTestId("settings-screen")
  const layout = settings.getByRole("group", { name: "Interface layout", exact: true })
  await layout.getByText("Top tabs", { exact: true }).click()
  await expect(layout.getByRole("radio", { name: "Top tabs", exact: true })).toBeChecked()

  // The Home surface unmounted when Settings opened; the captured loading target's key is still the badge's owner.
  await expectBadge(page, "CA:BUNDLED")
  expect(alias.counts.a).toBeGreaterThan(0)
  projects.release()
})

test("health lifecycle keeps accepted answers, follows identity and rejects superseded observations", async ({
  page,
}) => {
  await page.clock.install()
  const { alias, requests, pendingInfo, b } = await setup(page, {
    aDefaults: { a: { tlsCaMode: "system" }, sidecar: {} },
  })

  await page.goto(fixtureUrl({ platform: "web" }))
  await expectBadge(page, "CA:SYSTEM")
  await expect.poll(() => ({ ...requests })).toEqual({ a: 1, b: 1, sidecar: 1 })
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "system" })

  // A tabless Home unauthorized observation makes the identity unknown, with no authentication retry inside the
  // polling window. Restoring the successful answer recovers it.
  alias.set("a", { status: 401 })
  const beforeUnauthorized = alias.counts.a
  await page.clock.fastForward(10_000)
  await expectBadge(page, "CA:UNKNOWN")
  await expect.poll(() => alias.counts.a).toBe(beforeUnauthorized + 1)
  await expect.poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A)).toEqual({ type: "unauthorized" })
  await page.clock.fastForward(1_000)
  expect(alias.counts.a).toBe(beforeUnauthorized + 1)

  alias.set("a", { tlsCaMode: "system" })
  await page.clock.fastForward(10_000)
  await expectBadge(page, "CA:SYSTEM")
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "system" })

  // A Home credential replacement is a checking identity until its own held answer arrives.
  const homeReplacement = alias.hold("a", { tlsCaMode: "system" })
  const beforeHomeReplace = alias.counts.a
  await page.evaluate(() => window.__tlsCaFixture!.replaceAPassword("fixture-a2"))
  await homeReplacement.arrived
  expect(alias.counts.a).toBe(beforeHomeReplace + 1)
  await expectBadge(page, "CA:UNKNOWN")
  homeReplacement.release()
  await expectBadge(page, "CA:SYSTEM")

  // Both identities have accepted the same mode before the destination-only invalidation.
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "system" })
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), B))
    .toEqual({ type: "healthy", tlsCaMode: "system" })

  // A and B share the label, but invalidating B alone changes only B's route.
  await navigate(page, routes.sessionB)
  await expectBadge(page, "CA:SYSTEM")
  b.password = "rotated"
  await page.clock.fastForward(10_000)
  await expectBadge(page, "CA:UNKNOWN")
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "system" })
  b.password = "fixture-b"
  await page.clock.fastForward(10_000)
  await expectBadge(page, "CA:SYSTEM")

  // A stable Home refresh keeps the previous accepted answer, then accepts the answer it receives on release.
  await navigate(page, routes.home)
  await expectBadge(page, "CA:SYSTEM")
  const refresh = alias.hold("a", { tlsCaMode: "bundled" })
  await page.clock.fastForward(10_000)
  await refresh.arrived
  await expectBadge(page, "CA:SYSTEM")
  refresh.release()
  await expectBadge(page, "CA:BUNDLED")
  alias.set("a", { tlsCaMode: "bundled" })

  // The sidecar shares A's endpoint but has its own credential and observation.
  await navigate(page, routes.sidecarSession)
  await expectBadge(page, "CA:UNKNOWN")
  await navigate(page, routes.sessionA)
  await expectBadge(page, "CA:BUNDLED")

  // No credential change precedes this gate, and every support check has settled, so the held request is the health
  // refresh. Remove/relist keeps the session route's exact key and rejects the discarded answer.
  await expect.poll(pendingInfo).toBe(0)
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "bundled" })
  const old = alias.hold("a", { tlsCaMode: "system" })
  const beforeOld = alias.counts.a
  await page.clock.fastForward(10_000)
  const oldRequest = await old.arrived
  expect(alias.counts.a).toBe(beforeOld + 1)
  await expectBadge(page, "CA:BUNDLED")

  await page.evaluate(() => window.__tlsCaFixture!.remove("a"))
  await expectBadge(page, "CA:UNKNOWN")
  await page.evaluate(() => window.__tlsCaFixture!.add("a"))
  await expectBadge(page, "CA:BUNDLED")

  const finished = page.waitForEvent("requestfinished", (request) => request === oldRequest)
  old.release()
  await Promise.all([old.done, finished])
  await expectBadge(page, "CA:BUNDLED")

  // Hold every matching request rather than allowing the terminal
  // capability owner to consume a single queued health response.
  await expect.poll(pendingInfo).toBe(0)

  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
    .toBe(routes.sessionA)

  await expectBadge(page, "CA:BUNDLED")

  alias.set("a", { tlsCaMode: "system" })

  const replacement = await holdRoute(page, `${A}/api/info`, {
    method: "GET",
  })

  try {
    await page.evaluate(() => window.__tlsCaFixture!.replaceAPassword("fixture-a"))

    await replacement.arrived

    await expect
      .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
      .toEqual({ type: "checking" })

    await expectBadge(page, "CA:UNKNOWN")

    await expect
      .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
      .toBe(routes.sessionA)
  } finally {
    replacement.release()
  }

  await expectBadge(page, "CA:SYSTEM")

  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "system" })

  await expect
    .poll(() => page.evaluate(() => window.__tlsCaFixture!.path()))
    .toBe(routes.sessionA)

  expect(requests.a).toBeGreaterThanOrEqual(6)
})

test("full poll windows add exactly one observation per identity across routes", async ({ page }) => {
  await page.clock.install()
  const { requests } = await setup(page, { aDefaults: { sidecar: {} } })

  // Enter one session first so the terminal capability owner's one support check happens before the measured
  // windows. Then every health observation below belongs to the poll or to an accepted route change.
  await page.goto(fixtureUrl({ platform: "web", route: routes.sessionB }))
  await expect(page.getByRole("heading", { name: sessionB.title })).toBeVisible()
  await expectBadge(page, "CA:SYSTEM")

  await navigate(page, routes.home)
  await expectBadge(page, "CA:BUNDLED")
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "bundled" })
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), B))
    .toEqual({ type: "healthy", tlsCaMode: "system" })
  await expect.poll(() => page.evaluate(() => window.__tlsCaFixture!.health("sidecar"))).toEqual({ type: "healthy" })
  // Startup observations and the terminal capability support check are already settled; every later change must be
  // exactly one observation per identity per full poll window.
  const baseline = { ...requests }
  const windows = (count: number) => ({
    a: baseline.a + count,
    b: baseline.b + count,
    sidecar: baseline.sidecar + count,
  })

  // One full polling window on a stable Home probes each listed identity exactly once.
  await page.clock.fastForward(10_000)
  await expect.poll(() => ({ ...requests })).toEqual(windows(1))
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "bundled" })
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), B))
    .toEqual({ type: "healthy", tlsCaMode: "system" })
  await expect.poll(() => page.evaluate(() => window.__tlsCaFixture!.health("sidecar"))).toEqual({ type: "healthy" })

  // A session and Settings cycle adds no observation of its own; the terminal support check is already settled.
  await navigate(page, routes.sessionB)
  await expect(page.getByRole("heading", { name: sessionB.title })).toBeVisible()
  await expectBadge(page, "CA:SYSTEM")
  await openSettings(page)
  await expectBadge(page, "CA:SYSTEM")
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expectBadge(page, "CA:SYSTEM")
  await navigate(page, routes.home)
  await expectBadge(page, "CA:BUNDLED")
  expect({ ...requests }).toEqual(windows(1))

  // The next full window stays one observation per identity across the route and Settings switches.
  await page.clock.fastForward(10_000)
  await expect.poll(() => ({ ...requests })).toEqual(windows(2))
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), A))
    .toEqual({ type: "healthy", tlsCaMode: "bundled" })
  await expect
    .poll(() => page.evaluate((key) => window.__tlsCaFixture!.health(key), B))
    .toEqual({ type: "healthy", tlsCaMode: "system" })
  await expect.poll(() => page.evaluate(() => window.__tlsCaFixture!.health("sidecar"))).toEqual({ type: "healthy" })
  await expectBadge(page, "CA:BUNDLED")
})
