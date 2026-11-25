import type { AsyncStorage, PersistenceSyncAPI, SyncStorage } from "@solid-primitives/storage"
import { batch, createMemo, createSignal, getOwner, onCleanup, untrack } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import {
  createPersistStoreState,
  isPersistReady,
  needsPersistFlush,
  transitionPersistStore,
  type PersistStoreEffect,
  type PersistStoreEvent,
} from "./persist-machine"

const persistSaveDelay = 100

const pending = new Set<() => void>()

/**
 * One store's failed save, carried out to whoever owns the value: `attempted` is the serialized value this store
 * tried to write, `fallback` is what storage is known to hold, and `id` only sequences observations of this store
 * (a save window covers the whole document, so it never says which edit failed). The store clears it once a later
 * save of the same store lands.
 */
export type PersistWriteFailure = {
  readonly id: number
  readonly attempted: string
  readonly fallback: string | undefined
}

const EDITED: PersistStoreEvent = Object.freeze({ type: "edited", baseline: undefined })

/** Serialize and write every store with unsaved changes now. */
export function flushPersisted() {
  for (const save of [...pending]) save()
}

// Covers synchronous web storage. Desktop registers its own pagehide handling earlier than this
// module loads, so its shutdown path calls flushPersisted() itself before flushing namespaces.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersisted()
  })
  window.addEventListener("pagehide", flushPersisted)
}

// A store whose serialized form is written to storage on a schedule instead of on every setter
// call. The setter only marks the store dirty; serialization happens once per save window, once
// per owner cleanup, and when the page hides. Mirrors VS Code's Memento. The lifecycle is the
// pure machine in persist-machine.ts; this driver owns the timer, storage calls and broadcasts.
export function persistStore<T extends object>(input: {
  store: Store<T>
  setStore: SetStoreFunction<T>
  name: string
  /** A sync `setItem` that returns `false`, or an async one that rejects, marks the write failed. */
  storage: SyncStorage | AsyncStorage
  serialize: (value: T) => string
  deserialize: (raw: string) => T
  sync?: PersistenceSyncAPI
  delay?: number
  /** Replaces `storage.setItem` for stores whose storage can take the value itself; rejects when it fails. */
  write?: (value: T, serialized: string) => Promise<void>
}) {
  const delay = input.delay ?? persistSaveDelay
  const init = input.storage.getItem(input.name)
  const initial = createPersistStoreState(init instanceof Promise ? { async: true } : { raw: init })
  const [persistState, setPersistState] = createSignal(initial.state)
  // The store's own outstanding save failure, if any, plus the counters that keep its observations ordered.
  const [writeFailure, setWriteFailure] = createSignal<PersistWriteFailure | undefined>(undefined)
  let attempts = 0
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const stopSave = () => {
    clearTimeout(timer)
    timer = undefined
    pending.delete(flush)
  }

  const dispatch = (event: PersistStoreEvent) => {
    const prev = untrack(persistState)
    const next = transitionPersistStore(prev, event)

    if (next.state === prev && next.effects.length === 0) return

    // The state is set before effects run so a write that fails synchronously transitions from it.
    batch(() => {
      setPersistState(next.state)
      next.effects.forEach(run)
    })
  }

  const run = (effect: PersistStoreEffect) => {
    if (effect.type === "hydrate") return input.setStore(reconcile(input.deserialize(effect.raw)))

    if (effect.type === "schedule-save") {
      pending.add(flush)
      timer ??= setTimeout(flush, delay)

      return
    }

    input.sync?.[1](input.name, effect.serialized)

    // Which save attempt this write is, so a late outcome cannot record or clear an observation about a newer one.
    const attempt = ++attempts

    const failed = () => {
      // A newer save of this store already answered this attempt, so nothing about this store is stale: the machine
      // ignores a `write.failed` whose `attempted` is no longer its `last`, and it cannot tell that apart from the
      // case where a later save happened to repeat this attempt's exact value. The attempt check keeps that one from
      // rolling `last` back to a value storage stopped holding, and keeps the observation honest about the same fact.
      if (attempts !== attempt) return

      dispatch({ type: "write.failed", attempted: effect.serialized, fallback: effect.fallback })

      setWriteFailure({ id: ++failures, attempted: effect.serialized, fallback: effect.fallback })
    }

    const saved = () => {
      // A save that landed answers the outstanding failure, so the observation never outlives it.
      if (attempts === attempt) setWriteFailure(undefined)
    }

    // A sync localStorage view returns `false` when the value could not be stored.
    const result: unknown = input.write
      ? input.write(input.store, effect.serialized)
      : input.storage.setItem(input.name, effect.serialized)

    if (result === false) return failed()

    if (result instanceof Promise) {
      result.then(saved, (error) => {
        console.error(`[persistence] write failed for ${input.name}`, error)
        failed()
      })
    } else saved()
  }

  const flush = () => {
    stopSave()

    if (!needsPersistFlush(untrack(persistState))) return
    dispatch({ type: "flushed", serialized: untrack(() => input.serialize(input.store)) })
  }

  // SAFETY: Solid's setter overloads are too deep to spread generically; the wrapper only forwards its arguments.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const apply = input.setStore as unknown as (...values: unknown[]) => void

  // SAFETY: forwards every argument to the setter typed above, so it accepts exactly what `SetStoreFunction` does.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const setStore = ((...values: unknown[]) => {
    const current = untrack(persistState)

    // The first edit while loading records what the store held, so a save can tell a no-op edit apart.
    const baseline =
      current.status === "hydrating" && !current.edit ? untrack(() => input.serialize(input.store)) : undefined

    apply(...values)

    dispatch(baseline === undefined ? EDITED : { type: "edited", baseline })
  }) as unknown as SetStoreFunction<T>

  initial.effects.forEach(run)

  if (init instanceof Promise) {
    void init.then(
      (raw) => dispatch({ type: "init.resolved", raw }),
      () => dispatch({ type: "init.failed" }),
    )
  }

  input.sync?.[0]((data) => {
    if (data.key !== input.name || (data.url ?? location.href) !== location.href) return

    if (!data.newValue) return
    dispatch({ type: "remote.received", raw: data.newValue })
  })

  if (getOwner()) {
    onCleanup(() => {
      const serialized = needsPersistFlush(untrack(persistState))
        ? untrack(() => input.serialize(input.store))
        : undefined

      stopSave()
      dispatch({ type: "disposed", serialized })
    })
  }

  // A memo, so readers rerun only when readiness changes, not on every edit and save.
  const ready = createMemo(() => isPersistReady(persistState()))

  return { setStore, init, flush, state: persistState, ready, failure: writeFailure }
}
