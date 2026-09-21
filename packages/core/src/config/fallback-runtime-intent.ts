export * as FallbackRuntimeIntent from "./fallback-runtime-intent.js"

import { ConfigModel } from "@opencode/schema/config/model"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export type Override =
  | { readonly type: "none" }
  | { readonly type: "some"; readonly value: ConfigModel.Selection | null }

export interface Snapshot {
  readonly revision: number
  readonly override: Override
}

export interface Interface {
  readonly current: () => Effect.Effect<Snapshot>
  readonly stage: (value: ConfigModel.Selection | null) => Effect.Effect<number>
  readonly clearIfCurrent: (revision: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FallbackRuntimeIntent") {}

const initial: Snapshot = { revision: 0, override: { type: "none" } }

export const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make(initial)
  const current = () => SynchronizedRef.get(state)
  const stage = (value: ConfigModel.Selection | null) =>
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

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
