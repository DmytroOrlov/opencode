import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState } from "@/context/prompt-state"

const provider = (id: string, models: Record<string, { id: string; variants?: Record<string, unknown> }>) => ({
  id,
  name: id,
  models: Object.fromEntries(
    Object.entries(models).map(([modelID, item]) => [modelID, { ...item, name: modelID, release_date: "2026-01-01" }]),
  ),
})

const firstProvider = provider("provider", {
  primary: { id: "primary", variants: { high: {}, low: {} } },
  fallback: { id: "fallback", variants: { high: {}, low: {} } },
})
const catalog = Object.values(firstProvider.models).map((item) => ({ ...item, provider: firstProvider, latest: true }))
const preference = {
  user: [] as Array<{ providerID: string; modelID: string; visibility: "show" | "hide" }>,
  recent: [] as Array<{ providerID: string; modelID: string }>,
  variant: {} as Record<string, string | undefined>,
}
const key = (model: { providerID: string; modelID: string }) => `${model.providerID}:${model.modelID}`
const variantKey = (model: { providerID: string; modelID: string }) => `${model.providerID}/${model.modelID}`
const models = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  list: () => catalog,
  find: (key: { providerID: string; modelID: string }) => catalog.find((item) => item.id === key.modelID),
  visible: (model: { providerID: string; modelID: string }) =>
    preference.user.find((item) => key(item) === key(model))?.visibility !== "hide",
  setVisibility: (model: { providerID: string; modelID: string }, visible: boolean) => {
    const current = preference.user.find((item) => key(item) === key(model))
    if (current) current.visibility = visible ? "show" : "hide"
    else preference.user.push({ ...model, visibility: visible ? "show" : "hide" })
  },
  commitSelection: (model: { providerID: string; modelID: string }, options?: { recent?: boolean }) => {
    models.setVisibility(model, true)
    if (options?.recent) models.recent.push(model)
  },
  recent: {
    list: () => preference.recent,
    push: (model: { providerID: string; modelID: string }) => {
      preference.recent = [model, ...preference.recent.filter((item) => key(item) !== key(model))].slice(0, 5)
    },
  },
  variant: {
    get: (model: { providerID: string; modelID: string }) => preference.variant[variantKey(model)],
    set: (model: { providerID: string; modelID: string }, value: string | undefined) => {
      preference.variant[variantKey(model)] = value
    },
    commit: (model: { providerID: string; modelID: string }, value: string | undefined) => {
      preference.variant[variantKey(model)] = value
    },
  },
}

const providerCatalog = {
  connected: () => [firstProvider],
  all: () => new Map([[firstProvider.id, firstProvider]]),
  default: () => ({ provider: "primary" }),
  defaultModel: () => undefined,
}

mock.module("@/context/models", () => ({ useModels: () => models }))
mock.module("@/context/prompt", () => ({
  usePrompt: () => prompt,
  DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
  isCommentItem: () => false,
  isPromptEqual: () => true,
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/repo" }) }))
mock.module("@/context/sync", () => ({ useSync: () => () => ({ data: { config: {} } }) }))
mock.module("@/hooks/use-providers", () => ({ useProviders: () => providerCatalog }))

let prompt: ReturnType<typeof createPromptState>

describe("real composer model-pair queue", () => {
  const createServer = () => {
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    let fallback: { model: string; variant: string | null } | null | undefined = {
      model: "provider/fallback",
      variant: "low",
    }
    const requests: Array<{ fallback: typeof fallback }> = []
    const server = {
      data: { config: { get fallback() { return fallback } } },
      set: (_scope: string, _key: string, value: typeof fallback) => {
        fallback = value
      },
      updateConfig: async (config: { fallback: typeof fallback }) => {
        requests.push(config)
        await new Promise<void>((resolve, reject) => pending.push({ resolve, reject: reject as (error: Error) => void }))
      },
    }
    return { server, pending, requests, getFallback: () => fallback }
  }

  test("restores only raw state after failed primary transition and defers preferences", async () => {
    const { server, pending, requests } = createServer()
    mock.module("@/context/server-sync", () => ({ useServerSync: () => () => server }))

    await createRoot(async (dispose) => {
      preference.user = [{ providerID: "provider", modelID: "unrelated", visibility: "hide" }]
      preference.recent = [{ providerID: "provider", modelID: "unrelated" }]
      preference.variant = { "provider/unrelated": "low" }
      prompt = createPromptState({ model: { providerID: "provider", modelID: "primary", variant: "high" } })
      const { createPromptModelSelection } = await import("@/pages/session/composer/prompt-model-selection")
      const selection = createPromptModelSelection({ agent: () => undefined })
      const pair = selection.pair
      const fallbackItem = catalog.find((item) => item.id === "fallback")!

      const first = pair.selectPrimary(fallbackItem)
      for (let attempt = 0; attempt < 10 && requests.length === 0; attempt++) await Promise.resolve()
      expect(requests).toHaveLength(1)
      expect(selection.current()?.id).toBe("fallback")
      expect(preference.recent).toEqual([{ providerID: "provider", modelID: "unrelated" }])
      expect(preference.user).toEqual([{ providerID: "provider", modelID: "unrelated", visibility: "hide" }])
      expect(preference.variant).toEqual({ "provider/unrelated": "low" })
      preference.recent = [
        { providerID: "provider", modelID: "unrelated" },
        { providerID: "provider", modelID: "fallback" },
        { providerID: "provider", modelID: "primary" },
      ]
      preference.user.push({ providerID: "provider", modelID: "fallback", visibility: "show" })
      preference.variant["provider/fallback"] = "low"

      pending.shift()!.reject(new Error("rejected"))
      await first
      expect(prompt.model.current()).toEqual({ providerID: "provider", modelID: "primary", variant: "high" })
      expect(preference.recent).toEqual([
        { providerID: "provider", modelID: "unrelated" },
        { providerID: "provider", modelID: "fallback" },
        { providerID: "provider", modelID: "primary" },
      ])
      expect(preference.user).toContainEqual({ providerID: "provider", modelID: "unrelated", visibility: "hide" })
      expect(preference.user).toContainEqual({ providerID: "provider", modelID: "fallback", visibility: "show" })
      expect(preference.variant).toEqual({
        "provider/unrelated": "low",
        "provider/fallback": "low",
      })
      dispose()
    })
  })

  test("serializes two persistence operations and computes the second from restored state", async () => {
    const { server, pending, requests, getFallback } = createServer()
    mock.module("@/context/server-sync", () => ({ useServerSync: () => () => server }))

    await createRoot(async (dispose) => {
      preference.user = []
      preference.recent = []
      preference.variant = {}
      prompt = createPromptState({ model: { providerID: "provider", modelID: "primary", variant: "high" } })
      const { createPromptModelSelection } = await import("@/pages/session/composer/prompt-model-selection")
      const selection = createPromptModelSelection({ agent: () => undefined })
      const pair = selection.pair
      const fallbackItem = catalog.find((item) => item.id === "fallback")!

      const first = pair.selectFallbackVariant("high")
      const second = pair.selectPrimary(fallbackItem)
      for (let attempt = 0; attempt < 10 && requests.length === 0; attempt++) await Promise.resolve()
      expect(requests).toHaveLength(1)
      expect(selection.current()?.id).toBe("primary")
      expect(getFallback()).toEqual({ model: "provider/fallback", variant: "high" })
      expect(second).toBeInstanceOf(Promise)
      expect(requests).toHaveLength(1)

      pending.shift()!.reject(new Error("first rejected"))
      await first
      for (let attempt = 0; attempt < 10 && requests.length < 2; attempt++) await Promise.resolve()
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual({ fallback: { model: "provider/primary", variant: "high" } })
      expect(selection.current()?.id).toBe("fallback")
      expect(getFallback()).toEqual({ model: "provider/primary", variant: "high" })

      pending.shift()!.resolve()
      await first
      await second
      expect(requests).toHaveLength(2)
      expect(selection.current()?.id).toBe("fallback")
      expect(getFallback()).toEqual({ model: "provider/primary", variant: "high" })
      dispose()
    })
  })

  test("commits primary preferences only after authoritative success", async () => {
    const { server, pending, requests } = createServer()
    mock.module("@/context/server-sync", () => ({ useServerSync: () => () => server }))

    await createRoot(async (dispose) => {
      preference.user = []
      preference.recent = []
      preference.variant = {}
      prompt = createPromptState({ model: { providerID: "provider", modelID: "primary", variant: "high" } })
      const { createPromptModelSelection } = await import("@/pages/session/composer/prompt-model-selection")
      const selection = createPromptModelSelection({ agent: () => undefined })
      const operation = selection.pair.selectPrimary(catalog.find((item) => item.id === "fallback")!)

      for (let attempt = 0; attempt < 10 && requests.length === 0; attempt++) await Promise.resolve()
      expect(requests).toHaveLength(1)
      expect(preference.user).toEqual([])
      expect(preference.recent).toEqual([])
      expect(preference.variant).toEqual({})

      pending.shift()!.resolve()
      await operation
      expect(preference.user).toContainEqual({ providerID: "provider", modelID: "fallback", visibility: "show" })
      expect(preference.recent[0]).toEqual({ providerID: "provider", modelID: "fallback" })
      expect(preference.variant["provider/fallback"]).toBe("low")
      dispose()
    })
  })

  test("failed fallback-only persistence leaves raw primary model and variant untouched", async () => {
    const { server, pending, requests } = createServer()
    mock.module("@/context/server-sync", () => ({ useServerSync: () => () => server }))

    await createRoot(async (dispose) => {
      preference.user = []
      preference.recent = []
      preference.variant = {}
      prompt = createPromptState({ model: { providerID: "provider", modelID: "primary", variant: "high" } })
      const { createPromptModelSelection } = await import("@/pages/session/composer/prompt-model-selection")
      const selection = createPromptModelSelection({ agent: () => undefined })
      const operation = selection.pair.selectFallbackVariant("high")

      for (let attempt = 0; attempt < 10 && requests.length === 0; attempt++) await Promise.resolve()
      expect(requests).toHaveLength(1)
      pending.shift()!.reject(new Error("fallback rejected"))
      await operation
      expect(prompt.model.current()).toEqual({ providerID: "provider", modelID: "primary", variant: "high" })
      dispose()
    })
  })
})
