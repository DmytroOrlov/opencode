import { describe, expect, test } from "bun:test"
import { resolveSessionComposerSelection, swapModelPair } from "./selection"
import { fallbackUpdateState } from "../../providers/models/fallback-update"

describe("resolveSessionComposerSelection", () => {
  test("prefers durable Session state over historical message metadata", () => {
    expect(
      resolveSessionComposerSelection(
        { agent: "build", model: { id: "claude", providerID: "anthropic" } },
        { agent: "review", model: { modelID: "gpt", providerID: "openai" } },
      ),
    ).toEqual({
      agent: "build",
      model: { modelID: "claude", providerID: "anthropic", variant: undefined },
    })
  })

  test("falls back to historical metadata while durable state is unavailable", () => {
    expect(
      resolveSessionComposerSelection(undefined, {
        agent: "review",
        model: { modelID: "gpt", providerID: "openai", variant: "high" },
      }),
    ).toEqual({
      agent: "review",
      model: { modelID: "gpt", providerID: "openai", variant: "high" },
    })
  })
})

describe("swapModelPair", () => {
  test("swaps supported model variants symmetrically", () => {
    expect(
      swapModelPair({
        primary: { model: { providerID: "p1", modelID: "m1" }, variant: "high" },
        fallback: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
        primaryVariants: ["high"],
        fallbackVariants: ["fast"],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
      fallback: { model: { providerID: "p1", modelID: "m1" }, variant: "high" },
    })
  })

  test("clears variants unsupported by the destination and clears fallback without a primary", () => {
    expect(
      swapModelPair({
        fallback: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
        primaryVariants: [],
        fallbackVariants: [],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: undefined },
      fallback: null,
    })
  })

  test("keeps provider-default variants unset when swapping models", () => {
    expect(
      swapModelPair({
        primary: { model: { providerID: "p1", modelID: "m1" } },
        fallback: { model: { providerID: "p2", modelID: "m2" } },
        primaryVariants: ["high"],
        fallbackVariants: ["fast"],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: undefined },
      fallback: { model: { providerID: "p1", modelID: "m1" }, variant: undefined },
    })
  })

  test("does nothing when no fallback is selected", () => {
    expect(swapModelPair({ primaryVariants: [], fallbackVariants: [] })).toBeUndefined()
  })
})

describe("fallback update ordering", () => {
  test("a delayed older rejection from another composer cannot roll back newer client intent", async () => {
    const requests: { resolve: () => void; reject: (error: Error) => void }[] = []
    const writes: string[] = []
    const failures: unknown[] = []
    const key = {}
    const write = (value: string) => {
      writes.push(value)
      return new Promise<void>((resolve, reject) => requests.push({ resolve, reject }))
    }
    const firstComposer = fallbackUpdateState(key, write)
    const secondComposer = fallbackUpdateState(key, write)
    const failed = (error: unknown) => failures.push(error)

    firstComposer.save("older", failed)
    secondComposer.save("newer", failed)
    expect(firstComposer.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests[0]!.reject(new Error("older update failed"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toEqual(["older", "newer"])
    expect(secondComposer.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    expect(failures).toEqual([])

    requests[1]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(firstComposer.optimistic()).toBeUndefined()
  })

  test("an older success does not clear a newer composer selection", async () => {
    const requests: { resolve: () => void; reject: (error: Error) => void }[] = []
    const key = {}
    const state = fallbackUpdateState(key, (value: string) => new Promise<void>((resolve, reject) => requests.push({ resolve, reject })))
    state.save("older", () => {})
    state.save("newer", () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests[0]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    requests[1]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.optimistic()).toBeUndefined()
  })
})
