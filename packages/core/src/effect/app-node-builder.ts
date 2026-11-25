import { buildLocationServiceMap } from "../location-services.js"
import { LocationServiceMap } from "../location-service-map.js"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, RcMap } from "effect"
import { Instance } from "../instance/service.js"
import { SessionGenerationAdmission } from "../session/generation-admission.js"
import { FallbackRuntimeIntent } from "../config/fallback-runtime-intent.js"

const instances = makeGlobalNode({
  service: Instance.Service,
  layer: Layer.effect(
    Instance.Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Instance.Service.of({
        provide: (session) => Effect.provide(locations.get(session.location)),
        live: (session) => RcMap.has(locations.rcMap, LocationServiceMap.canonical(session.location)),
      })
    }),
  ),
  deps: [LocationServiceMap.node],
})

// One admission value and one runtime-fallback intent owner per application graph: `make` only allocates synchronized
// state, so both are built eagerly here and injected as VALUEs through the existing `bindings` path, which is what
// `buildLocationServiceMap` hands to every per-location instance graph. Admission owns lease ownership; the intent owner
// owns entry-order reservations for the global config document, which every location writes, so BOTH must be shared or
// two location graphs can hold distinct sequences for the same file. Keeping `compile` synchronous also keeps `build`'s
// structural validation (a cycle in the graph throws at the call site) instead of deferring it to first acquisition.
export function build<A, E>(
  root: LayerNode.Graph<A, E>,
  replacements: LayerNode.Replacements = [],
) {
  const admission = Effect.runSync(SessionGenerationAdmission.make)
  const fallbackIntent = Effect.runSync(FallbackRuntimeIntent.make)
  const bindings: LayerNode.Replacements = [
    Instance.node.replace(instances),
    SessionGenerationAdmission.node.replace(
      Layer.succeed(SessionGenerationAdmission.Service, admission),
    ),
    FallbackRuntimeIntent.node.replace(
      Layer.succeed(FallbackRuntimeIntent.Service, fallbackIntent),
    ),
    ...replacements,
  ]
  return LayerNode.compile(root, {
    replacements: [LocationServiceMap.node.replace(buildLocationServiceMap(bindings)), ...bindings],
  })
}

export * as AppNodeBuilder from "./app-node-builder.js"
