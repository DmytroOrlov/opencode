import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT } from "./prompt-state"

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })

  test("round-trips absent and explicit raw model variants exactly", () => {
    createRoot((dispose) => {
      const states = [
        undefined,
        { providerID: "anthropic", modelID: "claude" },
        { providerID: "anthropic", modelID: "claude", variant: undefined },
        { providerID: "anthropic", modelID: "claude", variant: null },
        { providerID: "anthropic", modelID: "claude", variant: "high" },
      ] as const

      for (const state of states) {
        const expected = state ? { ...state } : state
        const prompt = createPromptState({ model: state ? { ...state } : undefined })
        const snapshot = prompt.capture().model.snapshot()
        prompt.model.set({ providerID: "later", modelID: "changed", variant: "introduced" })
        snapshot.restore()
        expect(prompt.model.current()).toEqual(expected)
        if (state && Object.hasOwn(state, "variant")) {
          expect(Object.hasOwn(prompt.model.current()!, "variant")).toBe(true)
        }
      }

      dispose()
    })
  })

  test("restores fields introduced after capture and the captured prompt target", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ model: { providerID: "before", modelID: "model", variant: null } })
      const snapshot = prompt.capture().model.snapshot()

      prompt.model.set({ providerID: "after", modelID: "model", variant: "high" })
      snapshot.restore()
      expect(prompt.model.current()).toEqual({ providerID: "before", modelID: "model", variant: null })

      prompt.model.set(undefined)
      snapshot.restore()
      expect(prompt.model.current()).toEqual({ providerID: "before", modelID: "model", variant: null })
      dispose()
    })
  })
})
