import { expect, test, type Locator, type Page } from "@playwright/test"
import { NO_PROVIDER, SERVER, T0, draftHref, expectPath, holdRoute, pageMessagesFrom, provider, sessionHref, workspaceKey } from "../utils/app"
import { mockWorkspace, openDraft, openSession } from "../utils/workspace"
import { mockPluginsActivating, type MockServerConfig } from "../utils/mock-server"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test("mention a session by title, send its stable token, and open its own tab", async ({ page }) => {
  const target = "ses_0123456789abcdefghijklmnop"
  const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []

  const view = await openSession(page, {
    name: "SessionMentions",
    findFiles: () => [],
    sessions: [
      { id: "ses_mentions_source", title: "Review the plan" },
      { id: target, title: "Auth middleware" },
      { id: "ses_0123456789authtokensabcdef", title: "Auth tokens" },
      { id: "ses_0123456789authreviewabcdef", title: "Auth review" },
      { id: "ses_0123456789authloggingabcde", title: "Auth logging" },
      { id: "ses_0123456789authsessionsabcd", title: "Auth sessions" },
      { id: "ses_0123456789authscopesabcdef", title: "Auth scopes" },
    ],
    seed: { tabs: ["ses_mentions_source"] },
    onPrompt: (input) => void prompts.push(input.body),
  })

  const suggestions = page.locator('[data-component="composer-suggestions"]')

  await view.editor.fill("Compare with @Auth")
  await expect(suggestions.locator('[data-suggestion-id^="session:"]')).toHaveCount(5)
  await view.editor.pressSequentially(" mid")
  await suggestions.getByRole("button", { name: /Auth middleware/ }).click()
  await expect(view.editor.locator('[data-mention="session"]')).toHaveText("@Auth middleware")
  // The mention's context menu copies the ID it stands for; the rest of the editor keeps the native menu.
  await view.editor.locator('[data-mention="session"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy Session ID", exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target)
  await expect(page.getByRole("menu")).toHaveCount(0)
  await view.editor.press("End")
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(`Compare with @session:${target} `)
  const message = page.locator('[data-timeline-row="UserMessage"]')
  const chip = message.getByRole("button", { name: "@Auth middleware", exact: true })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`${target}$`))
  await expect(page.locator("[data-titlebar-tab-link]").filter({ hasText: "Review the plan" })).toHaveCount(1)
  await expect(page.locator('[data-titlebar-tab-slot][data-active="true"]')).toContainText("Auth middleware")
})

test("a bare @ lists sessions, and a multi-word title matches while file search is slow", async ({ page }) => {
  const target = "ses_0123456789opencodeconsolex"
  const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []

  const view = await openSession(page, {
    name: "SessionMentionSearch",
    findFiles: () => [],
    sessions: [
      { id: "ses_mention_search_source", title: "Review the plan" },
      { id: "ses_0123456789homesessionabcde", title: "HOME" },
      { id: target, title: "OPENCODE CONSOLE" },
      { id: "ses_0123456789backhomeabcdefgh", title: "Back home", created: T0 + 2 },
      {
        id: "ses_0123456789otherprojecthome",
        title: "HOME elsewhere",
        projectID: "proj_other",
        directory: "C:/OpenCode/Other",
        created: T0 + 3,
      },
    ],
    seed: { tabs: ["ses_mention_search_source"] },
    onPrompt: (input) => void prompts.push(input.body),
  })

  const suggestions = page.locator('[data-component="composer-suggestions"]')
  const files = await holdRoute(page, (url) => url.pathname === "/api/fs/find")

  // A bare @ offers only this project's sessions.
  await view.editor.pressSequentially("Compare with @")
  await expect(suggestions.getByRole("button", { name: /HOME/ })).toBeVisible()
  await expect(suggestions.getByRole("button", { name: /OPENCODE CONSOLE/ })).toBeVisible()
  await expect(suggestions.getByRole("button", { name: /HOME elsewhere/ })).toHaveCount(0)

  // Typed matches rank this project first, then the exact title, a title start and a later word, ahead of recency.
  await view.editor.pressSequentially("home")
  await expect(suggestions.locator('[data-suggestion-id^="session:"]')).toContainText([
    /HOME(?! elsewhere)/,
    "Back home",
    "HOME elsewhere",
  ])
  await view.editor.press("Backspace")
  await view.editor.press("Backspace")
  await view.editor.press("Backspace")
  await view.editor.press("Backspace")

  await view.editor.pressSequentially("open")
  await files.arrived
  await view.editor.pressSequentially(" con")
  await expect(suggestions.getByRole("button", { name: /HOME/ })).toHaveCount(0)
  await expect(suggestions.locator("[data-suggestion-id][data-active]")).toContainText("OPENCODE CONSOLE")
  await view.editor.press("Enter")
  await expect(view.editor.locator('[data-mention="session"]')).toHaveText("@OPENCODE CONSOLE")
  files.release()

  // Prose after a completed mention neither reopens the popover nor lets it take Enter.
  await view.editor.pressSequentially("on code")
  await expect(suggestions).toBeHidden()
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.text).toBe(`Compare with @session:${target} on code`)

  // A space after a full title ends a typed mention, so the rest stays prose.
  await view.editor.pressSequentially("@home")
  await expect(suggestions.getByRole("button", { name: /^HOME SessionMentionSearch$/ })).toBeVisible()
  await view.editor.pressSequentially(" now")
  await expect(suggestions).toBeHidden()
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(2)
  expect(prompts[1]?.text).toBe("@home now")
})

test("closing the @ menu aborts its session search", async ({ page }) => {
  const view = await openSession(page, {
    name: "SessionMentionAbort",
    findFiles: () => [],
    sessions: [{ id: "ses_mention_abort_source", title: "Review the plan" }],
    seed: { tabs: ["ses_mention_abort_source"] },
  })

  const suggestions = page.locator('[data-component="composer-suggestions"]')
  const search = await holdRoute(page, /\/api\/session\?.*search=auth(&|$)/)

  try {
    await view.editor.pressSequentially("@auth")
    const request = await search.arrived

    const failed = page.waitForEvent("requestfailed", {
      predicate: (candidate) => candidate === request,
      timeout: 10_000,
    })

    await view.editor.press("Escape")
    await expect(suggestions).toBeHidden()
    expect((await failed).failure()?.errorText).toBe("net::ERR_ABORTED")
  } finally {
    search.release()
  }
})

test("the free usage limit opens the Go dialog once, swaps the composer for the free limit panel, and restores the prompt", async ({
  page,
  context,
}) => {
  await page.clock.setFixedTime(T0)
  await context.route("https://**", (route) => route.fulfill({ body: "Sign in" }))
  const sessionID = "ses_free_limit"
  const model = { id: "big-pickle", providerID: "opencode" }
  const state = { authorized: false }

  const view = await openSession(page, {
    name: "FreeLimit",
    sessions: [{ id: sessionID, agent: "build", model }],
    onFileWrite: () => undefined,
    provider: () => ({
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": {
              id: "big-pickle",
              name: "Big Pickle",
              cost: { input: 0, output: 0 },
              limit: { context: 200_000 },
            },
          },
        },
        ...(state.authorized
          ? [
              {
                id: "opencode-go",
                integrationID: "opencode-go",
                name: "OpenCode Go",
                models: {
                  "glm-5-go": {
                    id: "glm-5-go",
                    name: "GLM-5 Go",
                    cost: { input: 1, output: 1 },
                    limit: { context: 200_000 },
                  },
                },
              },
            ]
          : []),
      ],
      connected: state.authorized ? ["opencode", "opencode-go"] : ["opencode"],
      default: { providerID: "opencode", modelID: "big-pickle" },
    }),
    integrations: () => [
      {
        id: "opencode",
        name: "OpenCode Console",
        methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
        connections: state.authorized
          ? [{ type: "credential", id: "cred_console", label: "Anomaly", method: "oauth" }]
          : [],
      },
      {
        id: "opencode-go",
        name: "OpenCode Go",
        methods: [{ type: "key" }],
        connections: state.authorized ? [{ type: "credential", id: "cred_go", label: "Go key", method: "key" }] : [],
      },
    ],
    onConnectKey: (input) => {
      if (input.integrationID === "opencode-go") state.authorized = true
    },
    pageMessages: () => ({
      items: [
        { id: "msg_free_user", type: "user", text: "Refactor the parser", time: { created: T0 } },
        { id: "msg_free_assistant", type: "assistant", agent: "build", model, content: [], time: { created: T0 + 1 } },
      ],
    }),
  })

  await expect(page.getByText("Refactor the parser", { exact: true })).toBeVisible()

  const error = {
    type: "provider.free-limit",
    message: "Free usage limit reached.",
    status: 429,
    retryAfterMs: 3_600_000,
  }

  const durable = (seq: number) => ({ aggregateID: sessionID, seq, version: 1 as const })
  const location = { directory: view.directory }

  await view.push([
    {
      id: "evt_free_limit_1",
      created: T0 + 2,
      type: "session.step.failed",
      location,
      durable: durable(1),
      data: { sessionID, assistantMessageID: "msg_free_assistant", error },
    },
  ])

  const upsell = page.getByRole("dialog", { name: "Free limit reached" })
  await expect(upsell).toContainText("Your free messages reset at")
  await expect(page.getByText(/^You've used today's free messages\. They reset at /)).toBeVisible()
  // With no paid provider the panel stands in for the composer until Go is connected.
  await expect(page.locator('[data-component="session-free-limit"]')).toContainText("Free usage resets at")
  await expect(view.editor).toHaveCount(0)
  await expect(page.getByText("Free usage limit reached.")).toHaveCount(0)

  // Subscribe -> Go API key -> Continue switches the model in the current session without opening a new draft tab.
  await upsell.getByRole("button", { name: "Subscribe", exact: true }).click()
  const connect = page.getByRole("dialog", { name: "Connect OpenCode Go", exact: true })
  await connect.getByPlaceholder("API key").fill("sk-go-test")
  await connect.getByRole("button", { name: "Continue", exact: true }).click()
  const connected = page.getByRole("dialog", { name: "Connected to OpenCode Go" })
  await expect(connected.getByRole("radio", { name: "GLM-5 Go", exact: true })).toHaveAttribute("aria-checked", "true")
  await connected.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expectPath(page, sessionHref(sessionID))
  await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(1)
  await expect(page.locator('[data-action="composer-model"]')).toContainText("GLM-5 Go")
  await expect(view.editor).toHaveText("Refactor the parser")

  // After the 24-hour window, "Don't show again" permanently suppresses the dialog across reloads, and an attachment-only draft survives.
  const day2 = T0 + 2 * 86_400_000
  await page.clock.setFixedTime(day2)

  await view.push([
    {
      id: "evt_free_limit_2",
      created: day2 + 1,
      type: "session.step.started",
      location,
      durable: durable(2),
      data: { sessionID, assistantMessageID: "msg_free_assistant_2", agent: "build", model, started: day2 + 1 },
    },
    {
      id: "evt_free_limit_3",
      created: day2 + 2,
      type: "session.step.failed",
      location,
      durable: durable(3),
      data: { sessionID, assistantMessageID: "msg_free_assistant_2", error },
    },
  ])

  await upsell.getByRole("button", { name: "Don't show again", exact: true }).click()
  await expect(upsell).toHaveCount(0)

  const later = T0 + 4 * 86_400_000
  await page.clock.setFixedTime(later)
  await page.reload()
  await expect(view.editor).toBeVisible()
  await view.editor.fill("")
  await page.locator('input[type="file"]').setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from("png-bytes"),
  })
  await expect(
    page.locator('[data-component="composer-attachments"]').getByRole("img", { name: "diagram.png", exact: true }),
  ).toBeVisible()

  await view.push([
    {
      id: "evt_free_limit_4",
      created: later + 3,
      type: "session.step.started",
      location,
      durable: durable(4),
      data: { sessionID, assistantMessageID: "msg_free_assistant_3", agent: "build", model, started: later + 3 },
    },
    {
      id: "evt_free_limit_5",
      created: later + 4,
      type: "session.step.failed",
      location,
      durable: durable(5),
      data: { sessionID, assistantMessageID: "msg_free_assistant_3", error },
    },
  ])

  await expect(page.getByRole("status").filter({ hasText: "You've used today's free messages." })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.locator('[data-component="composer-attachments"]').getByRole("img", { name: "diagram.png", exact: true }),
  ).toBeVisible()
  await expect(view.editor).toHaveText("")
})

for (const action of ["tray", "picker"] as const) {
  test(`the Go usage limit restores the prompt and dismisses the tray when switching models through the ${action}`, async ({
    page,
    context,
  }) => {
    await page.clock.setFixedTime(T0)
    await context.route("https://opencode.ai/**", (route) => route.fulfill({ body: "Go" }))
    const sessionID = "ses_go_limit"
    const model = { id: "glm-5-go", providerID: "opencode-go" }

    const view = await openSession(page, {
      name: "GoLimit",
      sessions: [{ id: sessionID, agent: "build", model }],
      onFileWrite: () => undefined,
      provider: () => ({
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            models: {
              "big-pickle": {
                id: "big-pickle",
                name: "Big Pickle",
                cost: { input: 0, output: 0 },
                limit: { context: 200_000 },
              },
            },
          },
          {
            id: "opencode-go",
            name: "OpenCode Go",
            models: {
              "glm-5-go": {
                id: "glm-5-go",
                name: "GLM-5 Go",
                cost: { input: 1, output: 1 },
                limit: { context: 200_000 },
              },
            },
          },
        ],
        connected: ["opencode", "opencode-go"],
        default: { providerID: "opencode-go", modelID: "glm-5-go" },
      }),
      pageMessages: () => ({
        items: [
          { id: "msg_go_user", type: "user", text: "Refactor the parser", time: { created: T0 } },
          { id: "msg_go_assistant", type: "assistant", agent: "build", model, content: [], time: { created: T0 + 1 } },
        ],
      }),
    })

    await expect(page.getByText("Refactor the parser", { exact: true })).toBeVisible()

    // The refusal OpenCode Console sends a Go subscriber at a limit, as core records it.
    const body = {
      type: "error",
      error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
      metadata: { workspace: "wrk_go_limit", limitName: "5 hour" },
    }

    await view.push([
      {
        id: "evt_go_limit_1",
        created: T0 + 2,
        type: "session.step.failed",
        location: { directory: view.directory },
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "msg_go_assistant",
          error: {
            type: "provider.go-limit",
            message: "OpenCode Go 5 hour usage limit reached.",
            status: 429,
            response: { body: JSON.stringify(body) },
            retryAfterMs: 3_600_000,
          },
        },
      },
    ])

    const tray = page.locator('[data-component="session-go-limit-tray"]')
    await expect(tray).toContainText(/Go 5 hour usage limit reached\. It resets at .+?\./)
    await expect(
      page.getByRole("status").filter({ hasText: /^You've reached your OpenCode Go usage limit\. It resets at / }),
    ).toBeVisible()
    await expect(view.editor).toHaveText("Refactor the parser")
    await expect(page.getByText("OpenCode Go 5 hour usage limit reached.")).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Extra Usage is turned on from the workspace's Go page in OpenCode Console.
    const popup = page.waitForEvent("popup")
    await tray.getByRole("button", { name: "Turn on Extra Usage", exact: true }).click()
    await expect(await popup).toHaveURL("https://opencode.ai/console/wrk_go_limit/go")

    if (action === "tray") await tray.getByRole("button", { name: "Switch to a free model", exact: true }).click()

    if (action === "picker") {
      await page.locator('[data-action="composer-model"]').click()
      const picker = page.getByRole("dialog", { name: "Select model", exact: true })
      await picker.getByRole("combobox", { name: "Search models", exact: true }).fill("Big Pickle")
      await picker.getByRole("option", { name: /Big Pickle/ }).click()
    }

    await expect(page.locator('[data-action="composer-model"]')).toContainText("Big Pickle")
    await expect(tray).toHaveCount(0)
    await expect(view.editor).toHaveText("Refactor the parser")
  })
}

test("ChatGPT's usage limit opens the ChatGPT usage dialog", async ({ page }) => {
  await page.clock.setFixedTime(T0)
  const sessionID = "ses_chatgpt_limit"
  const model = { id: "gpt-5.5", providerID: "openai" }

  const view = await openSession(page, {
    name: "ChatGPTLimit",
    sessions: [{ id: sessionID, agent: "build", model }],
    onFileWrite: () => undefined,
    pageMessages: () => ({
      items: [
        { id: "msg_chatgpt_user", type: "user", text: "Refactor the parser", time: { created: T0 } },
        {
          id: "msg_chatgpt_assistant",
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created: T0 + 1 },
        },
      ],
    }),
  })

  await expect(page.getByText("Refactor the parser", { exact: true })).toBeVisible()

  await view.push([
    {
      id: "evt_chatgpt_limit_1",
      created: T0 + 2,
      type: "session.step.failed",
      location: { directory: view.directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        assistantMessageID: "msg_chatgpt_assistant",
        error: {
          type: "provider.chatgpt-limit",
          message: "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
          status: 429,
        },
      },
    },
  ])

  await expect(page.getByRole("dialog", { name: "ChatGPT usage limit reached" })).toBeVisible()
})

test("a catalog refresh cannot replace an existing session's model", async ({ page }) => {
  const alpha = { id: "alpha", name: "Alpha", variants: { high: {} } }
  const beta = { id: "beta", name: "Beta" }
  const catalog = { current: provider(alpha, beta) }
  const switches: unknown[] = []
  const prompts: unknown[] = []
  const sessionID = "ses_catalog_selection"
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/model`)
      switches.push(request.postDataJSON())
  })

  const view = await openSession(page, {
    name: "CatalogSelection",
    sessions: [{ id: sessionID, agent: "build", model: { id: "alpha", providerID: "opencode", variant: "high" } }],
    provider: () => catalog.current,
    onPrompt: (input) => void prompts.push(input.body),
    seed: { storage: { "opencode.global.dat:model": { recent: [{ providerID: "opencode", modelID: "beta" }] } } },
  })

  const control = page.locator('[data-action="composer-model"]')
  await expect(control).toHaveText("Alpha")
  await view.editor.fill("Keep my selected model")

  catalog.current = provider(beta)
  await view.push([
    {
      id: "evt_catalog_missing",
      created: T0 + 1,
      type: "model.updated",
      location: { directory: view.directory },
      data: {},
    },
  ])
  await expect(control).toHaveText("alpha (unavailable)")
  await view.editor.press("Enter")
  await expect(page.getByText("Select an agent and model", { exact: true })).toBeVisible()
  await expect(view.editor).toHaveText("Keep my selected model")
  expect(switches).toEqual([])
  expect(prompts).toEqual([])

  catalog.current = provider(alpha, beta)
  await view.push([
    {
      id: "evt_catalog_restored",
      created: T0 + 2,
      type: "model.updated",
      location: { directory: view.directory },
      data: {},
    },
  ])
  await expect(control).toHaveText("Alpha")
  await expect(page.getByRole("button", { name: "Choose model variant", exact: true })).toHaveText("high")
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  // The session already runs Alpha high, so the send has no switch to make.
  expect(switches).toEqual([])

  catalog.current = provider(beta)
  await view.push([
    {
      id: "evt_catalog_removed",
      created: T0 + 3,
      type: "model.updated",
      location: { directory: view.directory },
      data: {},
    },
  ])
  await expect(control).toHaveText("alpha (unavailable)")
  await control.click()
  await page
    .getByRole("dialog", { name: "Select model" })
    .getByRole("button", { name: "Beta Free", exact: true })
    .click()
  await expect(control).toHaveText("Beta")
  await view.editor.fill("Use the replacement I chose")
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(2)
  expect(switches).toEqual([{ model: { id: "beta", providerID: "opencode" } }])
})

test("an existing session's model never shows a fallback while its agent loads", async ({ page }) => {
  const sessionID = "ses_agent_pending"
  await mockWorkspace(page, {
    name: "AgentPending",
    sessions: [{ id: sessionID, agent: "build", model: { id: "alpha", providerID: "opencode" } }],
    provider: provider({ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }),
    seed: { storage: { "opencode.global.dat:model": { recent: [{ providerID: "opencode", modelID: "beta" }] } } },
  })
  const agents = Promise.withResolvers<void>()
  await page.route(/\/api\/agent(\?|$)/, async (route) => {
    await agents.promise
    await route.fallback()
  })

  // Every chip text painted from the first frame, so a fallback shown for even one frame fails the test.
  await page.addInitScript(() => {
    const seen = new Set<string>()
    window.__chipTexts = seen

    const tick = () => {
      const text = document.querySelector('[data-action="composer-model"]')?.textContent

      if (text) seen.add(text)
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })

  const catalog = ["/api/model", "/api/provider", "/api/config"].map((path) =>
    page.waitForResponse((response) => new URL(response.url()).pathname === path),
  )

  const agentRequested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/agent")
  await page.goto(sessionHref(sessionID))
  await Promise.all(catalog)
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()

  const control = page.locator('[data-action="composer-model"]')
  // The recent model must not stand in for the session's model while its agent is unresolved. The chip may stay
  // hidden or name the session's own model, which the loaded selection then keeps.
  await agentRequested
  const agentLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agent")
  agents.resolve()
  await agentLoaded
  await expect(control).toHaveText("Alpha")
  expect(await page.evaluate(() => [...(window.__chipTexts ?? [])])).toEqual(["Alpha"])
})

// FR-004/FR-033/FR-031 through the real app: the row carries no affordance that acts on the pair - `composer-fallback-swap`
// is what this spec replaces, and `composer-fallback-clear` never shipped - and the fallback chip's own picker writes
// config instead of this Session, while offering this composer's own model as an ordinary row.
test("the composer offers no affordance that acts on the pair, and its fallback picker writes config", async ({
  page,
}) => {
  const workspace = await mockWorkspace(page, {
    name: "ComposerFallbackRow",
    directory: "C:/OpenCode/ComposerFallbackRow",
    sessions: [{ id: "ses_fallback_row", agent: "build", model: { id: "alpha", providerID: "opencode" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", variants: { high: {}, low: {} } },
    ),
  })

  // This case is about the affordance the row does NOT carry, so it seeds no fallback of its own: the config-driven
  // chip states, and the pair's config writes, are the next case's subject, where the mock's documents are read back
  // through the app's own config query (`runtime/server/sync.tsx`).
  await page.goto(sessionHref(workspace.sessions[0]!.id))
  const controls = page.locator('[data-slot="composer-controls"]')
  await expect(controls).toBeVisible()

  // FR-004: no affordance that acts on the pair, and no copy naming one, in either direction.
  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((value) => (document.documentElement.dir = value), direction)
    await expect(controls.locator('[data-action="composer-fallback-swap"]')).toHaveCount(0)
    await expect(controls.locator('[data-action="composer-fallback-clear"]')).toHaveCount(0)
    await expect(page.getByText("Swap primary and fallback models")).toHaveCount(0)
    // Both model controls stay reachable, each with its own variant control beside it, and the row's accessible names
    // keep the two variant controls distinguishable (FR-001/FR-002/FR-034).
    await expect(controls.locator('[data-action="composer-model"]')).toHaveCount(1)
    await expect(controls.locator('[data-action="composer-fallback-model"]')).toHaveCount(1)
    await expect(controls.getByRole("button", { name: "Choose model variant", exact: true })).toHaveCount(1)
  }

  const chip = page.locator('[data-action="composer-fallback-model"]')
  await chip.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  // This composer's own primary model is offered as an ordinary row (FR-024/FR-033).
  await expect(dialog.locator('[data-option-key="opencode:alpha"]')).toBeVisible()

  // Choosing another model there writes the config (`PATCH /api/experimental/config`), not this Session: the primary
  // chip is untouched afterwards.
  const written = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/config")
  await dialog.locator('[data-option-key="opencode:beta"]').click()
  await written
  await expect(page.locator('[data-action="composer-model"]')).toHaveText("Alpha")
})

// SC-001/FR-005/FR-029 through the real app: the header alone states which of the three fallback states the app is
// in, with the picker never opened, and the collision state says WHY in its accessible description. The mock's config
// documents are re-read through the app's own `config.updated` handling, so one page shows all three.
test("the fallback chip states a configured model, one that repeats the primary, and a saved no-fallback", async ({
  page,
}) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"

  const workspace = await mockWorkspace(page, {
    name: "FallbackChipStates",
    directory: "C:/OpenCode/FallbackChipStates",
    sessions: [{ id: "ses_chip_states", agent: "build", model: { id: "alpha", providerID: "opencode" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
  })

  // FR-029/FR-030: arriving at, or passing through, the collision state never writes the config field it is naming.
  const patches: unknown[] = []
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/experimental/config") patches.push(response.status())
  })

  await page.goto(sessionHref(workspace.sessions[0]!.id))
  const chip = page.locator('[data-action="composer-fallback-model"]')
  const controls = page.locator('[data-slot="composer-controls"]')
  await expect(controls).toBeVisible()


  // 1. A configured fallback other than the primary model: the chip names the model.
  await expect(chip).toHaveText("Beta")
  await expect(chip).not.toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")

  // FR-001/FR-003 at this boundary: a pair whose models both offer a choice carries exactly four controls, the two
  // variant controls resolve under distinct accessible names, and the row keeps primary model → its variant → fallback
  // model → its variant in each direction's own inline axis. Whether anything overlaps or is clipped stays owned by
  // the component keeper, which measures that geometry (FR-028: one contract, one owner).
  const primary = page.locator('[data-action="composer-model"]')
  const primaryVariant = controls.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = controls.getByRole("button", { name: "Choose fallback model variant", exact: true })

  for (const control of [primary, primaryVariant, chip, fallbackVariant]) await expect(control).toHaveCount(1)

  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((value) => (document.documentElement.dir = value), direction)
    const boxes = await Promise.all([primary, primaryVariant, chip, fallbackVariant].map((control) => control.boundingBox()))
    const [model, variant, pairModel, pairVariant] = boxes

    if (!model || !variant || !pairModel || !pairVariant) throw new Error(`Missing a control in the row at ${direction}`)

    // One row, so all four share a vertical centre, and each control starts at or past the previous one's end in
    // that direction's own inline axis, which is the reading order the header states.
    const centres = [model, variant, pairModel, pairVariant].map((box) => box.y + box.height / 2)
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(2)

    for (const [from, to] of [
      [model, variant],
      [variant, pairModel],
      [pairModel, pairVariant],
    ]) {
      const ahead = direction === "ltr" ? to.x - (from.x + from.width) : from.x - (to.x + to.width)
      expect(ahead, `${direction}: controls out of reading order`).toBeGreaterThanOrEqual(0)
    }
  }

  // 2. The config now names the model this composer shows as its primary: the label is short, and the description
  // carries the reason, so the two-word label is never the only carrier (FR-029).
  workspace.config.entries[0] = { type: "document", path: configPath, info: { fallback: "opencode/alpha" } }
  await workspace.push([{ id: "evt_chip_same_model", created: 1, type: "config.updated", data: {} }])
  await expect(chip).toHaveText("Same model")
  await expect(chip).toHaveAttribute(
    "aria-description",
    "Fallback inactive: it would repeat the primary model",
  )
  // The primary chip keeps naming its own model, and the picker is still closed: the state was read, not acted on.
  await expect(page.locator('[data-action="composer-model"]')).toHaveText("Alpha")
  await expect(page.getByRole("dialog", { name: "Select model" })).toHaveCount(0)

  // 3. A saved no-fallback is a DIFFERENT state from the collision above: it reads "None" and keeps no inactive
  // description, which is what keeps `off` and `inactive` from being interchangeable (SC-014).
  workspace.config.entries[0] = { type: "document", path: configPath, info: { fallback: null } }
  await workspace.push([{ id: "evt_chip_none", created: 1, type: "config.updated", data: {} }])
  await expect(chip).toHaveText("None")
  await expect(chip).not.toHaveAttribute(
    "aria-description",
    "Fallback inactive: it would repeat the primary model",
  )

  // Nothing in that sequence wrote the config it was only displaying (FR-029 read with FR-030).
  expect(patches).toEqual([])
})

// FR-029/FR-030 with FR-028 and FR-021: a fallback that differs from the primary only by variant is the SAME MODEL, so
// the composer reads it inactive - and it keeps displaying that slot's recorded variant without ever writing it back.
// Only the other slot changing makes it active again, and that needs no click in this picker (T021).
test("a variant-only fallback repeats its primary model, keeps its variant control, and writes nothing", async ({
  page,
}) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  const patches: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") patches.push(request.method())
  })

  const workspace = await mockWorkspace(page, {
    name: "InactiveFallbackVariant",
    directory: "C:/OpenCode/InactiveFallbackVariant",
    sessions: [{ id: "ses_inactive_variant", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    // A paid catalog, so the primary chip opens the ordinary model dialog with its rows (T021 moves the primary).
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // The config's own value differs from the primary by its variant alone: the identity rule decides, not the string.
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/alpha#high" } }],
    // Both models visible in the paid list, so this picker's ordinary rows are what the case clicks.
    seed: {
      storage: {
        "opencode.global.dat:model": {
          user: [
            { providerID: "opencode", modelID: "alpha", visibility: "show" },
            { providerID: "opencode", modelID: "beta", visibility: "show" },
          ],
          recent: [],
          variant: {},
        },
      },
    },
  })

  await page.goto(sessionHref(workspace.sessions[0]!.id))
  const controls = page.locator('[data-slot="composer-controls"]')
  const primary = controls.locator('[data-action="composer-model"]')
  const chip = controls.locator('[data-action="composer-fallback-model"]')
  const primaryVariant = controls.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = controls.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(controls).toBeVisible()

  // The collision names itself with the reason in its description, and the fallback slot still offers its own variant
  // choice - the inactive state is a display verdict, never a clear of the saved field (FR-028 read with FR-030).
  await expect(chip).toHaveText("Same model")
  await expect(chip).toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(primaryVariant).toHaveText("low")
  await expect(fallbackVariant).toHaveText("high")

  // Changing the primary's variant touches the other slot only: still the same model, so still inactive, still the
  // recorded `high`, and no request at all (FR-029).
  await primaryVariant.click()
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
  await expect(primaryVariant).toHaveText("high")
  await expect(chip).toHaveText("Same model")
  await expect(fallbackVariant).toHaveText("high")
  expect(patches).toEqual([])

  // Moving the primary to another model makes that stored fallback usable again, with its recorded variant, without
  // the user touching this picker. The row click names a model that is NOT the other slot's model, so no exchange runs
  // either: the field keeps what it already holds (FR-030 read with FR-001).
  await primary.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-option-key="opencode:beta"]').click()
  await expect(primary).toHaveText("Beta")
  await expect(chip).toHaveText("Alpha")
  await expect(chip).not.toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(fallbackVariant).toHaveText("high")
  expect(patches).toEqual([])
})

// FR-012/FR-028: the fallback slot's variant control exists only where that slot has a model with a variant to choose.
// A saved no-fallback has no model at all, and a model the catalog lists without variants has no choice to offer, and
// neither state reaches into the other slot's control or writes the config field it is merely describing (T021).
test("an off fallback and a variant-less one each leave the other slot's variant control alone", async ({
  page,
}) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  const patches: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") patches.push(request.method())
  })

  const workspace = await mockWorkspace(page, {
    name: "FallbackVariantControls",
    directory: "C:/OpenCode/FallbackVariantControls",
    sessions: [{ id: "ses_fallback_variant_controls", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", variants: { high: {}, low: {} } },
      // A model with no variants of its own: `Default` is its only option, so no control renders.
      { id: "gamma", name: "Gamma" },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: null } }],
  })

  await page.goto(sessionHref(workspace.sessions[0]!.id))
  const controls = page.locator('[data-slot="composer-controls"]')
  const chip = controls.locator('[data-action="composer-fallback-model"]')
  const primaryVariant = controls.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = controls.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(controls).toBeVisible()

  // 1. Off: no fallback model, so the fallback slot has no variant control while the primary keeps its own.
  await expect(chip).toHaveText("None")
  await expect(fallbackVariant).toHaveCount(0)
  await expect(primaryVariant).toHaveText("low")

  // A variant change in the other slot leaves the off state exactly as it was: still `None`, still no control, and the
  // field it is describing is untouched (FR-013 read with FR-028).
  await primaryVariant.click()
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
  await expect(primaryVariant).toHaveText("high")
  await expect(chip).toHaveText("None")
  await expect(chip).not.toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(fallbackVariant).toHaveCount(0)
  expect(patches).toEqual([])

  // 2. A fallback the catalog lists with no variants: named by the chip, and still no variant control for that slot,
  // because the gate reads the option list rather than the state (FR-028).
  workspace.config.entries[0] = { type: "document", path: configPath, info: { fallback: "opencode/gamma" } }
  await workspace.push([{ id: "evt_variant_less_fallback", created: 1, type: "config.updated", data: {} }])
  await expect(chip).toHaveText("Gamma")
  await expect(fallbackVariant).toHaveCount(0)
  await expect(primaryVariant).toHaveText("high")
  expect(patches).toEqual([])
})

// FR-029/FR-030 with the shipped default (`packages/app/src/providers/models/selection.tsx:773`): a config that never
// names a fallback still HAS an effective one, and where that model is this composer's primary the app says so - while
// leaving the field ABSENT, which is a different saved state from a written `null` (FR-013, T021).
test("an unconfigured default that repeats the primary model reads inactive and is never written", async ({
  page,
}) => {
  const patches: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") patches.push(request.method())
  })

  const workspace = await mockWorkspace(page, {
    name: "DefaultFallbackCollision",
    directory: "C:/OpenCode/DefaultFallbackCollision",
    // The session's model is the very model the shipped default names, and no config document names a fallback at all.
    sessions: [{ id: "ses_default_fallback", agent: "build", model: { id: "qwen3.8-27b", providerID: "mlx", variant: "low" } }],
    provider: {
      all: [
        {
          id: "mlx",
          name: "MLX",
          models: {
            "qwen3.8-27b": {
              id: "qwen3.8-27b",
              name: "Qwen3.8",
              limit: { context: 200_000 },
              variants: { xhigh: {}, low: {} },
            },
          },
        },
      ],
      connected: ["mlx"],
      default: { providerID: "mlx", modelID: "qwen3.8-27b" },
    },
  })

  await page.goto(sessionHref(workspace.sessions[0]!.id))
  const controls = page.locator('[data-slot="composer-controls"]')
  const chip = controls.locator('[data-action="composer-fallback-model"]')
  const fallbackVariant = controls.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(controls).toBeVisible()

  await expect(chip).toHaveText("Same model")
  await expect(chip).toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  // The default's recorded variant is what that control shows: the effective value, shown rather than persisted (FR-028).
  await expect(fallbackVariant).toHaveText("xhigh")
  // Displaying the default never adopts it: the config field stays absent, so a later `None` is still the only way to
  // write an off state (FR-030 read with FR-013).
  expect(patches).toEqual([])
})

// FR-014/T026 through the real app: an exchange is ONE composer's action. The Session it was clicked in takes the new
// pair, another Session's composer keeps showing its OWN primary model, every composer in the workspace names the one
// recorded fallback, and neither that other Session's record entry nor a draft's own selection moves.
test("an exchange stays with its own Session: another Session's composer and a draft keep their own primary model", async ({
  page,
}) => {
  const directory = "C:/OpenCode/ComposerPairScope"
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  const patches: unknown[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config" && request.method() === "PATCH")
      patches.push(request.postDataJSON())
  })

  await mockWorkspace(page, {
    name: "ComposerPairScope",
    directory,
    sessions: [
      { id: "ses_pair_left", title: "Left", agent: "build", model: { id: "alpha", providerID: "opencode" } },
      { id: "ses_pair_right", title: "Right", agent: "build", model: { id: "gamma", providerID: "opencode" } },
    ],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "gamma", name: "Gamma", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // One fallback for the whole server, so every composer here names the same model in its fallback slot.
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
    seed: {
      // A paid catalog, so both pickers offer these models as ordinary rows (the pattern the primary-picker keepers
      // use), and all three are visible in the list.
      storage: {
        "opencode.global.dat:model": {
          user: [
            { providerID: "opencode", modelID: "alpha", visibility: "show" },
            { providerID: "opencode", modelID: "beta", visibility: "show" },
            { providerID: "opencode", modelID: "gamma", visibility: "show" },
          ],
          recent: [],
          variant: {},
        },
      },
      settings: { appearance: { tabLayout: "vertical" } },
      tabs: [
        { session: "ses_pair_left" },
        { session: "ses_pair_right" },
        { draft: "draft_pair_scope", directory },
      ],
    },
  })

  const primary = page.locator('[data-action="composer-model"]')
  const chip = page.locator('[data-action="composer-fallback-model"]')
  const dialog = page.getByRole("dialog", { name: "Select model" })
  // This workspace's per-Session record document, as the app writes it (`runtime/persistence/storage.ts`). Reading it
  // is what shows another Session's own selection never moved, rather than only its display.
  const selectionKey = workspaceKey(directory, "model-selection")

  const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), selectionKey)

  await page.goto(sessionHref("ses_pair_left"))
  await expect(primary).toHaveText("Alpha")
  await expect(chip).toHaveText("Beta")

  // 1. The exchange, driven through the real primary picker: the row naming the other slot's model promotes it.
  const written = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/config")
  await primary.click()
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-option-key="opencode:beta"]').click()
  await written
  await expect(primary).toHaveText("Beta")
  await expect(chip).toHaveText("Alpha")

  // Both owners now hold the exchanged pair: this Session's record entry names the promoted model, and the config
  // field the server answers holds the model the exchange displaced.
  await expect.poll(stored).toMatchObject({ session: { ses_pair_left: { choice: { modelID: "beta" } } } })
  expect(patches).toEqual([{ fallback: { providerID: "opencode", model: "alpha" } }])
  const afterExchange = await stored()

  // 2. The other Session's composer, switched to through its tab: its OWN primary model, which the action above
  // never touched, and the same recorded fallback every composer in this workspace shows.
  await page.locator(`[data-slot="vertical-tabs"] a[href="${sessionHref("ses_pair_right", SERVER)}"]`).click()
  await expect(primary).toHaveText("Gamma")
  await expect(chip).toHaveText("Alpha")
  // That Session owns no entry in the record document at all: its model comes from its own session record, and the
  // exchange wrote nothing under its key.
  expect((await stored())?.session?.ses_pair_right).toBeUndefined()

  // 3. A draft in the same workspace. It carries its own prompt selection and shows the same recorded fallback every
  // other composer in this workspace shows.
  await page.goto(draftHref("draft_pair_scope"))
  await expect(primary).toHaveText("Beta")
  await expect(chip).toHaveText("Alpha")
  await primary.click()
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-option-key="opencode:gamma"]').click()
  await expect(primary).toHaveText("Gamma")
  // A model that is not the other slot's model is an ordinary selection: no exchange, and no config write.
  await expect(dialog).toBeHidden()
  expect(patches.length).toBe(1)

  // The row naming the model in the other slot promotes it: an exchange owned by this draft.
  await primary.click()
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-option-key="opencode:alpha"]').click()
  await expect(primary).toHaveText("Alpha")
  await expect(chip).toHaveText("Gamma")
  await expect.poll(() => patches.length).toBe(2)
  expect(patches[1]).toEqual({ fallback: { providerID: "opencode", model: "gamma" } })
  // The draft's exchange wrote its own selection and the shared config field, and zero values in either Session's
  // record: that document is byte-identical to what it held before this draft was opened.
  expect(await stored()).toEqual(afterExchange)

  // And the Session this draft does not belong to still owns its own primary model: switching back to its tab shows
  // the pair the draft never touched, with only the shared fallback field moved (FR-014).
  await page.locator(`[data-slot="vertical-tabs"] a[href="${sessionHref("ses_pair_left", SERVER)}"]`).click()
  await expect(primary).toHaveText("Beta")
  await expect(chip).toHaveText("Gamma")
})

// FR-025/FR-035 at the app's boundary: the fallback a composer NAMES, the variant control beside it, and the value
// `GET /api/config` answers are ONE value in every state — the recorded value request recovery acts on. What this
// case cannot claim is core's inference: the mocked server runs no recovery, so the comparison is between the
// display and the source both the composer and Settings > Models read (SC-013).
test("the fallback chip names the value the config endpoint answers, in a configured, a repeated, and a saved none", async ({
  page,
}) => {
  const directory = "C:/OpenCode/FallbackValueAgreement"
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  const patches: unknown[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config" && request.method() === "PATCH")
      patches.push(request.postDataJSON())
  })

  const workspace = await mockWorkspace(page, {
    name: "FallbackValueAgreement",
    directory,
    sessions: [{ id: "ses_value_agreement", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
  })

  // The same endpoint the app's own sync reads (`GET /api/config`), read back from the browser. The mock answers its
  // documents in precedence order, so the last document is the effective value.
  const effective = () =>
    page.evaluate(async () => {
      // SAFETY: the mock's documents are the fixtures this case wrote, and `info.fallback` is the field under test.
      const entries = (await fetch("/api/config").then((response) => response.json())) as {
        info?: { fallback?: unknown }
      }[]

      return entries.at(-1)?.info?.fallback
    })

  await page.goto(sessionHref("ses_value_agreement"))
  const controls = page.locator('[data-slot="composer-controls"]')
  const chip = controls.locator('[data-action="composer-fallback-model"]')
  const fallbackVariant = controls.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(controls).toBeVisible()

  // 1. A configured fallback other than the primary model: the chip names that recorded value's model, the control
  // beside it names its variant, and the endpoint answers the value they came from.
  await expect(chip).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("high")
  expect(await effective()).toBe("opencode/beta#high")

  // 2. The config now names this composer's own primary model, with a variant of its own: the composer says WHY in
  // its description, keeps showing that recorded variant, and the field is left exactly as it was (FR-029/FR-030).
  workspace.config.entries.push({ type: "document", path: configPath, info: { fallback: "opencode/alpha#high" } })
  await workspace.push([{ id: "evt_value_repeated", created: 1, type: "config.updated", data: {} }])
  await expect(chip).toHaveText("Same model")
  await expect(chip).toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(fallbackVariant).toHaveText("high")
  expect(await effective()).toBe("opencode/alpha#high")
  expect(patches).toEqual([])

  // 3. The picker that would write that value marks the provider-qualified row the same value names as the current
  // choice, so a user cannot be shown one model and have another written (FR-036/FR-037 read with FR-025). Choosing
  // its "None" row then writes the explicit no-fallback value, which reads back as `null`, and the composer shows an
  // off state with no inactive description: never the collision state above (SC-013/FR-012).
  await chip.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-option-key="opencode:alpha"]')).toHaveAttribute("aria-current", "true")

  const wrote = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/experimental/config")
  await dialog.locator('[data-option-key="none"]').click()
  await wrote
  await expect(chip).toHaveText("None")
  await expect(chip).not.toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(fallbackVariant).toHaveCount(0)
  expect(patches).toEqual([{ fallback: null }])
  await expect.poll(effective).toBe(null)
})

test("a send pressed while the Location's plugins activate waits, Esc cancels it, and it sends once catalogs load", async ({
  page,
}) => {
  const sessionID = "ses_plugins_booting"
  const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []
  await mockWorkspace(page, {
    name: "PluginsBooting",
    sessions: [{ id: sessionID, agent: "build", model: { id: "alpha", providerID: "opencode" } }],
    provider: provider({ id: "alpha", name: "Alpha" }),
    onPrompt: (input) => void prompts.push(input.body),
  })
  // The server answers the catalogs once plugins activate, and the model list gives up first with a 503.
  await mockPluginsActivating(page)
  const held = await holdRoute(page, /\/api\/(agent|provider|model)(\?|$)/)
  const toast = page.getByText("Select an agent and model")
  const submit = page.locator('[data-action="composer-submit"]')

  try {
    await page.goto(sessionHref(sessionID))
    const editor = page.locator('[data-component="composer-editor"]')
    await expect(editor).toBeEditable()
    await held.arrived
    await editor.fill("ship it")
    await editor.press("Enter")
    await expect(submit).toHaveAttribute("aria-busy", "true")
    // Esc cancels the held send and keeps the prompt for the next press.
    await editor.press("Escape")
    await expect(submit).not.toHaveAttribute("aria-busy", "true")
    await expect(editor).toHaveText("ship it")
    await editor.press("Enter")
    await expect(submit).toHaveAttribute("aria-busy", "true")
    await expect(toast).toHaveCount(0)
    expect(prompts).toEqual([])

    held.release()
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0]).toMatchObject({ text: "ship it" })
    await expect(editor).toHaveText("")
    await expect(submit).not.toHaveAttribute("aria-busy", "true")
    await expect(toast).toHaveCount(0)
  } finally {
    held.release()
  }
})

test("an opened session in another Location names its model from a loaded catalog before its agents load", async ({
  page,
}) => {
  const other = "C:/OpenCode/WarmOther"
  await mockWorkspace(page, {
    name: "WarmOpen",
    sessions: [
      { id: "ses_warm_here", title: "Here", agent: "build", model: { id: "alpha", providerID: "opencode" } },
      {
        id: "ses_warm_there",
        title: "There",
        directory: other,
        location: { directory: other },
        agent: "build",
        model: { id: "beta", providerID: "opencode", variant: "high" },
      },
    ],
    provider: provider({ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta (latest)", variants: { high: {} } }),
    seed: { settings: { appearance: { tabLayout: "vertical" } } },
  })

  const control = page.locator('[data-action="composer-model"]')
  await page.goto(sessionHref("ses_warm_here"))
  await expect(control).toHaveText("Alpha")

  const held = await holdRoute(
    page,
    (url) =>
      ["/api/agent", "/api/config"].includes(url.pathname) && url.searchParams.get("location[directory]") === other,
  )

  try {
    await page.locator(`[data-slot="vertical-tabs"] a[href="${sessionHref("ses_warm_there", SERVER)}"]`).click()
    await held.arrived
    await expect(control).toHaveText("Beta")
    await expect(page.getByRole("button", { name: "Choose model variant" })).toHaveText("high")
    const painted = await control.elementHandle()

    const loaded = ["/api/agent", "/api/config"].map((path) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url())

        return url.pathname === path && url.searchParams.get("location[directory]") === other
      }),
    )

    // A click before the catalog loads waits for it, and Escape gives up the wait, so the dialog cannot pop up later.
    await control.click()
    await expect(control).toHaveAttribute("aria-busy", "true")
    await page.keyboard.press("Escape")
    await expect(control).not.toHaveAttribute("aria-busy")

    // A click before the catalog loads opens the dialog once it does.
    await control.click()
    await expect(control).toHaveAttribute("aria-busy", "true")
    held.release()
    await Promise.all(loaded)
    await expect(page.getByRole("dialog")).toBeVisible()
    // The loaded selection keeps the same chip instead of replacing it.
    await expect(control).toHaveText("Beta")
    expect(await painted?.evaluate((element) => element.isConnected)).toBe(true)
  } finally {
    held.release()
  }
})

declare global {
  interface Window {
    __chipTexts?: Set<string>
  }
}

test("a managed composer label follows direct connections, not picker filtering or model identity", async ({
  page,
}) => {
  const sessionID = "ses_managed_provider"
  const connected = { direct: false }
  const switches: unknown[] = []
  const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/model`)
      switches.push(request.postDataJSON())
  })

  const view = await openSession(page, {
    name: "ManagedProvider",
    sessions: [{ id: sessionID, agent: "build", model: { id: "gpt", providerID: "console-openai" } }],
    provider: () => ({
      all: [
        {
          id: "opencode",
          integrationID: "opencode",
          name: "Anomaly / OpenCode",
          models: {},
        },
        {
          id: "console-openai",
          canonical: "openai",
          integrationID: "opencode",
          name: "Anomaly / OpenAI",
          models: { gpt: { id: "gpt", name: "GPT" } },
        },
        ...(connected.direct
          ? [
              {
                id: "openai",
                name: "OpenAI",
                models: { "direct-model": { id: "direct-model", name: "Direct Model" } },
              },
            ]
          : []),
      ],
      connected: ["opencode", "console-openai", ...(connected.direct ? ["openai"] : [])],
      default: {},
    }),
    onPrompt: (input) => void prompts.push(input.body),
    seed: {
      storage: {
        "opencode.global.dat:model": {
          user: [
            { providerID: "console-openai", modelID: "gpt", visibility: "show" },
            { providerID: "openai", modelID: "direct-model", visibility: "show" },
          ],
        },
      },
    },
  })

  const control = page.locator('[data-action="composer-model"]')
  const picker = page.getByRole("dialog", { name: "Select model", exact: true })
  const selected = picker.locator('[data-option-key="console-openai:gpt"]')
  await expect(control).toHaveText("OpenAI / GPT")

  connected.direct = true
  await view.push([
    {
      id: "evt_direct_connected",
      created: T0 + 1,
      type: "provider.updated",
      location: { directory: view.directory },
      data: {},
    },
    {
      id: "evt_direct_models_connected",
      created: T0 + 2,
      type: "model.updated",
      location: { directory: view.directory },
      data: {},
    },
  ])
  await expect(control).toHaveText("OpenCode / OpenAI / GPT")
  await expect(control).toHaveAccessibleName("OpenCode / OpenAI / GPT")
  await control.click()
  const search = picker.getByRole("combobox", { name: "Search models", exact: true })
  await expect(picker.locator('[data-option-key="openai:direct-model"]')).toBeVisible()
  await search.fill("GPT")
  await expect(picker.locator('[data-option-key="openai:direct-model"]')).toHaveCount(0)
  await expect(selected).toHaveAttribute("aria-current", "true")
  await expect(control).toHaveText("OpenCode / OpenAI / GPT")
  await search.press("Escape")
  await expect(picker).toBeHidden()

  connected.direct = false
  await view.push([
    {
      id: "evt_direct_disconnected",
      created: T0 + 3,
      type: "provider.updated",
      location: { directory: view.directory },
      data: {},
    },
    {
      id: "evt_direct_models_disconnected",
      created: T0 + 4,
      type: "model.updated",
      location: { directory: view.directory },
      data: {},
    },
  ])
  await expect(control).toHaveText("OpenAI / GPT")

  await view.editor.fill("Keep the managed provider selected")
  await view.editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({ text: "Keep the managed provider selected" })
  expect(switches).toEqual([])
})

async function draft(page: Page) {
  const { editor } = await openDraft(page, { name: "ComposerDraft", provider: NO_PROVIDER })
  await editor.click()

  return editor
}

async function expectCaretVisible(input: Locator) {
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const selection = window.getSelection()

        if (!selection?.isCollapsed || !selection.rangeCount || !element.contains(selection.anchorNode)) return false
        const caret = selection.getRangeAt(0).getBoundingClientRect()
        const viewport = (element.closest("[data-scrollable]") ?? element).getBoundingClientRect()

        return caret.height > 0 && caret.top >= viewport.top - 1 && caret.bottom <= viewport.bottom + 1
      }),
    )
    .toBe(true)
}

test("keeps a 25000-line crash report editable in a new session", async ({ page }) => {
  const input = await draft(page)
  const text = "Thread 0 Crashed:\n" + "0   Example  0x0000000100000000 frame + 32\n".repeat(25000) + "End of report"
  await page.evaluate((text) => navigator.clipboard.writeText(text), text)

  const events = await input.evaluateHandle((element) => {
    const events = { count: 0 }
    element.addEventListener("input", () => events.count++)

    return events
  })

  await page.keyboard.press("ControlOrMeta+V")
  await expect.poll(async () => (await input.innerText()) === text).toBe(true)
  expect(await events.evaluate((events) => events.count)).toBe(1)
  await expect(input).toBeFocused()
  await expectCaretVisible(input)
  await page.keyboard.type("!")
  await expect.poll(async () => (await input.innerText()) === text + "!").toBe(true)
  await expectCaretVisible(input)
  await page.keyboard.press("ControlOrMeta+Home")
  await page.keyboard.press("ControlOrMeta+End")
  await expectCaretVisible(input)
})

test("keeps a line added at the end of a scrolling prompt clear of the bottom fade", async ({ page }) => {
  const { editor } = await openSession(page, { name: "ComposerFade" })
  await editor.click()

  for (const line of Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`)) {
    await page.keyboard.type(line)
    await page.keyboard.press("Shift+Enter")
  }

  await page.keyboard.type("Last line")
  await expect.poll(() => editor.innerText()).toMatch(/Line 12\nLast line$/)

  // The mask fades the viewport's bottom --composer-fade-bottom pixels; the last line must end above them.
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const viewport = element.closest('[data-component="composer-scroll"]')!
        const range = document.createRange()
        range.selectNodeContents(element)

        const line = Array.from(range.getClientRects()).reduce((last, rect) =>
          rect.bottom > last.bottom ? rect : last,
        )

        const fade = parseFloat(getComputedStyle(viewport).getPropertyValue("--composer-fade-bottom"))

        return Math.max(0, Math.round(line.bottom - (viewport.getBoundingClientRect().bottom - fade)))
      }),
    )
    .toBe(0)
})

test("Enter that confirms an IME candidate never sends, even after Safari's early compositionend", async ({ page }) => {
  const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []
  const view = await openSession(page, { name: "ComposerImeEnter", onPrompt: (input) => void prompts.push(input.body) })

  const enter = (keyCode: number) =>
    view.editor.evaluate(
      (element, keyCode) =>
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode, bubbles: true, cancelable: true })),
      keyCode,
    )

  await view.editor.fill("にほん")
  // Safari delivers the confirming Enter after compositionend, so isComposing is false and only keyCode marks it.
  await enter(229)
  await expect(view.editor).toHaveText("にほん")
  await enter(13)
  await expect.poll(() => prompts.map((body) => body.text)).toEqual(["にほん"])
})

test.describe("touch keyboard", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("Return only adds a line, even over suggestions; the touch bar and Cmd+Return send", async ({ page }) => {
    const prompts: Parameters<NonNullable<MockServerConfig["onPrompt"]>>[0]["body"][] = []

    const view = await openSession(page, {
      name: "ComposerTouchReturn",
      onPrompt: (input) => void prompts.push(input.body),
    })

    const bar = page.locator('[data-slot="composer-touch-bar"]')

    await expect(bar).toBeVisible()
    await expect(page.locator('[data-action="composer-attach"]')).toHaveCount(0)
    await expect(view.editor).toHaveAttribute("enterkeyhint", "enter")

    await view.editor.fill("/model")
    await expect(page.locator('[data-suggestion-id="model.choose"]')).toHaveAttribute("data-active", "")
    await view.editor.press("Enter")
    await expect(page.locator('[data-component="composer-suggestions"]')).toBeHidden()
    await expect.poll(() => view.editor.innerText()).toMatch(/^\/model\n/)
    await expect(page.getByRole("dialog", { name: "Select model", exact: true })).toBeHidden()

    await view.editor.fill("first line")
    await view.editor.press("Enter")
    await view.editor.pressSequentially("second line")
    await expect.poll(() => view.editor.innerText()).toBe("first line\nsecond line")
    expect(prompts).toEqual([])

    await bar.getByRole("button", { name: "Send", exact: true }).tap()
    await expect.poll(() => prompts.map((body) => body.text)).toEqual(["first line\nsecond line"])
    await expect(view.editor).toBeEmpty()

    // A hardware keyboard, as on an iPad, still sends with Cmd+Return.
    await view.editor.fill("from the iPad keyboard")
    await view.editor.press("ControlOrMeta+Enter")
    await expect
      .poll(() => prompts.map((body) => body.text))
      .toEqual(["first line\nsecond line", "from the iPad keyboard"])
  })

  test("the / and @ keys toggle their lists, and Backspace or typing in the editor closes them", async ({ page }) => {
    const view = await openSession(page, { name: "ComposerTouchSlash" })
    const suggestions = page.locator('[data-component="composer-suggestions"]')
    const slash = page.locator('[data-slot="composer-touch-bar"] [data-action="composer-commands"]')

    await slash.tap()
    await expect(suggestions).toBeVisible()
    await expect(view.editor).toHaveText("/")
    await slash.tap()
    await expect(suggestions).toBeHidden()
    await expect(view.editor).toBeEmpty()

    await slash.tap()
    await expect(suggestions).toBeVisible()
    await page.keyboard.press("Backspace")
    await expect(suggestions).toBeHidden()

    // With a draft, / opens the searchable menu instead. Backspace backs out of it and keeps the draft, from the editor
    // as well: iOS keeps the keyboard there rather than moving it to the menu's search.
    await view.editor.fill("keep me")
    await slash.tap()
    await expect(suggestions).toBeVisible()
    await view.editor.press("Backspace")
    await expect(suggestions).toBeHidden()
    await expect(view.editor).toHaveText("keep me")

    await slash.tap()
    await expect(suggestions).toBeVisible()
    // Focusing the editor programmatically leaves the caret wherever the browser puts it, so move it to the end first.
    await expect(suggestions.getByRole("textbox", { name: "Commands", exact: true })).toBeFocused()
    await view.editor.focus()
    await page.keyboard.press("End")
    await page.keyboard.type(" now")
    await expect(suggestions).toBeHidden()
    await expect(view.editor).toHaveText("keep me now")

    // @ toggles the same way, taking back only the @ it typed.
    const at = page.locator('[data-slot="composer-touch-bar"] [data-action="composer-context"]')
    await view.editor.pressSequentially(" ")
    await at.tap()
    await expect(suggestions).toBeVisible()
    await expect(view.editor).toHaveText("keep me now @")
    await at.tap()
    await expect(suggestions).toBeHidden()
    await expect(view.editor).toHaveText("keep me now ")
  })
})

test("a key-up never moves the caret back after later navigation", async ({ page }) => {
  const input = await draft(page)
  await input.pressSequentially("first line")
  await expect(input).toHaveText("first line")

  // Navigation can land before the next frame; the cursor a key-up recorded must not overwrite it there.
  const offset = await input.evaluate(async (element) => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!
    const selection = window.getSelection()!
    selection.collapse(text, 0)
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }))
    selection.collapse(text, text.textContent!.length)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    return selection.anchorOffset
  })

  expect(offset).toBe("first line".length)
})

for (const [width, direction] of [
  [390, "rtl"],
  [1280, "ltr"],
] as const) {
  test(`reveals a multiline paste in the middle at ${width}px in ${direction}`, async ({ page }) => {
    const input = await draft(page)
    await page.setViewportSize({ width, height: 800 })
    await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
    const suffix = "\nExisting trailing content".repeat(100)
    await input.fill("Before " + suffix)
    await input.press("ControlOrMeta+Home")
    await input.press("ArrowRight")
    const text = "Pasted line /tmp/example.ts 123 \u0645\u0631\u062d\u0628\u0627\n".repeat(100) + "End of paste"
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    await page.keyboard.press("ControlOrMeta+V")
    await expect.poll(() => input.innerText()).toBe("B" + text + "efore " + suffix)
    await expectCaretVisible(input)
    await page.keyboard.type("!")
    await expect.poll(() => input.innerText()).toBe("B" + text + "!efore " + suffix)
    await expectCaretVisible(input)
  })
}

test("pastes plain text without markup and keeps native undo", async ({ page }) => {
  const input = await draft(page)

  for (const text of [
    "single line <b> &amp;",
    "first\nsecond",
    "\n\n  indented\ttext  \n\nlast\n\n",
    'literal <b>bold</b> &amp; & < > "quotes"\n<script>not code</script>\n<img src="example">',
    "first\r\nsecond\rthird",
  ]) {
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    await page.keyboard.press("ControlOrMeta+V")
    const expected = text.replace(/\r\n?/g, "\n")
    await expect.poll(() => input.innerText()).toBe(expected)
    await expect(input.locator("b, script, img")).toHaveCount(0)
    await page.keyboard.press("ControlOrMeta+Z")
    await expect(input).toBeEmpty()
    await page.keyboard.press("ControlOrMeta+Shift+Z")
    await expect.poll(() => input.innerText()).toBe(expected)
    await page.keyboard.press("ControlOrMeta+Z")
    await expect(input).toBeEmpty()
  }
})

test("replaces only the selected text and leaves the caret after the paste", async ({ page }) => {
  const input = await draft(page)
  await page.evaluate(() => navigator.clipboard.writeText("one\ntwo"))
  await page.keyboard.type("before replace after")
  await expect(input).toHaveText("before replace after")
  await page.evaluate(() => document.fonts.ready)

  const word = await input.evaluate((element) => {
    const range = document.createRange()
    range.setStart(element.firstChild!, 7)
    range.setEnd(element.firstChild!, 14)
    const rect = range.getBoundingClientRect()

    return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width }
  })

  await page.mouse.move(word.x, word.y)
  await page.mouse.down()
  await page.mouse.move(word.x + word.width, word.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("replace")
  await page.keyboard.press("ControlOrMeta+V")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo after")
  await page.keyboard.press("ControlOrMeta+Z")
  await expect(input).toHaveText("before replace after")
  await page.keyboard.press("ControlOrMeta+Shift+Z")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo after")
  await page.keyboard.type("!")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo! after")
})

test("shows the dropzone and attaches a dropped file", async ({ page }) => {
  const writes: { path: string; directory: string; body: string }[] = []
  await openDraft(page, {
    name: "ComposerDraft",
    provider: NO_PROVIDER,
    onFileWrite: (write) => void writes.push(write),
  })
  const surface = page.locator('[data-component="new-session"]')
  const dropzone = page.locator('[data-component="session-dropzone"]')

  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer()
    value.items.add(new File(["Dropzone fixture"], "dropzone.txt", { type: "text/plain" }))

    return value
  })

  await expect(dropzone).toHaveCount(0)
  await surface.dispatchEvent("dragover", { dataTransfer: transfer })
  await expect(dropzone).toHaveAttribute("data-visible", "true")
  await expect(dropzone).toContainText("Drop files to add")

  await surface.dispatchEvent("drop", { dataTransfer: transfer })
  await expect(page.locator('[data-component="composer-attachments"]')).toContainText("dropzone.txt")
  await expect(dropzone).toHaveCount(0)
  // The file is uploaded to its own directory in the server's temporary directory, then attached by path.
  await expect
    .poll(() => writes)
    .toEqual([
      {
        path: expect.stringMatching(/\/uploads\/[0-9a-f-]{36}\/dropzone\.txt$/),
        directory: "C:/OpenCode/ComposerDraft",
        body: "Dropzone fixture",
      },
    ])
  await expect(page.locator('[data-component="upload-progress"]')).toHaveCount(0)
  await expect(page.locator('[data-component="composer-attachments"]')).toContainText("dropzone.txt")
})

test("an attachment pasted mid-sentence leaves the text and the caret where they were", async ({ page }) => {
  const { editor } = await openDraft(page, {
    name: "ComposerDraft",
    provider: NO_PROVIDER,
    onFileWrite: () => undefined,
  })

  await editor.click()
  await page.keyboard.type("Hello world")
  await editor.press("Home")

  for (let count = 0; count < "Hello".length; count++) await editor.press("ArrowRight")

  const text = await editor.evaluateHandle((element) => element.firstChild)

  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.items.add(new File(["Attachment fixture"], "notes.txt", { type: "text/plain" }))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-component="composer-attachments"]')).toContainText("notes.txt")
  // A rewrite of the editor would replace this node, even when it put the caret back in the same place.
  expect(await editor.evaluate((element, node) => element.firstChild === node, text)).toBe(true)
  await page.keyboard.type(",")
  await expect(editor).toHaveText("Hello, world")
})

test("keeps one dropzone while a file drag crosses the composer, and none for a text drag", async ({ page }) => {
  const editor = await draft(page)
  await page.keyboard.type("worktree off the latest dev")
  const surface = page.locator('[data-component="new-session"]')
  const dropzone = page.locator('[data-component="session-dropzone"]')

  const text = await page.evaluateHandle(() => {
    const value = new DataTransfer()
    value.setData("text/plain", "worktree off the latest dev")

    return value
  })

  await editor.dispatchEvent("dragenter", { dataTransfer: text })
  await editor.dispatchEvent("dragover", { dataTransfer: text })
  await expect(page.locator("[data-slot='session-dropzone-blur']")).toHaveAttribute("data-visible", "false")
  await expect(dropzone).toHaveCount(0)

  const files = await page.evaluateHandle(() => {
    const value = new DataTransfer()
    value.items.add(new File(["Dropzone fixture"], "dropzone.txt", { type: "text/plain" }))

    return value
  })

  await surface.dispatchEvent("dragover", { dataTransfer: files })
  await expect(dropzone).toHaveAttribute("data-visible", "true")
  const shown = await dropzone.elementHandle()

  // Moving onto the editor's own text fires dragleave on the editor before the next dragover.
  await editor.evaluate((element, dataTransfer) => {
    const inner = element.firstElementChild ?? element

    const fire = (type: string, target: Element, relatedTarget: Element) =>
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, relatedTarget }))

    fire("dragenter", inner, element)
    fire("dragleave", element, inner)
    fire("dragover", inner, element)
  }, files)
  await expect.poll(() => shown?.evaluate((element) => element.isConnected)).toBe(true)
  await expect(dropzone).toHaveAttribute("data-visible", "true")
})

test("keeps a narrow session composer contained when invoking a built-in", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  const { editor } = await openSession(page, { name: "ComposerCommand", provider: NO_PROVIDER })
  const composer = page.locator('[data-component="composer"]')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await editor.fill("keep me")
  await composer.getByRole("button", { name: "Add images and files" }).click()
  await page.getByRole("menuitem", { name: "Commands" }).click()
  await page.locator('[data-suggestion-id="model.choose"]').click()

  const dialog = page.getByRole("dialog", { name: "Select model", exact: true })
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  await expect(search).toBeFocused()
  await expect(editor).toHaveText("keep me")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()

  await editor.fill("/model")
  await expect(page.locator('[data-suggestion-id="model.choose"]')).toHaveAttribute("data-active", "")
  await editor.press("Enter")
  await expect(search).toBeFocused()
  await expect(editor).toBeEmpty()
})

test("keeps focus in a dialog that replaces the model dialog and returns it to the composer caret", async ({
  page,
}) => {
  const { editor } = await openSession(page, {
    name: "ComposerDialogFocus",
    provider: provider({ id: "paid", name: "Paid", cost: { input: 1, output: 1 } }),
  })

  await editor.fill("keep me")
  await editor.press("End")
  await editor.press("ArrowLeft")
  await editor.press("ArrowLeft")
  await editor.press("ArrowLeft")
  // Clicking the trigger leaves focus at the caret, so the replacing dialog returns it there.
  await page.locator('[data-component="composer"] [data-action="composer-model"]').click()

  const models = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(models.getByRole("combobox", { name: "Search models", exact: true })).toBeFocused()
  await models.getByRole("button", { name: "Manage models", exact: true }).click()
  await expect(models).toBeHidden()

  const manage = page.getByRole("dialog", { name: "Manage models", exact: true })
  const search = manage.getByRole("searchbox", { name: "Search models", exact: true })
  await expect(search).toBeFocused()
  // Code behind the dialog that focuses the composer must not pull focus out of the open dialog.
  await editor.evaluate((element) => element.focus())
  await expect(search).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(manage).toBeHidden()
  await expect(editor).toBeFocused()
  await page.keyboard.type(",")
  await expect(editor).toHaveText("keep, me")
})

test("lists OpenCode's free models in the model picker however old they are", async ({ page }) => {
  await page.clock.setFixedTime(T0)
  const year = { released: T0 - 365 * 24 * 60 * 60 * 1000 }
  await openSession(page, {
    name: "ComposerFreeModels",
    provider: provider(
      { id: "new-paid", name: "New Paid", cost: { input: 1, output: 1 }, time: { released: T0 } },
      { id: "old-paid", name: "Old Paid", cost: { input: 1, output: 1 }, time: year },
      { id: "big-pickle", name: "Big Pickle", cost: { input: 0, output: 0 }, time: year },
    ),
  })

  await page.locator('[data-component="composer"] [data-action="composer-model"]').click()
  const models = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(models.locator('[data-option-key="opencode:new-paid"]')).toBeVisible()
  await expect(models.locator('[data-option-key="opencode:big-pickle"]')).toBeVisible()
  await expect(models.locator('[data-option-key="opencode:old-paid"]')).toHaveCount(0)
})

test("lists slash commands in their built-in order", async ({ page }) => {
  const { editor } = await openSession(page, {
    name: "ComposerSlash",
    provider: NO_PROVIDER,
    commands: [
      { name: "init", description: "Create AGENTS.md" },
      { name: "review", description: "Review changes" },
    ],
    // A sent message enables /undo, /compact and /fork.
    pageMessages: () => ({ items: [{ id: "msg_slash", type: "user", text: "Hello", time: { created: T0 } }] }),
  })

  await editor.fill("/")
  await expect(page.locator('[data-component="composer-suggestions"] [data-suggestion-id] bdi')).toHaveText([
    "/init",
    "/review",
    "/new",
    "/undo",
    "/compact",
    "/fork",
    "/export",
    "/open",
    "/terminal",
    "/mcp",
    "/model",
    "/connect",
    "/reload",
    "/agent",
    "/btw",
  ])
})

test("/reload reloads the server's configuration once and reports it", async ({ page }) => {
  const { editor } = await openSession(page, { name: "ComposerReload", provider: NO_PROVIDER })
  const reloaded = Promise.withResolvers<void>()
  let reloads = 0
  await page.route(/\/api\/location\/reload$/, async (route) => {
    reloads++
    await reloaded.promise
    await route.fulfill({ status: 204 })
  })

  await editor.fill("/reload")
  await expect(page.locator('[data-suggestion-id="config.reload"]')).toHaveAttribute("data-active", "")
  await editor.press("Enter")
  await expect(page.getByText("Reloading configuration…", { exact: true })).toBeVisible()
  // A second /reload while the first runs joins it: no second request and no second toast.
  await expect(editor).toBeEmpty()
  await editor.fill("/reload")
  await expect(page.locator('[data-suggestion-id="config.reload"]')).toHaveAttribute("data-active", "")
  await editor.press("Enter")
  await expect(editor).toBeEmpty()
  await expect(page.getByText("Reloading configuration…", { exact: true })).toHaveCount(1)
  reloaded.resolve()
  await expect(page.getByText("Configuration reloaded", { exact: true })).toBeVisible()
  await expect(page.getByText("Reloading configuration…", { exact: true })).toBeHidden()
  await expect(editor).toBeEmpty()
  expect(reloads).toBe(1)
})

test("/fork forks once while its request is pending, can retry a failure, and restores the prompt", async ({
  page,
}) => {
  const source = { id: "ses_fork_source", title: "Fork source" }
  const forks: string[] = []
  const answers = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]

  const { editor } = await openSession(page, {
    name: "ComposerFork",
    provider: NO_PROVIDER,
    sessions: [source],
    pageMessages: pageMessagesFrom({
      [source.id]: [
        { id: "msg_fork_first", type: "user", text: "First prompt", time: { created: T0 } },
        { id: "msg_fork_second", type: "user", text: "Second prompt", time: { created: T0 + 1 } },
      ],
    }),
    onFork: async ({ body }) => {
      forks.push(String(body.before))
      await answers[forks.length - 1]?.promise

      if (forks.length === 1) return { status: 500, body: { message: "Fork failed" } }
    },
  })

  await editor.fill("/fork")
  await expect(page.locator('[data-suggestion-id="session.fork"]')).toHaveAttribute("data-active", "")
  await editor.press("Enter")

  const dialog = page.getByRole("dialog", { name: "Fork from message", exact: true })
  const search = dialog.getByRole("searchbox")
  const newest = dialog.getByRole("option", { name: /Second prompt/ })
  await expect(search).toBeFocused()

  // Enter forks from the newest prompt; a second Enter while the fork runs sends nothing.
  await search.press("Enter")
  await expect(newest).toHaveAttribute("aria-busy", "true")
  await expect(dialog.getByRole("option", { name: /First prompt/ })).toBeDisabled()
  await search.press("Enter")
  answers[0].resolve()

  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(newest).toBeEnabled()
  await expect(newest).not.toHaveAttribute("aria-busy")
  expect(forks).toEqual(["msg_fork_second"])

  await search.press("Enter")
  await expect(newest).toHaveAttribute("aria-busy", "true")
  answers[1].resolve()

  await expectPath(page, sessionHref(`${source.id}_fork`))
  await expect(dialog).toBeHidden()
  await expect(editor).toHaveText("Second prompt")
  expect(forks).toEqual(["msg_fork_second", "msg_fork_second"])
})

const followUp = "Add follow-up, / for commands, @ for context…"

test("the shell shortcut toggles modes and keeps explicit bindings", async ({ page }) => {
  const view = await openDraft(page, {
    name: "ShellToggle",
    seed: {
      settings: {
        keybinds: { "prompt.mode.shell": "mod+alt+s", "prompt.mode.normal": "mod+alt+e" },
      },
    },
  })

  const modifier = await page.evaluate(() => (/Mac/i.test(navigator.platform) ? "Meta" : "Control"))

  const exit = page.getByRole("button", { name: /^Exit/ })

  await view.editor.fill("echo hello")
  await view.editor.press(`${modifier}+Shift+x`)
  await expect(exit).toBeVisible()
  await expect(view.editor).toHaveText("echo hello")
  await view.editor.press(`${modifier}+Shift+x`)
  await expect(exit).toHaveCount(0)
  await expect(view.editor).toHaveText("echo hello")
  await view.editor.press(`${modifier}+Shift+x`)
  await expect(exit).toBeVisible()
  await view.editor.press("Escape")
  await expect(exit).toHaveCount(0)
  await expect(view.editor).toBeFocused()
  await view.editor.press(`${modifier}+Alt+s`)
  await expect(exit).toBeVisible()
  await view.editor.press(`${modifier}+Alt+e`)
  await expect(exit).toHaveCount(0)
  await expect(view.editor).toHaveText("echo hello")
})

for (const row of [
  { state: "an idle", copy: "Ask anything, / for commands, @ for context…" },
  { state: "a running", copy: followUp, sessionStatus: { ses_placeholder: { type: "running" } } },
  {
    state: "an idle queued",
    copy: followUp,
    inbox: [
      {
        id: "inb_placeholder",
        sessionID: "ses_placeholder",
        time: { created: T0 },
        type: "user",
        payload: { text: "Queued follow-up" },
        delivery: "queue",
      },
    ],
  },
]) {
  test(`shows the placeholder for ${row.state} session and the shell example in shell mode`, async ({ page }) => {
    const { editor } = await openSession(page, {
      name: "ComposerPlaceholder",
      sessions: [{ id: "ses_placeholder", title: "Placeholder" }],
      sessionStatus: row.sessionStatus,
      inbox: row.inbox,
    })

    const scroll = page.locator('[data-component="composer-scroll"]')
    await expect(scroll).toHaveText(row.copy)
    await editor.pressSequentially("!")
    await expect(scroll).toHaveText("Enter shell command… git status")
  })
}

test("a sent shell command returns the composer to prompt mode, and ! enters shell mode again", async ({ page }) => {
  const { editor } = await openSession(page, {
    name: "ShellSend",
    sessions: [{ id: "ses_shell_send", title: "Shell send" }],
  })

  const scroll = page.locator('[data-component="composer-scroll"]')
  await expect(scroll).toHaveText("Ask anything, / for commands, @ for context…")
  await editor.pressSequentially("!")
  await expect(scroll).toHaveText("Enter shell command… git status")
  await editor.pressSequentially("git status")

  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/ses_shell_send/shell"),
  )

  await editor.press("Enter")
  expect((await sent).postDataJSON()).toMatchObject({ command: "git status" })
  await expect(editor).toBeEmpty()
  await expect(scroll).toHaveText("Ask anything, / for commands, @ for context…")
  await expect(page.getByRole("button", { name: /^Exit/ })).toHaveCount(0)

  // The editor reads the draft's mode, so it agrees with the draft the send reset.
  await editor.pressSequentially("!")
  await expect(scroll).toHaveText("Enter shell command… git status")
})

test("marks a Console provider with its workspace only when it is also connected directly", async ({ page }) => {
  const model = (id: string, name: string) => ({ [id]: { id, name, limit: { context: 200_000 } } })

  const managed = (id: string, canonical: string, name: string, models: ReturnType<typeof model>) => ({
    id,
    canonical,
    integrationID: "opencode",
    name: `Anomaly / ${name}`,
    models,
  })

  await openSession(page, {
    name: "ComposerConsoleProviders",
    provider: {
      all: [
        managed("opencode", "opencode", "OpenCode", model("console-model", "Console Model")),
        managed("console-google", "google", "Google", model("managed-gemini", "Managed Gemini")),
        managed("console-openai", "openai", "OpenAI", model("managed-gpt", "Managed GPT")),
        { id: "google", canonical: "google", name: "Google", models: model("direct-gemini", "Direct Gemini") },
      ],
      connected: ["opencode", "console-google", "console-openai", "google"],
      default: { providerID: "opencode", modelID: "console-model" },
    },
    seed: {
      storage: {
        "opencode.global.dat:model": {
          user: [
            ["opencode", "console-model"],
            ["console-google", "managed-gemini"],
            ["console-openai", "managed-gpt"],
            ["google", "direct-gemini"],
          ].map(([providerID, modelID]) => ({ providerID, modelID, visibility: "show" })),
          recent: [],
          variant: {},
        },
      },
    },
  })

  const trigger = page.locator('[data-component="composer"] [data-action="composer-model"]')
  await trigger.click()
  const menu = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(menu.getByRole("option", { name: "Direct Gemini", exact: true })).toBeVisible()
  const headings = menu.locator('[data-slot="search-list-header"]')
  await expect(headings).toHaveCount(4)
  await expect(headings.filter({ hasText: /^GoogleAnomaly$/ })).toHaveCount(1)
  await expect(headings.filter({ hasText: /^Google$/ })).toHaveCount(1)
  await expect(headings.filter({ hasText: /^OpenAI$/ })).toHaveCount(1)
  await expect(headings.filter({ hasText: /^OpenCode$/ })).toHaveCount(1)
  await expect(menu.getByText(/Anomaly \//)).toHaveCount(0)
})

test("shows thinking on hover or a non-default selection while preserving keyboard access", async ({ page }) => {
  const { editor: input } = await openSession(page, {
    name: "ComposerThinking",
    provider: provider({ id: "thinking-model", name: "Thinking Model", variants: { high: {} } }),
  })

  const composer = page.locator('[data-component="composer"]')
  const control = composer.getByRole("button", { name: "Choose model variant" })
  const option = (name: string) => page.getByRole("menuitemradio", { name, exact: true })

  await page.mouse.move(0, 0)
  await expect(control).toHaveText("default")
  await expect(control).toHaveCSS("opacity", "0")
  await expect(control).toHaveCSS("pointer-events", "none")

  await input.hover()
  await expect(control).toHaveCSS("opacity", "1")

  // The menu keeps the control visible after the pointer leaves.
  await control.click()
  await expect(option("high")).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toHaveAttribute("aria-expanded", "true")
  await expect(control).toHaveCSS("opacity", "1")
  await option("high").click()

  await input.click()
  await page.mouse.move(0, 0)
  await expect(control).toHaveText("high")
  await expect(control).toHaveCSS("opacity", "1")

  await control.click()
  await option("default").click()
  await input.click()
  await page.mouse.move(0, 0)
  await expect(control).toHaveText("default")
  await expect(control).toHaveCSS("opacity", "0")

  // The single-agent fixture has Add, Agent and Model before the thinking trigger.
  await page.keyboard.press("Tab")
  await expect(composer.getByRole("button", { name: "Add images and files" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(composer.getByRole("button", { name: "Choose agent" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(composer.getByRole("button", { name: "Thinking Model" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(control).toBeFocused()
  await expect(control).toHaveCSS("opacity", "1")
  await page.keyboard.press("Enter")
  await expect(option("default")).toBeFocused()
  await expect(control).toHaveCSS("opacity", "1")
  await page.keyboard.press("Escape")
  await expect(control).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(control).toHaveCSS("opacity", "0")
})

test("pastes into the composer from the session view but not into other inputs", async ({ page }) => {
  const prompts: unknown[] = []
  const { editor } = await openSession(page, { name: "PasteFocus", onPrompt: (input) => void prompts.push(input.body) })
  await editor.fill("hello")
  await editor.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  const message = page.locator('[data-timeline-row="UserMessage"]')
  await message.click()
  await expect(editor).not.toBeFocused()

  await page.evaluate(() => navigator.clipboard.writeText("pasted from the timeline"))
  await page.keyboard.press("ControlOrMeta+V")
  await expect(editor).toBeFocused()
  await expect.poll(() => editor.innerText()).toBe("pasted from the timeline")

  await editor.blur()
  await page.evaluate(() => {
    const field = document.createElement("input")
    field.id = "elsewhere"
    document.body.append(field)
    field.focus()
  })
  await page.keyboard.press("ControlOrMeta+V")
  await expect(page.locator("#elsewhere")).toHaveValue("pasted from the timeline")
  await expect(page.locator("#elsewhere")).toBeFocused()
  await expect.poll(() => editor.innerText()).toBe("pasted from the timeline")
})
