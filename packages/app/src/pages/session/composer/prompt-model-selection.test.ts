import { describe, expect, test } from "bun:test"
import { computeModelPairSwap, carriedModelVariant } from "./prompt-model-selection"

const model = (providerID: string, modelID: string) => ({ providerID, modelID })

describe("composer model-pair controller transitions", () => {
  test("swaps primary to fallback and back symmetrically", () => {
    const first = computeModelPairSwap({
      primary: model("primary", "one"),
      primaryVariants: { low: {}, high: {} },
      primaryVariant: "high",
      fallback: { model: "fallback/two", variant: "low" },
      fallbackModel: model("fallback", "two"),
      fallbackVariants: { low: {}, high: {} },
    })
    expect(first).toEqual({
      primary: model("fallback", "two"),
      fallback: { model: "primary/one", variant: "high" },
      primaryVariant: "low",
    })

    const second = computeModelPairSwap({
      primary: first.primary,
      primaryVariants: { low: {}, high: {} },
      primaryVariant: first.primaryVariant,
      fallback: first.fallback,
      fallbackModel: model("primary", "one"),
      fallbackVariants: { low: {}, high: {} },
    })
    expect(second).toEqual({
      primary: model("primary", "one"),
      fallback: { model: "fallback/two", variant: "low" },
      primaryVariant: "high",
    })
  })

  test("preserves supported variants and clears unsupported carried variants", () => {
    expect(carriedModelVariant({ variant: "high", variants: { high: {} } })).toBe("high")
    expect(carriedModelVariant({ variant: "high", variants: { low: {} } })).toBeUndefined()
  })
})
