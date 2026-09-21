import { describe, expect, test } from "bun:test"
import { localizedListParts, richTemplateParts } from "./language"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"

describe("rich translations", () => {
  test("lets the translated phrase position a rich slot", () => {
    const names = { type: "names" }
    expect(richTemplateParts("Written by {{names}}", { names })).toEqual(["Written by ", names])
    expect(richTemplateParts("{{names}} tarafından yazıldı", { names })).toEqual([names, " tarafından yazıldı"])
  })

  test("keeps list elements intact while localizing punctuation", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(localizedListParts("en", items).filter((part) => typeof part !== "string")).toEqual(items)
  })
})

describe("fallback localization", () => {
  test("includes the fallback status key in every supported app locale", async () => {
    await Promise.all(
      DESKTOP_NATIVE_LOCALES.map(async (locale) => {
        const source = await Bun.file(new URL(`./${locale}.ts`, import.meta.url)).text()
        expect(source, locale).toContain('"ui.sessionTurn.status.fallback"')
      }),
    )
  })
})
