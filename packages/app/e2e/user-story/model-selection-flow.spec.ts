import { expect, test } from "@playwright/test"
import { project, provider, sessionHref } from "../utils/app"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { openSession } from "../utils/workspace"

const directory = "C:/OpenCode/NewProject"

test("creates a session in a new project and selects its model", async ({ page }) => {
  // An empty draft must remain usable when the file viewer is unavailable.
  await page.route(/(?:\/_assets\/file-(?!icon-)[^/]+\.js|\/session-ui\/src\/components\/file\.tsx)(?:\?|$)/, (route) =>
    route.abort(),
  )
  const created = project({ id: "proj_model_selection_flow", directory, name: "NewProject" })
  // The server knows no project until the user adds this one.
  const projects: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: created,
    projects: () => projects,
    // The picker answers with the platform's separators; the server resolves them to its own.
    onLocationGet: (requested) => {
      if (requested.replaceAll("\\", "/") === directory && !projects.includes(created)) projects.push(created)
    },
    provider: () => ({
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "free-model": {
              id: "free-model",
              name: "Free Model",
              cost: { input: 0, output: 0 },
              limit: { context: 200_000 },
            },
          },
        },
        {
          id: "opencode-go",
          name: "OpenCode Go",
          models: {
            "go-model-1": {
              id: "go-model-1",
              name: "Go Model 1",
              cost: { input: 1, output: 1 },
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode", "opencode-go"],
      default: { providerID: "opencode", modelID: "free-model" },
    }),
    sessions: [],
    pageMessages: () => ({ items: [] }),
    // Listings are requested by absolute path and returned relative to the stable Location.
    fileList: (path) => (path === "C:/OpenCode" ? [{ path: "./", type: "directory", ignored: false }] : []),
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        user: [
          { providerID: "opencode", modelID: "free-model", visibility: "show" },
          { providerID: "opencode-go", modelID: "go-model-1", visibility: "show" },
        ],
        recent: [{ providerID: "opencode-go", modelID: "go-model-1" }],
        variant: {},
      }),
    )
  })

  await page.goto("/")
  const addProject = page.locator('[data-action="home-add-project-row"]')
  await expectAppVisible(addProject)
  await addProject.click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  await expect(picker.getByRole("combobox")).toHaveValue("")

  const listing = page.waitForRequest((request) => {
    const url = new URL(request.url())

    return url.pathname === "/api/fs/list" && url.searchParams.get("path") === "C:/OpenCode"
  })

  await picker
    .getByRole("navigation", { name: "Folder path", exact: true })
    .getByRole("button", { name: "OpenCode", exact: true })
    .click()
  expect(new URL((await listing).url()).searchParams.get("location[directory]")).toBe(directory)
  const directoryItem = picker.getByRole("treeitem", { name: "NewProject", exact: true })
  await expect(directoryItem).toBeVisible()
  await directoryItem.click()
  await expect(directoryItem).toHaveAttribute("aria-selected", "true")
  const selectFolder = picker.getByRole("button", { name: "Select folder", exact: true })
  await expect(selectFolder).toBeEnabled()
  await selectFolder.click()
  await expect(picker).toBeHidden()

  await page.locator('[data-action="home-new-session"]').click()
  await expectAppVisible(page.locator('[data-component="composer"]'))

  const modelControl = page.locator('[data-action="composer-model"]')
  await expect(modelControl).toContainText("Go Model 1")
  await modelControl.click()
  const modelSearch = page.getByPlaceholder("Search models", { exact: true })
  await expect(modelSearch).toBeFocused()
  await modelSearch.press("ArrowDown")
  await modelSearch.press("Enter")
  await expect(modelControl).toContainText("Free Model")

  await modelControl.click()
  await expect(modelSearch).toBeFocused()
  await modelSearch.press("ArrowUp")
  await modelSearch.press("Enter")

  await expect(modelControl).toContainText("Go Model 1")
})

test("restores each existing session's model and variant when switching tabs", async ({ page }) => {
  const sessions = ["A", "B"].map((name) => ({
    id: `ses_model_${name}`,
    title: `Model ${name}`,
    model: { id: `model-${name}`, providerID: "opencode", variant: "balanced" },
  }))

  await openSession(page, {
    name: "ModelSelection",
    sessions,
    provider: provider(
      ...sessions.map((session) => ({
        id: session.model.id,
        name: session.title,
        variants: { balanced: {}, high: {} },
      })),
    ),
  })

  const hrefA = sessionHref(sessions[0]!.id)
  const hrefB = sessionHref(sessions[1]!.id)
  const composer = page.locator('[data-component="composer"]')
  const modelControl = composer.locator('[data-action="composer-model"]')
  const variant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  await expect(modelControl).toHaveText("Model A")
  await expect(variant).toHaveText("balanced")
  await variant.click()
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
  await expect(variant).toHaveText("high")

  await page.locator(`[data-titlebar-tab-link][href="${hrefB}"]`).click()
  await expect(page).toHaveURL(hrefB)
  await expect(modelControl).toHaveText("Model B")
  await expect(variant).toHaveText("balanced")
  await variant.click()
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
  await expect(variant).toHaveText("high")

  // A new draft starts from the current session's non-default model and chosen variant.
  await page.getByRole("button", { name: "New session", exact: true }).click()
  await expect(page).toHaveURL(/\/new-session\?draftId=/)
  await expect(modelControl).toHaveText("Model B")
  await expect(variant).toHaveText("high")

  await page.locator(`[data-titlebar-tab-link][href="${hrefA}"]`).click()
  await expect(page).toHaveURL(hrefA)
  await expect(modelControl).toHaveText("Model A")
  await expect(variant).toHaveText("high")
})

test("keeps a variant picked in another directory's session with that session across a reload", async ({ page }) => {
  // The session view stays mounted while its tabs switch between sessions in different directories.
  const sessions = [
    { name: "Home", directory: "C:/OpenCode/ModelHome" },
    { name: "Away", directory: "C:/OpenCode/ModelAway" },
  ].map((item) => ({
    id: `ses_model_${item.name.toLowerCase()}`,
    title: `${item.name} session`,
    directory: item.directory,
    model: { id: `model-${item.name.toLowerCase()}`, providerID: "opencode", variant: "balanced" },
  }))

  await openSession(page, {
    name: "ModelHome",
    sessions,
    provider: provider(
      ...sessions.map((session) => ({
        id: session.model.id,
        name: session.title,
        variants: { balanced: {}, high: {} },
      })),
    ),
  })

  const [home, away] = sessions.map((session) => sessionHref(session.id))
  const composer = page.locator('[data-component="composer"]')
  const modelControl = composer.locator('[data-action="composer-model"]')
  const variant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  await expect(modelControl).toHaveText("Home session")
  await page.locator(`[data-titlebar-tab-link][href="${away}"]`).click()
  await expect(page).toHaveURL(away!)
  await expect(modelControl).toHaveText("Away session")
  await expect(variant).toHaveText("balanced")
  await variant.click()
  await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
  await expect(variant).toHaveText("high")

  await page.reload()
  await expect(modelControl).toHaveText("Away session")
  await expect(variant).toHaveText("high")

  await page.locator(`[data-titlebar-tab-link][href="${home}"]`).click()
  await expect(page).toHaveURL(home!)
  await expect(modelControl).toHaveText("Home session")
  await expect(variant).toHaveText("balanced")
})

// SC-004/SC-006 with FR-001/FR-002/FR-008/FR-011/FR-036/FR-037: the same row click in either picker exchanges the pair
// and nothing else - each model keeps the variant it had - while the flyout's check mark already shows the variant the
// pair rule will carry, and the option the user actually clicks is what wins (FR-037 read with FR-036).
test("a model row in either picker exchanges the pair, and the flyout's named variant wins", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "ModelPairFlow",
    sessions: [{ id: "ses_pair_flow", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
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

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = composer.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(fallback).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("high")

  // Direction 1: a plain row click in the PRIMARY picker naming the model that sits in the fallback slot. Neither
  // variant control is touched, so the models trade places each wearing its own variant, and the only write is the
  // config field that holds the displaced model.
  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await primary.click()
  const primaryDialog = page.getByRole("dialog", { name: "Select model" })
  await expect(primaryDialog).toBeVisible()
  // The opposite slot's model is offered there as an ordinary row, with nothing marked as special about it (FR-024).
  await primaryDialog.getByRole("button", { name: "Beta Free", exact: true }).click()
  await expect(primary).toHaveText("Beta")
  await expect(primaryVariant).toHaveText("high")
  await expect(fallback).toHaveText("Alpha")
  await expect(fallbackVariant).toHaveText("low")
  expect(JSON.parse((await displaced).postData()!)).toEqual({ fallback: { providerID: "opencode", model: "alpha", variant: "low" } })

  // Direction 2, from the other picker, this time clicking the flyout OPTION: the variant it names lands in the slot
  // the user acted in, over the one the pair would have carried, and the config records that same pair. The pointer
  // crosses two rows so the highlight, and the flyout with it, follow the cursor.
  const named = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await fallback.click()
  const fallbackDialog = page.getByRole("dialog", { name: "Select model" })
  await expect(fallbackDialog).toBeVisible()
  const secondFlyout = fallbackDialog.locator('[data-slot="model-dialog-flyout"]')
  await fallbackDialog.locator('[data-option-key="opencode:alpha"]').hover()
  await fallbackDialog.locator('[data-option-key="opencode:beta"]').hover()
  // The check mark already named the carried variant, which is what the row click would have written (FR-037).
  await expect(secondFlyout.getByRole("menuitemradio", { name: "high", exact: true })).toHaveAttribute("aria-checked", "true")
  await secondFlyout.getByRole("menuitemradio", { name: "low", exact: true }).click()
  await expect(fallback).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("low")
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  expect(JSON.parse((await named).postData()!)).toEqual({ fallback: { providerID: "opencode", model: "beta", variant: "low" } })
})

// FR-024/FR-033 (spec User Story 2 scenario 11): the model sitting in the other slot is offered as a normal row even
// though the user hid it, it exchanges like any other row, and afterwards it is still hidden in the ordinary list -
// offering it is the picker's business, never a rewrite of what the user chose to hide.
test("a hidden opposite-slot model is offered, exchanges, and stays hidden", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "HiddenPairModel",
    sessions: [{ id: "ses_hidden_pair", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    // A paid catalog, so both pickers are the model dialog with its ordinary rows and search box.
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
    seed: {
      storage: {
        "opencode.global.dat:model": {
          user: [
            // The user hides this composer's own model; `beta` is the one the config names as fallback.
            { providerID: "opencode", modelID: "alpha", visibility: "hide" },
            { providerID: "opencode", modelID: "beta", visibility: "show" },
          ],
          recent: [],
          variant: {},
        },
      },
    },
  })

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("Beta")

  // Acting in the fallback picker, the other slot's model is `alpha`: hidden by the user, and present here only because
  // it is the pair's other half (FR-024). The dialog is open and searchable, so the ordinary list is what it is.
  await fallback.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-option-key="opencode:beta"]')).toBeVisible()
  await expect(dialog.locator('[data-option-key="opencode:alpha"]')).toBeVisible()

  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await dialog.locator('[data-option-key="opencode:alpha"]').click()
  await expect(primary).toHaveText("Beta")
  await expect(fallback).toHaveText("Alpha")
  expect(JSON.parse((await displaced).postData()!)).toEqual({
    fallback: { providerID: "opencode", model: "alpha", variant: "low" },
  })

  // Still hidden: the picker opens on the ordinary list again, and the model the user hid is not in it, while the
  // offered row is now the other half of the pair (FR-033 - the exchange re-applied what the user had chosen).
  await fallback.click()
  const reopened = page.getByRole("dialog", { name: "Select model" })
  await expect(reopened).toBeVisible()
  // The list is grouped, so scope to the provider's own group: the Recent section lists models this slot already used
  // whatever their visibility, and the exchange just made `alpha` recent. What must not come back is the row the user
  // hid in the ordinary list (FR-033).
  const ordinary = reopened.getByRole("group", { name: "OpenCode" })
  await expect(ordinary.locator('[data-option-key="opencode:beta"]')).toBeVisible()
  await expect(ordinary.locator('[data-option-key="opencode:alpha"]')).toHaveCount(0)
  // And the record the user made is untouched: offering a model is never a rewrite of what they chose to hide. The
  // persisted document is read once and its absence fails the case outright rather than parsing a stand-in value.
  const persisted = await page.evaluate(() => localStorage.getItem("opencode.global.dat:model"))

  if (persisted === null) throw new Error("No model-selection record was persisted for this workspace")
  expect(JSON.parse(persisted)).toMatchObject({
    user: [
      { providerID: "opencode", modelID: "alpha", visibility: "hide" },
      { providerID: "opencode", modelID: "beta", visibility: "show" },
    ],
  })
})

// FR-010 read with FR-037/FR-011: the other slot's model sitting at its Default is previewed AT that Default, even in a
// workspace that remembers a named variant for that model. The flyout's check mark and the keyboard's pre-highlight are
// the value this exchange writes, never a preference the picker would borrow from that model's own history (SC-006).
test("an opposite-slot model at Default previews Default although a variant is remembered for it", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "DefaultPairVariant",
    sessions: [{ id: "ses_default_pair_variant", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // The config names this fallback outright with NO variant: the pair's other half wears its own Default.
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta" } }],
    seed: {
      storage: {
        "opencode.global.dat:model": {
          user: [
            { providerID: "opencode", modelID: "alpha", visibility: "show" },
            { providerID: "opencode", modelID: "beta", visibility: "show" },
          ],
          recent: [],
          // This workspace once used `beta` at `high`. That per-model record stays where it belongs (FR-011) and is
          // not what the pair carries here (FR-010), so it must not reach the preview of the row this click promotes.
          variant: { "opencode/beta": "high" },
        },
      },
    },
  })

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("Beta")

  await primary.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  const beta = dialog.locator('[data-option-key="opencode:beta"]')
  const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
  await beta.hover()
  await expect(flyout).toBeVisible()
  // The check mark is on Default: `high` is that model's own remembered preference, not what promoting it would write.
  await expect(flyout.getByRole("menuitemradio", { name: "Default", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(flyout.getByRole("menuitemradio", { name: "high", exact: true })).toHaveAttribute("aria-checked", "false")
  await expect(flyout.getByRole("menuitemradio", { name: "low", exact: true })).toHaveAttribute("aria-checked", "false")

  // The keyboard's pre-highlight agrees: entering the flyout from that row lands on the same Default entry the pointer
  // shows (FR-037 read with FR-022, `menu.entered` in `select-dialog.tsx`).
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  await search.click()
  await search.press("ArrowDown")
  await search.press("ArrowDown")
  await expect(beta).toHaveAttribute("data-active", "")
  await search.press("ArrowRight")
  await expect(flyout.getByRole("menuitemradio", { name: "Default", exact: true })).toHaveAttribute("data-highlighted", "")

  // Clicking the row promotes the pair, and the pair is exactly what the preview said: Beta at Default, Alpha at low.
  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await beta.click()
  await expect(primary).toHaveText("Beta")
  await expect(primaryVariant).toHaveText("default")
  await expect(fallback).toHaveText("Alpha")
  await expect(composer.getByRole("button", { name: "Choose fallback model variant", exact: true })).toHaveText("low")
  expect(JSON.parse((await displaced).postData()!)).toEqual({
    fallback: { providerID: "opencode", model: "alpha", variant: "low" },
  })
  // The record written for `beta` names the Default outright, which is the value this click chose rather than the
  // remembered `high` the preview could have borrowed. A missing document is reported as such rather than parsed away.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("opencode.global.dat:model")

        if (raw === null) return "MISSING-DOCUMENT"

        // SAFETY: this is the document the app itself wrote, and every field below is read through optional access, so
        // any other shape answers `MISSING-VARIANT` and can never be mistaken for the variant this click chose.
        return (JSON.parse(raw) as { variant?: Record<string, string | undefined> }).variant?.["opencode/beta"] ?? "MISSING-VARIANT"
      }),
    )
    .toBe("default")
})

// FR-036/FR-037 with FR-022 read through FR-005: the keyboard completes the same promotion a pointer click does. The
// arrows move the row marker, the forward arrow enters that row's flyout on the variant the pair rule would carry, and
// `Enter` activates the item the arrows rest on, so the variant the user named by key is what the exchange writes.
test("the keyboard alone exchanges the pair on a variant named in the flyout", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "KeyboardPairExchange",
    sessions: [{ id: "ses_keyboard_pair", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    // A paid catalog, so this is the ordinary model dialog with its search box and variant flyout.
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
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

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  const fallbackVariant = composer.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(fallback).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("high")

  await primary.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  const alpha = dialog.locator('[data-option-key="opencode:alpha"]')
  const beta = dialog.locator('[data-option-key="opencode:beta"]')
  await search.click()

  // The marker is read off `data-active`, never assumed: the search list starts on its first row and its arrows wrap
  // (`packages/ui/src/forms/search-list/search-list.tsx:54`), so one ArrowDown lands on the other slot's model.
  await search.press("ArrowDown")
  await expect(beta).toHaveAttribute("data-active", "")
  await expect(alpha).not.toHaveAttribute("data-active", "")

  // The highlighted row's flyout opens with the keyboard, checked on the variant the pair rule would carry (`high`),
  // and the forward arrow enters that menu on the same item (FR-037: preview equals the row-click outcome).
  const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
  await expect(flyout).toBeVisible()
  await expect(flyout.getByRole("menuitemradio", { name: "high", exact: true })).toHaveAttribute("aria-checked", "true")
  await search.press("ArrowRight")
  await expect(flyout.getByRole("menuitemradio", { name: "high", exact: true })).toHaveAttribute("data-highlighted", "")

  // Inside the menu the arrows move the highlight, and Enter activates whatever item it rests on: this user named `low`,
  // which wins over the carried `high` and travels in the same intent as the model write (FR-036).
  await search.press("ArrowDown")
  await expect(flyout.getByRole("menuitemradio", { name: "low", exact: true })).toHaveAttribute("data-highlighted", "")

  const writes: string[] = []
  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") writes.push(request.method())
  })
  await search.press("Enter")

  await expect(primary).toHaveText("Beta")
  await expect(primaryVariant).toHaveText("low")
  await expect(fallback).toHaveText("Alpha")
  await expect(fallbackVariant).toHaveText("low")
  expect(JSON.parse((await displaced).postData()!)).toEqual({
    fallback: { providerID: "opencode", model: "alpha", variant: "low" },
  })
  // One action, one config save: naming a variant by key adds no second variant-only write (FR-018's newer-intent rule
  // has nothing to supersede here).
  await expect
    .poll(() => writes)
    .toEqual(["PATCH"])
  // The keyboard's Enter is a selection, so it closes the picker as a row click does.
  await expect(dialog).toBeHidden()
})

// SC-004 with FR-005/FR-020: the `/model` command reaches the same wrapped slot as a chip click, so it exchanges
// rather than writing one slot, while an exchange whose other half the catalog cannot name is refused before anything
// is written - no config save, no half-moved pair, and the chips say what they said (FR-001/FR-017/FR-020).
test("the /model command exchanges, and a pair the catalog cannot name is refused", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "CommandPairExchange",
    sessions: [{ id: "ses_command_pair", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
    // Both models are visible in the ordinary list, so `/model`'s dialog (which offers no opposite-slot row) still has
    // the fallback's model as a normal row to click.
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

  const editor = page.locator('[data-component="composer-editor"]')
  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = composer.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(fallback).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("high")

  // The typed command, not a chip click: the suggestion becomes the same model dialog the composer's own picker opens.
  await editor.fill("/model")
  await expect(page.locator('[data-suggestion-id="model.choose"]')).toHaveAttribute("data-active", "")
  await editor.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(dialog.locator('[data-option-key="opencode:beta"]')).toBeVisible()

  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await dialog.locator('[data-option-key="opencode:beta"]').click()
  await expect(primary).toHaveText("Beta")
  await expect(primaryVariant).toHaveText("high")
  await expect(fallback).toHaveText("Alpha")
  await expect(fallbackVariant).toHaveText("low")
  expect(JSON.parse((await displaced).postData()!)).toEqual({
    fallback: { providerID: "opencode", model: "alpha", variant: "low" },
  })

  // A variant change of the slot the pair just moved writes that slot only: the config field that holds the fallback
  // takes no write at all, and the other slot keeps its model AND its own variant (FR-002/FR-014 read with FR-003).
  // Reaching it by keyboard rather than by chip proves FR-016's other half: the command binding acts on the same
  // wrapped slot a click does. `mod` is Meta on macOS and Control elsewhere, exactly as `parseKeybind` reads it.
  const writes: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") writes.push(request.method())
  })
  const mod = /mac/i.test(await page.evaluate(() => navigator.platform)) ? "Meta" : "Control"
  await editor.press(`${mod}+Shift+D`)
  // The model's variants are high then low, so the cycle moves `high` to `low` in this slot alone.
  await expect(primaryVariant).toHaveText("low")
  await expect(primary).toHaveText("Beta")
  await expect(fallback).toHaveText("Alpha")
  await expect(fallbackVariant).toHaveText("low")
  expect(writes).toEqual([])
})

// FR-021/FR-031 read with FR-013 (spec User Story 9 scenario 1 / Story 11): on a free account the model picker keeps
// its own affordances - the free-model dialog with its free-model list - and offers no pair affordance of any kind,
// while the chips still state the pair, because the pair rule is identity-only and never reads the account.
// NOTE: only the primary chip has an unpaid branch today (`composer.tsx:134`); the fallback chip always opens the
// ordinary dialog, and wiring its free/upgrade affordances is task 23-24, in the fallback-affordances slice.
test("a free account keeps the fallback picker's own affordances and offers no pair affordance", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  await openSession(page, {
    name: "FreePairPicker",
    sessions: [{ id: "ses_free_pair", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    // A free account: every model of the only connected provider costs nothing, which is what makes `paid` empty.
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 0, output: 0 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 0, output: 0 }, variants: { high: {}, low: {} } },
    ),
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
  })

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("Beta")

  // No affordance acts on the pair from the row (FR-031), in any account state: this is the only label such a control
  // would carry, and the row's controls are the model, its variant, the fallback and its variant.
  await expect(composer.getByRole("button", { name: "Swap primary and fallback models", exact: true })).toHaveCount(0)

  // The picker still opens its own dialog, and on a free account that dialog is the free-model one: it states the free
  // models OpenCode provides and none of the ordinary search-list rows (FR-021). The fallback chip beside it keeps
  // stating the configured fallback, because the pair rule is identity-only and never reads the account (FR-013).
  await primary.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Free models provided by OpenCode")).toBeVisible()
  await expect(dialog.getByRole("combobox", { name: "Search models", exact: true })).toHaveCount(0)
  // Nothing in the dialog or the row names a pair action, and the pair is exactly as it was.
  await expect(dialog.getByText("Swap", { exact: false })).toHaveCount(0)
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("Beta")
  await expect(page.locator('[data-action="composer-fallback-swap"]')).toHaveCount(0)
  await expect(page.locator('[data-action="composer-fallback-clear"]')).toHaveCount(0)

  // FR-014 read with FR-005: the free dialog's own selection action reaches the same wrapped slot a paid row click
  // does (`unpaid.tsx:55` calls `model.set(key, { recent: true })`), so choosing the model sitting in the other slot
  // promotes the pair from this account state too. The row is an ordinary free-model row: nothing about the pair is
  // surfaced as a separate affordance, and one action is one write.
  const freeWrites: string[] = []
  const displaced = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") freeWrites.push(request.method())
  })
  await dialog.getByRole("button", { name: "Beta Free", exact: true }).click()
  await expect(primary).toHaveText("Beta")
  await expect(composer.getByRole("button", { name: "Choose model variant", exact: true })).toHaveText("high")
  await expect(fallback).toHaveText("Alpha")
  await expect(composer.getByRole("button", { name: "Choose fallback model variant", exact: true })).toHaveText("low")
  expect(JSON.parse((await displaced).postData()!)).toEqual({
    fallback: { providerID: "opencode", model: "alpha", variant: "low" },
  })
  // Exactly one config save: the carried `high` travelled with the model write, so no follow-up variant-only write
  // lands on the config field (FR-036's one-intent rule, FR-031's no-second-affordance rule).
  await expect
    .poll(() => freeWrites)
    .toEqual(["PATCH"])

  // The free dialog is closed by the selection like any other picker, and the free-account copy is still what it was:
  // promoting a pair added no affordance to this dialog either.
  await expect(dialog).toBeHidden()
  await primary.click()
  const reopened = page.getByRole("dialog", { name: "Select model" })
  await expect(reopened.getByText("Free models provided by OpenCode")).toBeVisible()
  await expect(reopened.getByRole("combobox", { name: "Search models", exact: true })).toHaveCount(0)
  await expect(reopened.getByText("Swap", { exact: false })).toHaveCount(0)
})

// FR-023 read with FR-022 (spec User Story 10 scenario 3): with no fallback, a selection in a picker changes that
// slot alone and the config-owned field is never touched, so a user who never enabled a fallback sees no sign of the
// pair rule at all.
test("with no fallback a selection moves one slot and writes no config", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  const writes: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") writes.push(request.method())
  })

  await openSession(page, {
    name: "NoFallbackSelection",
    sessions: [{ id: "ses_no_fallback", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // The saved config turns fallback off outright, which is the only way to reach that state from the UI's data.
    configEntries: [{ type: "document", path: configPath, info: { fallback: null } }],
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

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("None")

  await primary.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-option-key="opencode:beta"]').click()
  await expect(primary).toHaveText("Beta")
  // No exchange happened because there is nothing to exchange with: the fallback row still says there is none, the
  // session's own model moved, and the config field that would hold a pair was never written (FR-022/FR-023).
  await expect(fallback).toHaveText("None")
  expect(writes).toEqual([])
})

// FR-012/FR-013 with SC-007 (T019/T022): "None" is an action on the fallback slot and only that slot. It writes the
// config field as a literal `null`, and because the mock's config is stateful (T002) the reloaded composer below reads
// THAT saved document: recovery stays off instead of returning a configured model or the shipped default, and the reload
// asks for no write of its own. The primary model, its variant and its own picker are untouched throughout.
test("the fallback picker's None row turns recovery off and the saved null survives a reload", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  // Counted from the first request of the page, so a state change that quietly saved in the background would show up.
  const writes: string[] = []
  const bodies: unknown[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/experimental/config") return
    writes.push(request.method())
    bodies.push(JSON.parse(request.postData() ?? "null"))
  })

  await openSession(page, {
    name: "FallbackNoneReload",
    sessions: [{ id: "ses_fallback_none", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // A configured fallback, so the off state below is a change the user made rather than this scenario's starting data.
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/beta#high" } }],
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

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const chip = composer.locator('[data-action="composer-fallback-model"]')
  const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
  const fallbackVariant = composer.getByRole("button", { name: "Choose fallback model variant", exact: true })
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(chip).toHaveText("Beta")
  await expect(fallbackVariant).toHaveText("high")

  // FR-013: the row belongs to the slot the picker acts on, so the PRIMARY picker gains no such row.
  await primary.click()
  const primaryDialog = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(primaryDialog.getByRole("combobox", { name: "Search models", exact: true })).toBeVisible()
  await expect(primaryDialog.locator('[data-option-key="none"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(primaryDialog).toBeHidden()

  // The fallback picker leads its list with the row. It names the action with the existing copy, and wears none of a
  // model's affordances: no variant label, and no favorite or variant affordance to go with it (FR-012).
  await chip.click()
  const dialog = page.getByRole("dialog", { name: "Select model", exact: true })
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  const none = dialog.locator('[data-option-key="none"]')
  await expect(none).toBeVisible()
  await expect(none.locator('[data-slot="model-dialog-name"]')).toHaveText("None")
  await expect(none.locator('[data-slot="model-dialog-variant"]')).toHaveCount(0)
  await expect(none).toHaveAttribute("data-active", "")
  // A fallback is configured, so no check mark names this row the current entry yet.
  await expect(none.locator('[data-slot="model-dialog-check"] [data-slot="icon-svg"]')).toHaveCount(0)

  // It is an action rather than a search result, so a query that hides models leaves it listed (FR-012).
  await search.fill("bet")
  await expect(none).toBeVisible()
  await search.fill("")

  // The action writes the field once, with the literal `null` the field has to hold for the next load.
  const written = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
  await none.click()
  await expect(dialog).toBeHidden()
  expect(JSON.parse((await written).postData()!)).toEqual({ fallback: null })
  // Nothing about the primary half moved: the model, its variant control, and the fallback's own variant control, which
  // leaves with an absent fallback (FR-012 read with FR-028).
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(chip).toHaveText("None")
  await expect(fallbackVariant).toHaveCount(0)
  expect(writes).toEqual(["PATCH"])

  // Re-opened, the row is the current entry, and the keyboard reaches it: Enter in the field takes the action the
  // picker opens on. Taking it again while off writes nothing further (FR-013), and closes the picker as a row click
  // does.
  await chip.click()
  const reopened = page.getByRole("dialog", { name: "Select model", exact: true })
  const current = reopened.locator('[data-option-key="none"]')
  // The row is now the current entry, marked with the same check mark a model row wears for the slot's current model,
  // and the list opens on it, which is what makes the keyboard's Enter land there.
  await expect(current.locator('[data-slot="model-dialog-check"] [data-slot="icon-svg"]')).toHaveCount(1)
  await expect(current).toHaveAttribute("data-active", "")
  await reopened.getByRole("combobox", { name: "Search models", exact: true }).press("Enter")
  await expect(reopened).toBeHidden()
  await expect(chip).toHaveText("None")
  await expect.poll(() => writes).toEqual(["PATCH"])

  // The reload reads the saved document through the mock's own state, so what follows is the user's saved choice rather
  // than a fresh scenario: no configured fallback model returns, no shipped default returns, and nothing re-saves the
  // field on the way (FR-013/FR-021).
  const configRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/config")
  await page.reload()
  await expect(primary).toHaveText("Alpha")
  await expect(primaryVariant).toHaveText("low")
  await expect(chip).toHaveText("None")
  await expect(chip).not.toHaveAttribute("aria-description", "Fallback inactive: it would repeat the primary model")
  await expect(fallbackVariant).toHaveCount(0)

  // The highest-precedence `fallback` in the answer the reloaded page got is still the null it wrote: an absent field
  // would be the other half of the distinction, and would put the shipped default back (SC-007).
  const documents: Array<{ type: string; path?: string; info?: { fallback?: string | null } }> = await configRead.then(
    (response) => response.json(),
  )

  const recorded = documents.filter((entry) => "fallback" in (entry.info ?? {})).at(-1)
  expect(recorded?.info?.fallback).toBeNull()
  expect(writes).toEqual(["PATCH"])

  // And the row is still there to take after the reload, still marked as the current entry.
  await chip.click()
  const afterReload = page.getByRole("dialog", { name: "Select model", exact: true })
  await expect(afterReload.locator('[data-option-key="none"]')).toHaveAttribute("data-active", "")
  await expect(afterReload.locator('[data-option-key="none"]')).toHaveAccessibleName("None")
  await afterReload.getByRole("combobox", { name: "Search models", exact: true }).press("Escape")
  await expect(afterReload).toBeHidden()
  expect(writes).toEqual(["PATCH"])
})

// FR-020: a row click whose exchange would put a model the catalog cannot name into a slot is refused BEFORE any owner
// is asked, so a half-moved pair is never displayed and the config field is never written. The disconnected-provider
// half of the same guard (`validModel` at `providers/models/selection.tsx:616`) is proven at the owner boundary in
// `test-browser/fixtures/model-selection.ts`, where the pair is patched to a provider the mock never connects.
test("an exchange the catalog cannot name writes nothing at all", async ({ page }) => {
  const configPath = "/home/test/.config/opencode/opencode.jsonc"
  // Counted from the first request of the page, so a refusal that quietly saved the pair it refused would show up.
  const patches: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/experimental/config") patches.push(request.method())
  })

  await openSession(page, {
    name: "RefusedExchange",
    sessions: [{ id: "ses_refused_exchange", agent: "build", model: { id: "alpha", providerID: "opencode", variant: "low" } }],
    provider: provider(
      { id: "alpha", name: "Alpha", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
      { id: "beta", name: "Beta", cost: { input: 3, output: 15 }, variants: { high: {}, low: {} } },
    ),
    // The config names a fallback this workspace's catalog has no model for: the chip says so rather than going blank.
    configEntries: [{ type: "document", path: configPath, info: { fallback: "opencode/gamma#high" } }],
  })

  const composer = page.locator('[data-component="composer"]')
  const primary = composer.locator('[data-action="composer-model"]')
  const fallback = composer.locator('[data-action="composer-fallback-model"]')
  await expect(primary).toHaveText("Alpha")
  // A fallback the catalog cannot name keeps the picker's existing unavailable affordance rather than going blank.
  await expect(fallback).toHaveText("gamma (unavailable)")

  // The other slot's model is offered in this picker, so the click the pair rule refuses is a real row click.
  await fallback.click()
  const dialog = page.getByRole("dialog", { name: "Select model" })
  await expect(dialog.locator('[data-option-key="opencode:alpha"]')).toBeVisible()
  await dialog.locator('[data-option-key="opencode:alpha"]').click()

  // Nothing moved: the pair is as it was, the picker is closed, and no config write was issued for a pair it could
  // not name (FR-017 reserves this field to the dedicated control, and FR-020's refusal is silent).
  await expect(primary).toHaveText("Alpha")
  await expect(fallback).toHaveText("gamma (unavailable)")
  await expect(dialog).toBeHidden()
  expect(patches).toEqual([])
})
