export * as ResourceCoordination from "./resource-coordination.js"

import { Effect } from "effect"
import { SessionGenerationAdmission } from "../session/generation-admission.js"
import { FallbackRuntimeIntent } from "../config/fallback-runtime-intent.js"

export interface Pair {
  readonly admission: SessionGenerationAdmission.Interface
  readonly fallbackIntent: FallbackRuntimeIntent.Interface
}

interface Entry {
  readonly pair: Pair
  borrowers: number
}

// Namespace identity is supplied by the effective Config filesystem.
// The directory key is derived from that same filesystem.
const registry = new WeakMap<object, Map<string, Entry>>()

export const borrow = (namespace: object, directoryKey: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let directories = registry.get(namespace)
      if (!directories) {
        directories = new Map()
        registry.set(namespace, directories)
      }
      let entry = directories.get(directoryKey)
      if (!entry) {
        entry = {
          pair: {
            admission: Effect.runSync(SessionGenerationAdmission.make),
            fallbackIntent: Effect.runSync(FallbackRuntimeIntent.make),
          },
          borrowers: 0,
        }
        directories.set(directoryKey, entry)
      }
      entry.borrowers++
      const acquired = entry
      const owner = directories
      return {
        pair: acquired.pair,
        release: () => {
          acquired.borrowers--
          if (acquired.borrowers !== 0) return
          if (owner.get(directoryKey) !== acquired) return
          owner.delete(directoryKey)
          if (owner.size === 0) registry.delete(namespace)
        },
      }
    }),
    (lease) => Effect.sync(lease.release),
  ).pipe(Effect.map((lease) => lease.pair))
