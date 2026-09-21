import { batch, createMemo, startTransition } from "solid-js"
import { useModels } from "@/context/models"
import type { ModelKey, ModelSelection } from "@/context/local"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "@/context/model-variant"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import type { ModelFallbackConfig } from "@opencode-ai/core/model-fallback"
import {
  displayedFallbackForPrimary,
  fallbackForModelPair,
  fallbackForModelSelection,
  filterFallbackModels,
  parseModelReference,
  sameModelIdentity,
  shouldClearFallbackForPrimary,
  type ModelIdentity,
} from "@/utils/model-fallback"
import { showToast } from "@/utils/toast"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]
const modelIdentity = (item: ModelItem) => ({ providerID: item.provider.id, modelID: item.id })

export type ModelPairController = {
  readonly primaryModels: () => ModelItem[]
  readonly fallbackModels: () => ModelItem[]
  readonly fallback: {
    readonly displayed: () => ModelFallbackConfig | null
    readonly selected: () => ModelItem | undefined
    readonly variants: () => string[]
  }
  readonly selectPrimary: (item: ModelItem) => Promise<void>
  readonly selectFallback: (item: ModelItem | undefined) => Promise<void>
  readonly selectFallbackVariant: (variant: string) => Promise<void>
  readonly selectVariant: (variant: string | undefined) => Promise<void>
  readonly cycleVariant: () => Promise<void>
  readonly swap: () => Promise<void>
}

export function carriedModelVariant(input: { variant: string | undefined; variants: Record<string, unknown> }) {
  return input.variant && Object.hasOwn(input.variants, input.variant) ? input.variant : undefined
}

export function computeModelPairSwap(input: {
  primary: ModelIdentity
  primaryVariants: Record<string, unknown>
  primaryVariant: string | undefined
  fallback: ModelFallbackConfig
  fallbackModel: ModelIdentity
  fallbackVariants: Record<string, unknown>
}) {
  return {
    primary: input.fallbackModel,
    fallback: fallbackForModelPair({
      model: input.primary,
      variants: input.primaryVariants,
      variant: input.primaryVariant,
    }),
    primaryVariant: carriedModelVariant({
      variant: typeof input.fallback.variant === "string" ? input.fallback.variant : undefined,
      variants: input.fallbackVariants,
    }),
  }
}

export function createModelPairController(input: { selection: ModelSelection; onError?: (error: unknown) => void }) {
  const models = useModels()
  const serverSync = useServerSync()
  const selection = input.selection
  const notify = input.onError ?? ((error) => showToast({ title: "Request failed", description: String(error) }))
  const primary = createMemo(() => {
    const item = selection.current()
    if (!item) return
    return { providerID: item.provider.id, modelID: item.id }
  })
  const displayed = createMemo(() => displayedFallbackForPrimary(primary(), serverSync().data.config.fallback))
  const selected = createMemo(() => {
    const fallback = displayed()
    return fallback ? models.find(parseModelReference(fallback.model)) : undefined
  })
  const visible = createMemo(() =>
    models.list().filter((item) => models.visible({ providerID: item.provider.id, modelID: item.id })),
  )
  const primaryModels = createMemo(() => {
    const current = selected()
    if (!current || visible().some((item) => sameModelIdentity(modelIdentity(item), modelIdentity(current))))
      return visible()
    return [current, ...visible()]
  })
  const fallbackModels = createMemo(() => {
    const current = selected()
    const available = visible()
    const withCurrent =
      current && !available.some((item) => sameModelIdentity(modelIdentity(item), modelIdentity(current)))
        ? [current, ...available]
        : available
    if (!current) return filterFallbackModels(withCurrent, primary())
    if (!primary() || withCurrent.some((item) => sameModelIdentity(modelIdentity(item), primary()!)))
      return withCurrent
    return [selection.current()!, ...withCurrent]
  })

  let tail = Promise.resolve()
  const enqueue = <T>(intent: T, operation: (intent: T) => Promise<void>) => {
    const result = tail.then(() => operation(intent))
    tail = result.catch(() => {})
    return result
  }

  const modelKeyForItem = (item: ModelItem): ModelKey => ({ providerID: item.provider.id, modelID: item.id })
  const persist = async (
    next: ModelFallbackConfig | null,
    apply: () => Promise<void>,
    restore?: () => void,
    commit?: () => Promise<void>,
  ) => {
    const before = serverSync().data.config.fallback
    serverSync().set("config", "fallback", next)
    try {
      await apply()
      await serverSync().updateConfig({ fallback: next })
      await commit?.()
    } catch (error) {
      serverSync().set("config", "fallback", before)
      restore?.()
      notify(error)
    }
  }

  const transition = async (apply: () => Promise<void>, restore: () => void, commit?: () => Promise<void>) => {
    try {
      await apply()
      await commit?.()
    } catch (error) {
      restore()
      notify(error)
    }
  }

  const setPrimary = async (item: ModelItem, variant: string | undefined) => {
    await selection.apply(modelKeyForItem(item))
    await selection.variant.apply(variant)
  }

  const commitPrimary = async (item: ModelItem, variant: string | undefined, recent: boolean) => {
    const model = modelKeyForItem(item)
    await selection.commit(model, { recent })
    selection.variant.commit(model, variant)
  }

  const swapInternal = async () => {
    const oldPrimary = selection.current()
    const oldSecondary = selected()
    const oldFallback = displayed()
    if (!oldPrimary || !oldSecondary || !oldFallback) return
    const next = computeModelPairSwap({
      primary: { providerID: oldPrimary.provider.id, modelID: oldPrimary.id },
      primaryVariants: oldPrimary.variants ?? {},
      primaryVariant: selection.variant.current(),
      fallback: oldFallback,
      fallbackModel: { providerID: oldSecondary.provider.id, modelID: oldSecondary.id },
      fallbackVariants: oldSecondary.variants ?? {},
    })
    const snapshot = selection.snapshot()
    const variant = next.primaryVariant
    await persist(
      next.fallback,
      async () => {
        await setPrimary(oldSecondary, variant)
      },
      snapshot.restore,
      () => commitPrimary(oldSecondary, variant, true),
    )
  }

  const executePrimary = async (item: ModelItem) => {
    const secondary = selected()
    if (secondary && sameModelIdentity(modelIdentity(item), modelIdentity(secondary))) {
      await swapInternal()
      return
    }
    const primary = selection.current()
    const snapshot = selection.snapshot()
    const primaryIdentity = modelKeyForItem(item)
    const variant = carriedModelVariant({
      variant: selection.variant.selected() ?? undefined,
      variants: item.variants ?? {},
    })
    if (!shouldClearFallbackForPrimary(primaryIdentity, serverSync().data.config.fallback)) {
      await transition(
        () => setPrimary(item, variant),
        snapshot.restore,
        () => commitPrimary(item, variant, true),
      )
      return
    }
    await persist(
      null,
      () => setPrimary(item, variant),
      snapshot.restore,
      () => commitPrimary(item, variant, true),
    )
  }

  const executeFallback = async (item: ModelItem | undefined) => {
    if (!item) {
      await persist(null, async () => {})
      return
    }
    const model = modelKeyForItem(item)
    const currentPrimary = primary()
    if (currentPrimary && sameModelIdentity(model, currentPrimary)) {
      if (selected()) await swapInternal()
      else await persist(null, async () => {})
      return
    }
    await persist(
      fallbackForModelSelection({ model, variants: item.variants ?? {}, rawFallback: serverSync().data.config.fallback }),
      async () => {},
    )
  }

  const executeFallbackVariant = async (variant: string) => {
    const fallback = displayed()
    if (!fallback || !selected()) return
    await persist({ ...fallback, variant: variant || null }, async () => {})
  }

  const executeVariant = async (variant: string | undefined) => {
    const item = selection.current()
    if (!item) return
    const snapshot = selection.snapshot()
    const model = modelKeyForItem(item)
    await transition(
      () => selection.variant.apply(variant),
      snapshot.restore,
      async () => selection.variant.commit(model, variant),
    )
  }

  const executeCycleVariant = async () => {
    const variants = selection.variant.list()
    if (variants.length === 0) return
    const next = cycleModelVariant({
      variants,
      selected: selection.variant.selected(),
      configured: selection.variant.configured(),
    })
    await executeVariant(next)
  }

  return {
    primaryModels,
    fallbackModels,
    fallback: {
      displayed,
      selected,
      variants: () => Object.keys(selected()?.variants ?? {}),
    },
    selectPrimary(item: ModelItem) {
      return enqueue(item, executePrimary)
    },
    selectFallback(item: ModelItem | undefined) {
      return enqueue(item, executeFallback)
    },
    selectFallbackVariant(variant: string) {
      return enqueue(variant, executeFallbackVariant)
    },
    selectVariant(variant: string | undefined) {
      return enqueue(variant, executeVariant)
    },
    cycleVariant() {
      return enqueue(undefined, executeCycleVariant)
    },
    swap() {
      return enqueue(undefined, swapInternal)
    },
  } satisfies ModelPairController
}

export function createPromptModelSelection(input: { agent: () => { model?: ModelKey; variant?: string } | undefined }) {
  const sdk = useSDK()
  const sync = useSync()
  const models = useModels()
  const prompt = usePrompt()
  const providers = useProviders(() => sdk().directory)
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

  const valid = (model: ModelKey) => {
    const provider = providers.all().get(model.providerID)
    return !!provider?.models[model.modelID] && connected().has(model.providerID)
  }

  const configured = () => {
    const model = resolveDefaultModel(providers.defaultModel(), sync().data.config.model)
    if (!model) return
    if (valid(model)) return model
  }

  const recent = () => models.recent.list().find(valid)
  const fallback = () => {
    const defaults = providers.default()
    return providers.connected().flatMap((provider) => {
      const modelID = defaults[provider.id] ?? Object.values(provider.models)[0]?.id
      return modelID ? [{ providerID: provider.id, modelID }] : []
    })[0]
  }

  const current = () => {
    const key = [prompt.model.current(), input.agent()?.model, configured(), recent(), fallback()].find(
      (item): item is ModelKey => !!item && valid(item),
    )
    if (!key) return
    return models.find(key)
  }
  const recentModels = createMemo(() =>
    models.recent
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const selection = {
    ready: models.ready,
    current,
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      if (index === -1) return
      const next = items[(index + direction + items.length) % items.length]
      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    apply(item: ModelKey | undefined) {
      return startTransition(() =>
        batch(() => {
          prompt.model.set(item ? { ...item, variant: prompt.model.current()?.variant } : undefined)
        }),
      )
    },
    commit(item: ModelKey, options?: { recent?: boolean }) {
      models.commitSelection(item, options)
    },
    set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      const transition = startTransition(() =>
        batch(() => {
          prompt.model.set(item ? { ...item, variant: prompt.model.current()?.variant } : undefined)
          if (item) models.commitSelection(item, options)
        }),
      )
      return transition
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured() {
        const item = input.agent()
        const model = current()
        if (!item || !model) return
        return getConfiguredAgentVariant({
          agent: { model: item.model, variant: item.variant },
          model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
        })
      },
      selected() {
        return prompt.model.current()?.variant
      },
      current() {
        const resolved = resolveModelVariant({
          variants: this.list(),
          selected: this.selected(),
          configured: this.configured(),
        })
        if (resolved) return resolved
        const model = current()
        if (!model) return
        const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
        if (saved && this.list().includes(saved)) return saved
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      apply(value: string | undefined) {
        return startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value ?? null })
          }),
        )
      },
      commit(model: ModelKey, value: string | undefined) {
        models.variant.commit(model, value)
      },
      set(value: string | undefined) {
        return startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value ?? null })
            models.variant.commit({ providerID: model.provider.id, modelID: model.id }, value)
          }),
        )
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: this.selected(),
            configured: this.configured(),
          }),
        )
      },
    },
    snapshot() {
      return prompt.capture().model.snapshot()
    },
  } satisfies ModelSelection

  return Object.assign(selection, { pair: createModelPairController({ selection }) })
}
