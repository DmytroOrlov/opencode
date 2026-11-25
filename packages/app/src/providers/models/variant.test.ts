import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  DEFAULT_VARIANT,
  durableVariantSelection,
  getConfiguredAgentVariant,
  INHERIT_VARIANT,
  promptVariantValue,
  recordedVariant,
  resolveModelVariant,
  variantSelectionFrom,
} from "./variant"

const variants = ["low", "high", "xhigh"]

const named = (value: string) => ({ type: "named", value }) as const

const selected = { providerID: "openai", modelID: "gpt-5.2" }

// The per-model store, as both selection owners read it.
const store = (values: Record<string, string | undefined>) => ({
  variant: { get: (model: { providerID: string; modelID: string }) => values[`${model.providerID}/${model.modelID}`] },
})

describe("model variant", () => {
  test.each([
    { name: "applies when the model matches", providerID: "openai", modelID: "gpt-5.2", expected: "xhigh" },
    { name: "is ignored for another model", providerID: "anthropic", modelID: "claude-sonnet-4", expected: undefined },
  ])("the configured agent variant $name", ({ providerID, modelID, expected }) => {
    const value = getConfiguredAgentVariant({
      agent: { model: { providerID: "openai", modelID: "gpt-5.2" }, variant: "xhigh" },
      model: { providerID, modelID, variants: { low: {}, high: {}, xhigh: {} } },
    })

    expect(value).toBe(expected)
  })

  test.each([
    { name: "prefers the selected variant over configuration", selected: named("high"), expected: "high" },
    { name: "lets an explicit default override configuration", selected: DEFAULT_VARIANT, expected: undefined },
  ])("resolve $name", ({ selected, expected }) => {
    expect(resolveModelVariant({ variants, selected, configured: "xhigh" })).toBe(expected)
  })

  test.each([
    { name: "a configured variant to the next", selected: INHERIT_VARIANT, configured: "high", expected: "xhigh" },
    {
      name: "the configured last variant to default",
      selected: INHERIT_VARIANT,
      configured: "xhigh",
      expected: undefined,
    },
    {
      name: "an explicit default to the first variant",
      selected: DEFAULT_VARIANT,
      configured: "xhigh",
      expected: "low",
    },
  ])("cycles from $name", ({ selected, configured, expected }) => {
    expect<string | undefined>(cycleModelVariant({ variants, selected, configured })).toBe(expected)
  })

  test("prefers a saved variant to configuration, including explicit Default", () => {
    const input = { variants: ["low", "high"], selected: INHERIT_VARIANT, configured: "high" }
    expect(resolveModelVariant({ ...input, preferred: "low" })).toBe("low")
    expect(resolveModelVariant({ ...input, preferred: "default" })).toBeUndefined()
    expect(resolveModelVariant({ ...input, preferred: "low", selected: DEFAULT_VARIANT })).toBeUndefined()
    expect(resolveModelVariant({ ...input, preferred: "low", selected: named("high") })).toBe("high")
    expect(cycleModelVariant({ ...input, preferred: "high" })).toBeUndefined()
    expect(cycleModelVariant({ ...input, preferred: "default" })).toBe("low")
  })

  test("normalizes unavailable selections instead of silently applying another variant", () => {
    expect(resolveModelVariant({ variants: ["low"], selected: named("high"), configured: "low" })).toBeUndefined()
    expect(
      resolveModelVariant({ variants: ["low"], selected: INHERIT_VARIANT, preferred: "high", configured: "low" }),
    ).toBeUndefined()
    expect(cycleModelVariant({ variants: [], selected: INHERIT_VARIANT, configured: undefined })).toBeUndefined()
  })

  test("reads the prompt mirror's null as the explicit Default and a committed absence as Default too", () => {
    expect(variantSelectionFrom(null)).toEqual(DEFAULT_VARIANT)
    expect(variantSelectionFrom(undefined)).toEqual(INHERIT_VARIANT)
    expect(variantSelectionFrom("high")).toEqual(named("high"))
    expect(durableVariantSelection(undefined)).toEqual(DEFAULT_VARIANT)
    expect(durableVariantSelection("high")).toEqual(named("high"))
  })

  test.each([
    { name: "nothing recorded", values: {}, expected: INHERIT_VARIANT },
    { name: "a recorded variant", values: { "openai/gpt-5.2": "high" }, expected: named("high") },
    { name: "a recorded Default", values: { "openai/gpt-5.2": "default" }, expected: DEFAULT_VARIANT },
  ])("recordedVariant $name", ({ values, expected }) => {
    expect(recordedVariant(store(values), selected)).toEqual(expected)
  })

  test("recordedVariant reads the store for the model being selected, never for another model", () => {
    const values = { "openai/gpt-5.2": "xhigh" }

    expect(recordedVariant(store(values), selected)).toEqual(named("xhigh"))
    expect(recordedVariant(store(values), { providerID: "anthropic", modelID: "claude-sonnet-4" })).toEqual(INHERIT_VARIANT)
    expect(recordedVariant(store(values), { providerID: "openai", modelID: "gpt-5.1" })).toEqual(INHERIT_VARIANT)
  })

  test("a recorded selection resolves the way a committed variant does, ahead of configuration", () => {
    const values = { "openai/gpt-5.2": "high" }

    expect(resolveModelVariant({ variants, selected: recordedVariant(store(values), selected), configured: "xhigh" })).toBe(
      "high",
    )
    // A preference recorded as "default" is the model's own default, so it clears the configured variant.
    expect(
      resolveModelVariant({
        variants,
        selected: recordedVariant(store({ "openai/gpt-5.2": "default" }), selected),
        configured: "xhigh",
      }),
    ).toBeUndefined()
  })

  test("seeds the prompt mirror with the same rule the session owner seeds its choice with", () => {
    expect(promptVariantValue(INHERIT_VARIANT)).toBeUndefined()
    expect(promptVariantValue(DEFAULT_VARIANT)).toBeNull()
    expect(promptVariantValue(named("high"))).toBe("high")
    // The store spells an explicit Default as the name "default"; both owners see it as the Default.
    expect(promptVariantValue(recordedVariant(store({ "openai/gpt-5.2": "default" }), selected))).toBeNull()
    expect(promptVariantValue(recordedVariant(store({ "openai/gpt-5.2": "high" }), selected))).toBe("high")
    expect(promptVariantValue(recordedVariant(store({}), selected))).toBeUndefined()
  })
})
