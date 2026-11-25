import { expect, test, type Page } from "@playwright/test"
import { fixture, installStressSessionTabs } from "../utils/session-fixture"
import { sessionHref } from "../utils/app"
import { openWithDirection } from "../utils/direction"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

for (const direction of ["ltr", "rtl"] as const) {
  for (const paid of [true, false]) {
    test(`mobile model and variant pickers use drawers with ${paid ? "paid" : "free"} models in ${direction}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await openPickerSession(page, direction, paid)
      const composer = page.locator('[data-component="composer"]')
      const variant = composer.getByRole("button", { name: "Choose model variant", exact: true })
      await expect(variant).toHaveText("balanced")
      await variant.click()
      const variants = page.getByRole("dialog", { name: "Choose model variant", exact: true })
      await expect(variants.getByRole("button", { name: "balanced", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      await expect(variants.getByRole("button", { name: "Close", exact: true })).toHaveCount(0)
      await expect(variants).toBeInViewport({ ratio: 1 })
      await expect(variants).not.toHaveAttribute("data-transitioning")
      await variants.screenshot({ path: testInfo.outputPath("variants.png") })
      await page.keyboard.press("Escape")
      await expect(variants).toBeHidden()
      await expect(variant).toBeFocused()
      await variant.click()
      await variants.getByRole("button", { name: "high", exact: true }).click()
      await expect(variants).toBeHidden()
      await expect(variant).toHaveText("high")
      await expect(variant).toBeFocused()

      const model = composer.locator('[data-action="composer-model"]')
      await expect(model).toHaveText("Mobile Model A")
      await expect(model).toHaveAttribute("data-control-type", "drawer")
      await model.click()
      const models = page.getByRole("dialog", { name: "Select model", exact: true })
      const search = models.getByRole("searchbox", { name: "Search models", exact: true })
      await expect(models.locator('[data-slot="model-selector-drawer"]')).toBeFocused()
      await expect(search).not.toBeFocused()
      await expect(models.getByRole("button", { name: /Mobile Model A/ })).toHaveAttribute("aria-pressed", "true")
      await expect(models.getByRole("button", { name: "Close", exact: true })).toHaveCount(0)
      await expect(models).toBeInViewport({ ratio: 1 })
      await expect(models).not.toHaveAttribute("data-transitioning")
      await expect
        .poll(() =>
          models.evaluate((element) => {
            const drawer = element.getBoundingClientRect()
            const search = element.querySelector('[data-component="text-input-v2"]')!.getBoundingClientRect()
            const row = element.querySelector('[data-component="settings-row"]')!.getBoundingClientRect()
            const searchClip = element.querySelector('[data-slot="mobile-panel-content"]')!.getBoundingClientRect()
            const rowClip = element.querySelector(".settings-models")!.getBoundingClientRect()

            return {
              searchStart: Math.round(search.left - drawer.left),
              searchEnd: Math.round(drawer.right - search.right),
              rowStart: Math.round(row.left - drawer.left),
              rowEnd: Math.round(drawer.right - row.right),
              searchClipStart: Math.round(search.left - searchClip.left),
              searchClipEnd: Math.round(searchClip.right - search.right),
              rowClipStart: Math.round(row.left - rowClip.left),
              rowClipEnd: Math.round(rowClip.right - row.right),
            }
          }),
        )
        .toEqual({
          searchStart: 12,
          searchEnd: 12,
          rowStart: 12,
          rowEnd: 12,
          searchClipStart: 12,
          searchClipEnd: 12,
          rowClipStart: 12,
          rowClipEnd: 12,
        })
      await expect(models.getByRole("button", { name: /Mobile Model A/ })).toHaveCSS("padding-inline-start", "12px")
      await expect(models.getByRole("button", { name: /Mobile Model A/ })).toHaveCSS("padding-block-start", "16px")
      await models.screenshot({ path: testInfo.outputPath("models.png") })
      await search.click()
      await expect(search).toBeFocused()
      await search.fill("no-matching-model")
      await expect(models.getByText("No model results", { exact: true })).toBeVisible()
      await search.fill("Mobile Model B")
      await expect(models.getByRole("button", { name: /Mobile Model A/ })).toHaveCount(0)
      await search.press("Enter")
      await expect(models).toBeHidden()
      await expect(model).toHaveText("Mobile Model B")
      await expect(composer.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused()

      await model.click()
      await expect(search).toHaveValue("")
      await expect(models.locator('[data-slot="model-selector-drawer"]')).toBeFocused()
      await expect(models.getByRole("button", { name: /Mobile Model B/ })).toHaveAttribute("aria-pressed", "true")
      await expect
        .poll(() => models.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42))
        .toBe(0)
      await expect(models).not.toHaveAttribute("data-transitioning")
      await page.locator('[data-slot="mobile-drawer-overlay"]').click({ position: { x: 10, y: 10 } })
      await expect(models).toBeHidden()
      await expect(model).toBeFocused()

      if (paid) {
        await model.click()
        await models.getByRole("button", { name: "Manage models", exact: true }).click()
        await expect(models).toBeHidden()
        await expect(page.getByRole("dialog", { name: "Manage models", exact: true })).toBeVisible()
        await expect(page.getByRole("dialog")).toHaveCount(1)

        return
      }

      await model.click()
      await models.getByRole("button", { name: "Connect an integration", exact: true }).click()
      await expect(models).toBeHidden()
      const providers = page.getByRole("dialog", { name: "Integrations", exact: true })
      await expect(providers.getByRole("searchbox", { name: "Search providers", exact: true })).toBeFocused()
      await expect(page.getByRole("dialog")).toHaveCount(1)
    })

  }

  // FR-023 read with FR-003 at phone width, for the pair a phone user has configured: the fallback slot's own
  // variant control opens a drawer of its own rather than a desktop popover, each drawer belongs to its slot, both
  // model controls keep the drawer that offers the OTHER slot's model, and no dismissal leaves an overlay or a
  // pointer-dead page behind. The drawer's direction-specific parts (`dir`, its inline padding) are re-read here
  // because this is the added control's first phone case.
  test(`the fallback pair opens its own drawers in ${direction}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openPickerSession(page, direction, true, "opencode/mobile-b#high")

    const composer = page.locator('[data-component="composer"]')
    const prompt = composer.getByRole("textbox", { name: "Prompt", exact: true })
    const primaryModel = composer.locator('[data-action="composer-model"]')
    const primaryVariant = composer.getByRole("button", { name: "Choose model variant", exact: true })
    const fallbackModel = composer.locator('[data-action="composer-fallback-model"]')
    const fallbackVariant = composer.getByRole("button", { name: "Choose fallback model variant", exact: true })

    // The row states the whole pair without opening anything, and the variant beside the fallback chip is the value
    // recorded for THAT model (`high`), not this composer's own (`balanced`), which is what keeps the two variant
    // controls from reading as one.
    await expect(primaryModel).toHaveText("Mobile Model A")
    await expect(fallbackModel).toHaveText("Mobile Model B")
    await expect(primaryVariant).toHaveText("balanced")
    await expect(fallbackVariant).toHaveText("high")
    await expect(fallbackModel).toHaveAttribute("data-control-type", "drawer")

    // 1. The added control opens as a bottom drawer, and there is no menu or popover to open instead.
    await fallbackVariant.click()
    const variants = page.getByRole("dialog", { name: "Choose fallback model variant", exact: true })
    await expect(variants).toBeVisible()
    await expect(variants).toBeInViewport({ ratio: 1 })
    await expect(variants).not.toHaveAttribute("data-transitioning")
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(page.getByRole("menuitemradio")).toHaveCount(0)

    // The drawer is the app's bottom drawer: its content element carries this direction, and its rows keep the same
    // inset on both inline edges (12px drawer padding plus the 1px row-list border), so a mirrored drawer holds its
    // rows the same way instead of pushing them past the drawer's edge.
    const insets = await variants.evaluate((element) => {
      const content = element.closest('[data-slot="mobile-drawer-content"]')

      if (!content) throw new Error("The variant drawer is not inside a mobile drawer")

      const drawer = content.getBoundingClientRect()
      const row = element.querySelector('[aria-pressed="true"]')!.getBoundingClientRect()

      return {
        dir: content.getAttribute("dir"),
        rowStart: Math.round(row.left - drawer.left),
        rowEnd: Math.round(drawer.right - row.right),
      }
    })

    expect(insets).toEqual({ dir: direction, rowStart: 13, rowEnd: 13 })

    // The drawer offers this slot's own model's variants, with the recorded one pressed - not the primary slot's
    // choice. Its rows keep the drawer's inline padding on this direction's start edge, so labels sit at the right
    // edge and nothing overhangs.
    await expect(variants.getByRole("button", { name: "high", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(variants.getByRole("button", { name: "max", exact: true })).toHaveAttribute("aria-pressed", "false")
    await expect(variants.getByRole("button", { name: "balanced", exact: true })).toHaveCount(1)
    await expect(variants.getByRole("button", { name: "max", exact: true })).toHaveCSS("padding-inline-start", "12px")

    // 2. Choosing a variant there writes the config field for the fallback half only, in one request, and the drawer
    // closes back onto the control that opened it.
    const written = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/experimental/config",
    )

    await variants.getByRole("button", { name: "max", exact: true }).click()
    await expect(variants).toBeHidden()
    expect(JSON.parse((await written).postData()!)).toEqual({
      fallback: { providerID: "opencode", model: "mobile-b", variant: "max" },
    })
    await expect(fallbackVariant).toHaveText("max")
    await expect(fallbackVariant).toBeFocused()
    // The other three controls named what they named before: a variant write belongs to one slot.
    await expect(primaryVariant).toHaveText("balanced")
    await expect(primaryModel).toHaveText("Mobile Model A")
    await expect(fallbackModel).toHaveText("Mobile Model B")

    // 3. The primary slot's variant control opens a separate drawer, and the fallback's drawer is gone: two
    // controls, two values, each with its own pressed row.
    await primaryVariant.click()
    const primaryVariants = page.getByRole("dialog", { name: "Choose model variant", exact: true })
    await expect(primaryVariants).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole("dialog", { name: "Choose fallback model variant", exact: true })).toHaveCount(0)
    await expect(primaryVariants.getByRole("button", { name: "balanced", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(primaryVariants.getByRole("button", { name: "max", exact: true })).toHaveAttribute("aria-pressed", "false")
    await page.keyboard.press("Escape")
    await expect(primaryVariants).toBeHidden()
    await expect(primaryVariant).toBeFocused()
    await expect(primaryVariant).toHaveText("balanced")
    await expect(fallbackVariant).toHaveText("max")

    // The drawers stay force-mounted for their exit transition, so the phone contract is that they are closed rather
    // than gone: no dialog role is left, no drawer content or overlay sits open where it could catch a pointer, and the
    // draft answers pointers again.
    const expectClosedDrawers = async () => {
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.locator('[data-slot="mobile-drawer-content"]:not([data-closed])')).toHaveCount(0)
      await expect(page.locator('[data-slot="mobile-drawer-overlay"]:not([data-closed])')).toHaveCount(0)
      await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none")
      await expect(prompt).toBeEditable()
    }

    // Nothing survives the closed drawers.
    await expectClosedDrawers()

    // 4. Both model controls open the existing model drawer, and each offers the other slot's model as an ordinary
    // row, which is how a phone user exchanges the pair in one action (FR-024/FR-033 read with FR-023).
    await primaryModel.click()
    const models = page.getByRole("dialog", { name: "Select model", exact: true })
    await expect(models.locator('[data-slot="model-selector-drawer"]')).toBeFocused()
    await expect(models.getByRole("button", { name: /Mobile Model A/ })).toHaveAttribute("aria-pressed", "true")
    await expect(models.locator('[data-option-key="opencode:mobile-b"]')).toBeVisible()
    await page.locator('[data-slot="mobile-drawer-overlay"]').click({ position: { x: 10, y: 10 } })
    await expect(models).toBeHidden()
    await expect(primaryModel).toBeFocused()

    await fallbackModel.click()
    const fallbackModels = page.getByRole("dialog", { name: "Select model", exact: true })
    await expect(fallbackModels.locator('[data-slot="model-selector-drawer"]')).toBeFocused()
    await expect(fallbackModels.locator('[data-option-key="opencode:mobile-b"]')).toHaveAttribute("aria-pressed", "true")
    await expect(fallbackModels.locator('[data-option-key="opencode:mobile-a"]')).toBeVisible()
    // Dismissing the fallback's drawer by its overlay restores its own chip, and looking at the pair changes nothing
    // in it.
    await page.locator('[data-slot="mobile-drawer-overlay"]').click({ position: { x: 10, y: 10 } })
    await expect(fallbackModels).toBeHidden()
    await expect(fallbackModel).toBeFocused()
    await expectClosedDrawers()
    await expect(fallbackModel).toHaveText("Mobile Model B")
    await expect(fallbackVariant).toHaveText("max")
  })

  test(`desktop model button opens the model dialog in ${direction}`, async ({ page }) => {
    const { composer, model, variant, dialog } = await openDesktopPicker(page, direction)
    await variant.click()
    await page.getByRole("menuitemradio", { name: "high", exact: true }).click()
    await expect(variant).toHaveText("high")
    await expect(model).toHaveAttribute("data-control-type", "dialog")
    await model.click()
    await expect(dialog.getByRole("combobox", { name: "Search models", exact: true })).toBeFocused()
    await expect(page.getByRole("menu")).toHaveCount(0)
    await dialog.locator('[data-option-key="opencode:mobile-b"]').click()
    await expect(dialog).toBeHidden()
    await expect(model).toHaveText("Mobile Model B")
    await expect(page.locator('[data-slot="mobile-drawer-content"]')).toHaveCount(0)
    await expect(composer.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused()
  })

  test(`model dialog flyout applies a model and variant in ${direction}`, async ({ page }) => {
    const { model, variant, dialog } = await openDesktopPicker(page, direction)
    const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
    await model.click()
    await dialog.locator('[data-option-key="opencode:mobile-a"]').hover()
    await expect(flyout.getByRole("menuitemradio", { name: "balanced", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await dialog.locator('[data-option-key="opencode:mobile-b"]').hover()
    await expect(flyout.getByText("OpenCode · 1M context", { exact: true })).toBeVisible()
    await expect(flyout.getByText("Text, Image, PDF, Tools", { exact: true })).toBeVisible()
    await flyout.getByRole("menuitemradio", { name: "max", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(model).toHaveText("Mobile Model B")
    await expect(variant).toHaveText("max")
  })

  test(`model dialog arrow keys choose a variant in the flyout in ${direction}`, async ({ page }) => {
    const { composer, model, variant, dialog } = await openDesktopPicker(page, direction)
    const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
    const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
    const balanced = flyout.getByRole("menuitemradio", { name: "balanced", exact: true })
    const high = flyout.getByRole("menuitemradio", { name: "high", exact: true })
    const next = direction === "rtl" ? "ArrowLeft" : "ArrowRight"
    await model.click()
    await expect(search).toBeFocused()
    // The highlighted row's flyout opens with the dialog, and the forward arrow enters it on the current variant.
    await expect(balanced).toBeVisible()
    await search.press(next)
    await expect(balanced).toHaveAttribute("data-highlighted", "")
    await search.press("ArrowDown")
    await expect(high).toHaveAttribute("data-highlighted", "")
    // Escape leaves the menu first, then closes the dialog.
    await search.press("Escape")
    await expect(high).not.toHaveAttribute("data-highlighted")
    await expect(dialog).toBeVisible()
    await search.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(variant).toHaveText("balanced")

    await model.click()
    await search.fill("Mobile Model A")
    // While searching, the forward arrow edits the query until the arrows have moved through the results.
    await search.press(next)
    await expect(search).toHaveValue("Mobile Model A")
    await expect(balanced).not.toHaveAttribute("data-highlighted")
    await search.press("ArrowDown")
    await search.press("ArrowUp")
    await search.press(next)
    await expect(balanced).toHaveAttribute("data-highlighted", "")
    await search.press("ArrowDown")
    await search.press("Enter")
    await expect(dialog).toBeHidden()
    await expect(model).toHaveText("Mobile Model A")
    await expect(variant).toHaveText("high")
    await expect(composer.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused()
  })

  test(`model shortcut opens the model dialog in ${direction}`, async ({ page }) => {
    const { composer, model, variant, dialog } = await openDesktopPicker(page, direction)
    const prompt = composer.getByRole("textbox", { name: "Prompt", exact: true })
    await prompt.fill("keep me")
    await prompt.press("ControlOrMeta+Quote")
    const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
    const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
    await expect(search).toBeFocused()
    await search.press(direction === "rtl" ? "ArrowLeft" : "ArrowRight")
    await expect(flyout.getByRole("menuitemradio", { name: "balanced", exact: true })).toHaveAttribute(
      "data-highlighted",
      "",
    )
    await search.press("ArrowDown")
    await search.press("Enter")
    await expect(dialog).toBeHidden()
    await expect(model).toHaveText("Mobile Model A")
    await expect(variant).toHaveText("high")
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveText("keep me")
  })
}

test("desktop model button shows only the choose-model hint, not the model details", async ({ page }) => {
  const { model } = await openDesktopPicker(page, "ltr")
  await model.hover()
  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toContainText("Choose model")
  await expect(tooltip.getByText("1,000,000", { exact: true })).toHaveCount(0)
  await expect(tooltip.getByText("Input & Output", { exact: true })).toHaveCount(0)
})

test("model dialog flyout follows the arrow keys, waits while one is held, and cools down after it closes", async ({
  page,
}) => {
  const { model, dialog } = await openDesktopPicker(page, "ltr")
  const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  const rowA = dialog.locator('[data-option-key="opencode:mobile-a"]')
  const rowB = dialog.locator('[data-option-key="opencode:mobile-b"]')
  const rowC = dialog.locator('[data-option-key="opencode:mobile-c"]')
  await model.click()
  await expect(search).toBeFocused()
  await expect(flyout.getByRole("menuitemradio", { name: "balanced", exact: true })).toBeVisible()
  // See "tab preview opens cold" in tabs.spec.ts: pause at a fixed offset from an explicit install time.
  const start = Date.now()
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start + 10_000)

  // A single press moves the flyout at once.
  await page.keyboard.down("ArrowDown")
  await expect(rowB).toHaveAttribute("data-active", "")
  await expect(flyout.getByRole("menuitemradio", { name: "max", exact: true })).toBeVisible()

  // A held key repeats: the flyout hides until the highlight rests.
  await page.keyboard.down("ArrowDown")
  await page.keyboard.up("ArrowDown")
  await expect(rowC).toHaveAttribute("data-active", "")
  await expect(flyout).toHaveCount(0)
  await page.clock.runFor(200)
  await expect(flyout.getByText("OpenCode · 262K context", { exact: true })).toBeVisible()

  // The pointer takes the flyout over at once.
  await rowB.hover()
  await expect(flyout.getByRole("menuitemradio", { name: "max", exact: true })).toBeVisible()

  // Once the flyout has been closed for a moment, the next row waits for the open delay again.
  await page.mouse.move(5, 5)
  await expect(flyout).toHaveCount(0)
  await page.clock.runFor(400)
  await rowA.hover()
  await expect(rowA).toHaveAttribute("data-active", "")
  await expect(flyout).toHaveCount(0)
  await page.clock.runFor(200)
  await expect(flyout.getByRole("menuitemradio", { name: "balanced", exact: true })).toBeVisible()
})

test("model dialog shows a summary and only the default variant for models without variants", async ({ page }) => {
  const { model, dialog } = await openDesktopPicker(page, "ltr")
  const flyout = dialog.locator('[data-slot="model-dialog-flyout"]')
  await model.click()
  await dialog.locator('[data-option-key="opencode:mobile-c"]').hover()
  await expect(flyout.getByText("OpenCode · 262K context", { exact: true })).toBeVisible()
  await expect(flyout.getByRole("menuitemradio")).toHaveText(["Default"])
})

test("model dialog toggles a favorite from the keyboard and leads with favorite and recent models", async ({
  page,
}) => {
  const { model, dialog } = await openDesktopPicker(page, "ltr")
  const sections = dialog.locator('[data-slot="search-list-header"]')
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  await model.click()
  await expect(sections).toHaveText(["OpenCode"])
  await search.press("ArrowDown")
  await search.press("ArrowDown")
  await search.press("ControlOrMeta+f")
  await expect(sections).toHaveText(["Favorites", "OpenCode"])
  // A favorite leaves its provider group, so the model is listed once.
  await expect(dialog.locator('[data-option-key="opencode:mobile-c"]')).toHaveCount(1)
  await dialog.locator('[data-option-key="opencode:mobile-b"]').click()
  await expect(model).toHaveText("Mobile Model B")

  await model.click()
  await expect(sections).toHaveText(["Favorites", "Recent", "OpenCode"])
  await expect(dialog.locator('[data-option-key="opencode:mobile-b"]')).toHaveAttribute("aria-current", "true")
  await search.fill("Mobile")
  await expect(sections).toHaveText(["OpenCode"])
  await search.press("Escape")
  await expect(dialog).toBeHidden()
  // The dialog opens on its first row with the search focused, not on the selected model further down.
  await model.click()
  await expect(search).toBeFocused()
  await expect(dialog.locator('[data-option-key="opencode:mobile-c"]')).toHaveAttribute("data-active", "")
  await expect(dialog.locator('[data-option-key="opencode:mobile-b"]')).not.toHaveAttribute("data-active")
  await search.press("ControlOrMeta+f")
  await expect(sections).toHaveText(["Recent", "OpenCode"])
  await expect(dialog.locator('[data-option-key="opencode:mobile-c"]')).toHaveAttribute("data-active", "")
})

test("model dialog opens Manage models from its search row with Enter", async ({ page }) => {
  const { model, dialog } = await openDesktopPicker(page, "ltr")
  await model.click()
  const search = dialog.getByRole("combobox", { name: "Search models", exact: true })
  const manage = dialog.getByRole("button", { name: "Manage models", exact: true })
  await expect(search).toBeFocused()
  await search.press("Tab")
  await expect(dialog.getByRole("button", { name: "Connect an integration", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(manage).toBeFocused()
  await manage.press("Enter")
  await expect(page.getByRole("dialog", { name: "Manage models", exact: true })).toBeVisible()
  await expect(model).toHaveText("Mobile Model A")
})

test.describe("touch composer pickers", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("model and default variant open with one tap", async ({ page }) => {
    await openPickerSession(page, "ltr", true)
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true)
    const composer = page.locator('[data-component="composer"]')
    const variant = composer.getByRole("button", { name: "Choose model variant", exact: true })
    await variant.tap()
    const variants = page.getByRole("dialog", { name: "Choose model variant", exact: true })
    await variants.getByRole("button", { name: "default", exact: true }).tap()
    await expect(variants).toBeHidden()
    await expect(variant).toHaveText("default")
    await page.touchscreen.tap(5, 300)
    await expect(variant).toHaveCSS("pointer-events", "auto")
    await expect(variant).toHaveCSS("opacity", "1")
    await variant.tap()
    await expect(variants).toBeVisible()
    await expect
      .poll(() => variants.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42))
      .toBe(0)
    await page.locator('[data-slot="mobile-drawer-overlay"]').tap({ position: { x: 10, y: 10 } })
    await expect(variants).toBeHidden()

    await composer.locator('[data-action="composer-model"]').tap()
    const models = page.getByRole("dialog", { name: "Select model", exact: true })
    await expect(models.locator('[data-slot="model-selector-drawer"]')).toBeFocused()
    const search = models.getByRole("searchbox", { name: "Search models", exact: true })
    await expect(search).not.toBeFocused()
    await search.tap()
    await expect(search).toBeFocused()
  })

  // FR-012/FR-013 on the phone: the drawer the fallback chip opens leads with its "None" action row, and the drawer's
  // OWN list still carries the other slot's model as a row - both are the picker's business, so the drawer has to pass
  // them on rather than rebuild the list without them. The action writes the config field and closes the drawer.
  test("the fallback drawer offers its None row and the other slot's model", async ({ page }) => {
    await openPickerSession(page, "ltr", true)
    const composer = page.locator('[data-component="composer"]')
    const model = composer.locator('[data-action="composer-model"]')
    const chip = composer.locator('[data-action="composer-fallback-model"]')

    // The session names `Mobile Model A`, and no config document names a fallback, so the shipped default is the
    // effective one: an enabled fallback the catalog has no model for, which leaves that slot no variant control.
    await expect(model).toHaveText("Mobile Model A")
    await expect(chip).toHaveText("qwen3.8-27b (unavailable)")

    const patches: string[] = []
    const written = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/experimental/config")
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/experimental/config") patches.push(request.method())
    })

    await chip.tap()
    const models = page.getByRole("dialog", { name: "Select model", exact: true })
    const none = models.locator('[data-option-key="none"]')
    await expect(none).toBeVisible()
    await expect(none.locator('[data-slot="settings-row-title"]')).toHaveText("None")
    // A fallback is in effect, so the row is not yet the current entry, and the other slot's model is still a row here.
    await expect(none).toHaveAttribute("aria-pressed", "false")
    await expect(models.locator('[data-option-key="opencode:mobile-a"]')).toBeVisible()

    await none.tap()
    await expect(models).toBeHidden()
    expect(JSON.parse((await written).postData()!)).toEqual({ fallback: null })
    await expect(model).toHaveText("Mobile Model A")
    await expect(chip).toHaveText("None")
    expect(patches).toEqual(["PATCH"])
  })
})

async function openDesktopPicker(page: Page, direction: "ltr" | "rtl") {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openPickerSession(page, direction, true)
  const composer = page.locator('[data-component="composer"]')

  return {
    composer,
    model: composer.locator('[data-action="composer-model"]'),
    variant: composer.getByRole("button", { name: "Choose model variant", exact: true }),
    dialog: page.getByRole("dialog", { name: "Select model", exact: true }),
  }
}

// The config document the mock answers through `GET /api/config`, spelled as `e2e/regression/composer.spec.ts` does,
// so the app's own config reader (`runtime/server/sync.tsx`) resolves the fallback the pair cases stage.
const configPath = "/home/test/.config/opencode/opencode.jsonc"

async function openPickerSession(
  page: Page,
  direction: "ltr" | "rtl",
  paid: boolean,
  fallback?: string,
) {
  // A configured fallback the catalog can name, so the phone row carries the fallback slot's own variant control
  // (FR-003 read with FR-023). Only the pair cases pass this, and the other cases keep the shipped default fallback
  // whose model the catalog cannot name.
  const fallbackConfig = fallback
    ? { configEntries: [{ type: "document", path: configPath, info: { fallback } }] }
    : {}

  await mockOpenCodeServer(page, {
    ...fixture,
    ...fallbackConfig,
    sessions: fixture.sessions.map((session) => ({
      ...session,
      model: { id: "mobile-a", providerID: "opencode", variant: "balanced" },
    })),
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: Object.fromEntries(
            ["a", "b", "c"].map((id) => [
              `mobile-${id}`,
              {
                id: `mobile-${id}`,
                name: `Mobile Model ${id.toUpperCase()}`,
                cost: { input: paid ? 1 : 0, output: paid ? 1 : 0 },
                limit: { context: id === "c" ? 262_144 : 1_000_000 },
                capabilities: {
                  tools: id !== "c",
                  input: id === "c" ? ["text"] : ["text", "image", "pdf"],
                  output: ["text"],
                },
                variants: id === "c" ? {} : { balanced: {}, high: {}, max: {} },
              },
            ]),
          ),
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "mobile-a" },
    },
    pageMessages: () => ({ items: [] }),
  })
  await installStressSessionTabs(page)
  await page.addInitScript((direction) => {
    localStorage.setItem("opencode-color-scheme", direction === "rtl" ? "dark" : "light")
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        user: ["a", "b", "c"].map((id) => ({ providerID: "opencode", modelID: `mobile-${id}`, visibility: "show" })),
        recent: [],
        variant: {},
      }),
    )
  }, direction)
  await openWithDirection(page, sessionHref(fixture.targetID), direction)
  await expectAppVisible(page.getByRole("textbox", { name: "Prompt", exact: true }))
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
}
