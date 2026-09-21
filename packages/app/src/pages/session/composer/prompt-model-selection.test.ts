import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ModelSelection } from "@/context/local"
import type { ModelPairController } from "./prompt-model-selection"
import { computeModelPairSwap, carriedModelVariant, createModelPairController } from "./prompt-model-selection"

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

type FallbackConfig = { model: string; variant: string | null }
type PairModelItem = ReturnType<ModelPairController["primaryModels"]>[number]

const modelItem = (id: string) =>
  ({
    id,
    name: id,
    provider: { id: "provider", name: "provider" },
    variants: { high: {}, low: {} },
  }) as unknown as PairModelItem

const catalog = [modelItem("primary"), modelItem("fallback"), modelItem("other"), modelItem("late")]
const primaryItem = catalog[0]
const fallbackItem = catalog[1]
const otherItem = catalog[2]
const lateItem = catalog[3]

const models = {
  list: () => catalog,
  find: (key: { providerID: string; modelID: string }) =>
    catalog.find((item) => item.provider.id === key.providerID && item.id === key.modelID),
  visible: () => true,
}

const createServerSyncFake = (fallback: FallbackConfig | null) => {
  const state = {
    fallback: fallback as FallbackConfig | null,
    session_status: {} as Record<string, { type: string }>,
    sets: [] as [string, string, FallbackConfig | null][],
    updates: [] as { fallback: FallbackConfig | null }[],
    holdUpdates: false,
    failUpdates: false,
    abortRejections: 0,
    pending: [] as { config: { fallback: FallbackConfig | null }; resolve: () => void }[],
  }
  return {
    state,
    data: {
      config: {
        get fallback() {
          return state.fallback
        },
      },
    },
    set: (scope: string, key: string, value: FallbackConfig | null) => {
      state.sets.push([scope, key, value])
      state.fallback = value
    },
    updateConfig: (config: { fallback: FallbackConfig | null }, options?: { signal?: AbortSignal }) => {
      state.updates.push(config)
      if (state.failUpdates) return Promise.reject(new Error("genuine persistence failure"))
      if (!state.holdUpdates) {
        state.fallback = config.fallback
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        state.pending.push({
          config,
          resolve: () => {
            state.fallback = config.fallback
            resolve()
          },
        })
        const signal = options?.signal
        if (!signal) return
        const onAbort = () => {
          state.abortRejections += 1
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    session: {
      data: {
        get session_status() {
          return state.session_status
        },
        session_working(id: string) {
          return (state.session_status[id]?.type ?? "idle") !== "idle"
        },
      },
    },
  }
}

const waitFor = async (check: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Promise.resolve()
  if (!check()) throw new Error(message)
}

let activeServer = createServerSyncFake(null)

mock.module("@/context/models", () => ({ useModels: () => models }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => activeServer }))

const createSelectionFake = () => {
  const state = {
    current: primaryItem as PairModelItem | undefined,
    variant: "high" as string | undefined,
    applied: [] as unknown[],
    committed: [] as unknown[],
    restores: [] as string[],
  }
  const selection = {
    ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
    current: () => state.current,
    recent: () => [],
    list: () => catalog,
    cycle: () => {},
    apply: async (item: unknown) => {
      state.applied.push(item)
    },
    commit: (item: unknown) => {
      state.committed.push(item)
    },
    set: () => {},
    visible: () => true,
    setVisibility: () => {},
    variant: {
      configured: () => undefined,
      selected: () => state.variant,
      current: () => state.variant,
      list: () => ["high", "low"],
      apply: async (value?: string) => {
        state.variant = value
      },
      commit: (_model: unknown, value?: string) => {
        state.variant = value
      },
      set: () => {},
      cycle: () => {},
    },
    snapshot: () => ({
      restore: () => {
        state.restores.push("restore")
      },
    }),
    state,
  }
  return selection
}

const setup = (fallback: FallbackConfig | null = null) => {
  activeServer = createServerSyncFake(fallback)
  const selection = createSelectionFake()
  const errors: unknown[] = []
  const created = createRoot((dispose) => {
    const pair = createModelPairController({
      selection: selection as unknown as ModelSelection,
      onError: (error) => errors.push(error),
    })
    return { pair, dispose }
  })
  return { server: activeServer, selection, errors, ...created }
}

const working = (server: ReturnType<typeof createServerSyncFake>, sessionID: string) => {
  server.state.session_status = { [sessionID]: { type: "busy" } }
}

describe("composer model-pair fallback persistence", () => {
  test("submits a fallback selection and updates config optimistically while the current session is working", async () => {
    const { server, errors, pair, dispose } = setup()
    working(server, "ses_current")
    let finishUpdate!: () => void
    const pendingUpdate = new Promise<void>((resolve) => {
      finishUpdate = resolve
    })
    server.updateConfig = async (config) => {
      server.state.updates.push(config)
      await pendingUpdate
    }

    const operation = pair.selectFallback(fallbackItem)
    for (let attempt = 0; attempt < 10 && server.state.updates.length === 0; attempt++) await Promise.resolve()

    const requested = { model: "provider/fallback", variant: null }
    expect(server.data.config.fallback).toEqual(requested)
    expect(server.state.sets).toEqual([["config", "fallback", requested]])
    expect(server.state.updates).toEqual([{ fallback: requested }])
    finishUpdate()
    await operation
    expect(errors).toEqual([])
    dispose()
  })

  test("submits fallback model and variant changes while a different session is working", async () => {
    const initial: FallbackConfig = { model: "provider/fallback", variant: "low" }
    const { server, errors, pair, dispose } = setup(initial)
    working(server, "ses_other")

    await pair.selectFallback(fallbackItem)
    await pair.selectFallbackVariant("high")

    const modelSelection = initial
    const variantSelection = { model: "provider/fallback", variant: "high" }
    expect(server.state.sets).toEqual([
      ["config", "fallback", modelSelection],
      ["config", "fallback", variantSelection],
    ])
    expect(server.state.updates).toEqual([{ fallback: modelSelection }, { fallback: variantSelection }])
    expect(server.data.config.fallback).toEqual(variantSelection)
    expect(errors).toEqual([])
    dispose()
  })

  test("executes a pair swap atomically while a session is working", async () => {
    const initial: FallbackConfig = { model: "provider/fallback", variant: "low" }
    const { server, selection, errors, pair, dispose } = setup(initial)
    working(server, "ses_other")

    await pair.swap()

    const nextFallback = { model: "provider/primary", variant: "high" }
    expect(server.state.sets).toEqual([["config", "fallback", nextFallback]])
    expect(server.state.updates).toEqual([{ fallback: nextFallback }])
    expect(selection.state.applied).toEqual([{ providerID: "provider", modelID: "fallback" }])
    expect(selection.state.committed).toHaveLength(1)
    expect(server.data.config.fallback).toEqual(nextFallback)
    expect(errors).toEqual([])
    dispose()
  })

  test("persists fallback clearing together with a colliding primary change while a session is working", async () => {
    const initial: FallbackConfig = { model: "provider/ghost", variant: null }
    const { server, selection, errors, pair, dispose } = setup(initial)
    working(server, "ses_current")

    const nextPrimary = modelItem("ghost")
    await pair.selectPrimary(nextPrimary)

    expect(server.state.sets).toEqual([["config", "fallback", null]])
    expect(server.state.updates).toEqual([{ fallback: null }])
    expect(selection.state.applied).toEqual([{ providerID: "provider", modelID: "ghost" }])
    expect(selection.state.committed).toHaveLength(1)
    expect(server.data.config.fallback).toBeNull()
    expect(errors).toEqual([])
    dispose()
  })

  test("keeps primary and variant changes that do not persist fallback working", async () => {
    const { server, selection, pair, dispose } = setup(null)
    working(server, "ses_other")

    await pair.selectPrimary(fallbackItem)
    await pair.selectVariant("low")

    expect(selection.state.applied).toHaveLength(1)
    expect(selection.state.variant).toBe("low")
    expect(server.state.sets).toEqual([])
    expect(server.state.updates).toEqual([])
    dispose()
  })
})

describe("composer model-pair direct-fallback supersession", () => {
  test("F1 supersedes a pending fallback B with C", async () => {
    const { server, errors, pair, dispose } = setup()
    working(server, "ses_current")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(fallbackItem)
    await waitFor(() => server.state.updates.length === 1, "PATCH B was never submitted")
    const requestedB = { model: "provider/fallback", variant: null }
    expect(server.data.config.fallback).toEqual(requestedB)
    expect(server.state.sets).toEqual([["config", "fallback", requestedB]])

    const operationC = pair.selectFallback(otherItem)
    await waitFor(() => server.state.updates.length === 2, "PATCH C was never submitted")
    await operationB
    expect(server.state.abortRejections).toBe(1)

    const requestedC = { model: "provider/other", variant: null }
    expect(server.data.config.fallback).toEqual(requestedC)
    expect(server.state.sets).toEqual([
      ["config", "fallback", requestedB],
      ["config", "fallback", requestedC],
    ])
    expect(errors).toEqual([])

    server.state.pending[1]?.resolve()
    await operationC
    expect(server.data.config.fallback).toEqual(requestedC)
    expect(errors).toEqual([])
    dispose()
  })

  test("F2 skips a stale queued C between B and D", async () => {
    const { server, errors, pair, dispose } = setup()
    working(server, "ses_current")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(fallbackItem)
    await waitFor(() => server.state.updates.length === 1, "PATCH B was never submitted")
    const operationC = pair.selectFallback(otherItem)
    const operationD = pair.selectFallback(lateItem)

    await waitFor(() => server.state.updates.length === 2, "PATCH D was never submitted")
    await operationB
    await operationC

    const requestedB = { model: "provider/fallback", variant: null }
    const requestedD = { model: "provider/late", variant: null }
    expect(server.state.updates.map((entry) => entry.fallback)).toEqual([requestedB, requestedD])
    expect(server.state.sets).toEqual([
      ["config", "fallback", requestedB],
      ["config", "fallback", requestedD],
    ])
    expect(server.data.config.fallback).toEqual(requestedD)
    expect(server.state.abortRejections).toBe(1)
    expect(errors).toEqual([])

    server.state.pending[1]?.resolve()
    await operationD
    expect(server.data.config.fallback).toEqual(requestedD)
    expect(errors).toEqual([])
    dispose()
  })

  test("F3 supersedes a pending fallback model with a variant change", async () => {
    const { server, errors, pair, dispose } = setup({ model: "provider/fallback", variant: "low" })
    working(server, "ses_current")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(fallbackItem)
    await waitFor(() => server.state.updates.length === 1, "PATCH B was never submitted")
    const operationVariant = pair.selectFallbackVariant("high")

    await waitFor(() => server.state.updates.length === 2, "PATCH B with variant was never submitted")
    await operationB

    const requestedB = { model: "provider/fallback", variant: "low" }
    expect(server.state.updates[0]).toEqual({ fallback: requestedB })
    const requested = { model: "provider/fallback", variant: "high" }
    expect(server.state.updates[1]).toEqual({ fallback: requested })
    expect(server.data.config.fallback).toEqual(requested)
    expect(server.state.abortRejections).toBe(1)
    expect(errors).toEqual([])

    server.state.pending[1]?.resolve()
    await operationVariant
    expect(server.data.config.fallback).toEqual(requested)
    expect(errors).toEqual([])
    dispose()
  })

  test("F4 supersedes a pending fallback with an explicit clear", async () => {
    const { server, errors, pair, dispose } = setup()
    working(server, "ses_current")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(fallbackItem)
    await waitFor(() => server.state.updates.length === 1, "PATCH B was never submitted")
    const operationClear = pair.selectFallback(undefined)

    await waitFor(() => server.state.updates.length === 2, "PATCH clear was never submitted")
    await operationB

    const requestedB = { model: "provider/fallback", variant: null }
    expect(server.state.updates[1]).toEqual({ fallback: null })
    expect(server.data.config.fallback).toBeNull()
    expect(server.state.sets).toEqual([
      ["config", "fallback", requestedB],
      ["config", "fallback", null],
    ])
    expect(server.state.abortRejections).toBe(1)
    expect(errors).toEqual([])

    server.state.pending[1]?.resolve()
    await operationClear
    expect(server.data.config.fallback).toBeNull()
    expect(errors).toEqual([])
    dispose()
  })

  test("F5 rolls back and notifies on a genuine persistence failure", async () => {
    const { server, errors, pair, dispose } = setup()
    working(server, "ses_current")
    server.state.failUpdates = true

    const requestedB = { model: "provider/fallback", variant: null }
    await pair.selectFallback(fallbackItem)

    expect(errors).toHaveLength(1)
    expect(server.state.sets).toEqual([
      ["config", "fallback", requestedB],
      ["config", "fallback", null],
    ])
    expect(server.data.config.fallback).toBeNull()
    dispose()
  })

  test("F6 keeps an ordinary pair swap queued behind a pending direct fallback edit", async () => {
    const initial: FallbackConfig = { model: "provider/fallback", variant: "low" }
    const { server, selection, errors, pair, dispose } = setup(initial)
    working(server, "ses_other")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(fallbackItem)
    await waitFor(() => server.state.updates.length === 1, "PATCH B was never submitted")
    const operationSwap = pair.swap()

    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve()
    expect(server.state.abortRejections).toBe(0)
    expect(server.state.updates).toHaveLength(1)

    server.state.pending[0]?.resolve()
    await operationB
    await waitFor(() => server.state.updates.length === 2, "PATCH swap was never submitted")
    expect(server.state.updates[1]).toEqual({ fallback: { model: "provider/primary", variant: "high" } })

    server.state.pending[1]?.resolve()
    await operationSwap
    expect(selection.state.committed).toHaveLength(1)
    expect(server.data.config.fallback).toEqual({ model: "provider/primary", variant: "high" })
    expect(errors).toEqual([])
    dispose()
  })

  test("F7 supersedes a pair-routed direct fallback edit", async () => {
    const { server, selection, errors, pair, dispose } = setup({ model: "provider/fallback", variant: "low" })
    working(server, "ses_other")
    server.state.holdUpdates = true

    const operationB = pair.selectFallback(primaryItem)
    await waitFor(() => server.state.updates.length === 1, "pair-routed PATCH B was never submitted")
    expect(server.state.updates[0]).toEqual({ fallback: { model: "provider/primary", variant: "high" } })

    const operationC = pair.selectFallback(otherItem)
    await waitFor(() => server.state.updates.length === 2, "PATCH C was never submitted")
    expect(server.state.abortRejections).toBe(1)
    await operationB

    expect(selection.state.restores).toEqual(["restore"])
    expect(selection.state.committed).toHaveLength(0)
    expect(errors).toEqual([])
    expect(server.state.sets).toEqual([
      ["config", "fallback", { model: "provider/primary", variant: "high" }],
      ["config", "fallback", { model: "provider/fallback", variant: "low" }],
      ["config", "fallback", { model: "provider/other", variant: "low" }],
    ])
    expect(server.data.config.fallback).toEqual({ model: "provider/other", variant: "low" })

    server.state.pending[1]?.resolve()
    await operationC
    expect(selection.state.committed).toHaveLength(0)
    expect(errors).toEqual([])
    dispose()
  })
})
