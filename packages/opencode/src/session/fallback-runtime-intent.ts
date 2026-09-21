export * as FallbackRuntimeIntent from "./fallback-runtime-intent"

import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { ModelFallbackConfig } from "@opencode-ai/core/model-fallback"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type * as Scope from "effect/Scope"

export type Override = { readonly type: "none" } | { readonly type: "some"; readonly value: ModelFallbackConfig | null }

export interface Snapshot {
  readonly revision: number
  readonly override: Override
}

export interface Interface {
  readonly current: () => Effect.Effect<Snapshot>
  readonly stage: (value: ModelFallbackConfig | null) => Effect.Effect<number>
  readonly clearIfCurrent: (revision: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FallbackRuntimeIntent") {}

const initial: Snapshot = { revision: 0, override: { type: "none" } }

export const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make(initial)

  const current = () => SynchronizedRef.get(state)
  const stage = (value: ModelFallbackConfig | null) =>
    SynchronizedRef.modify(state, (previous) => {
      const revision = previous.revision + 1
      return [revision, { revision, override: { type: "some", value } }] as const
    })
  const clearIfCurrent = (revision: number) =>
    SynchronizedRef.update(state, (previous): Snapshot =>
      previous.revision === revision ? { ...previous, override: { type: "none" } } : previous,
    )

  return { current, stage, clearIfCurrent } satisfies Interface
})

export const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})

export const acquireProcess = (scope: Scope.Scope) =>
  Layer.buildWithMemoMap(layer, memoMap, scope).pipe(Effect.map((context) => Context.get(context, Service)))
