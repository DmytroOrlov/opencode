import { describe, expect, test } from "bun:test"
import type { PersistenceSyncAPI, PersistenceSyncCallback, SyncStorage } from "@solid-primitives/storage"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { flushPersisted, persistStore } from "./persist"
import { isPersistReady } from "./persist-machine"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type State = { count: number; label: string }

function setup(input: { initial?: string | null; delay?: number; sync?: PersistenceSyncAPI }) {
  const writes: string[] = []

  return createRoot((dispose) => {
    const [store, setStore] = createStore<State>({ count: 0, label: "" })

    const persist = persistStore({
      store,
      setStore,
      name: "state",
      storage: {
        getItem: () => input.initial ?? null,
        setItem: (_key: string, value: string) => {
          writes.push(value)
        },
        removeItem: () => {},
      } satisfies SyncStorage,
      serialize: JSON.stringify,
      deserialize: JSON.parse,
      sync: input.sync,
      delay: input.delay ?? 10,
    })

    return { store, set: persist.setStore, persist, writes, dispose }
  })
}

describe("persistStore", () => {
  test("marks the store dirty on set and writes once after the delay", async () => {
    const value = setup({})
    value.set("count", 1)
    value.set("count", 2)
    value.set("label", "a")
    expect(value.store.count).toBe(2)
    expect(value.writes).toEqual([])
    await wait(30)
    expect(value.writes).toEqual([JSON.stringify({ count: 2, label: "a" })])
    value.dispose()
  })

  test("skips the write when the serialized value did not change", () => {
    const value = setup({ delay: 10_000 })
    value.set("count", 1)
    value.persist.flush()
    value.set("count", 1)
    value.persist.flush()
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("hydrates synchronously from sync storage without writing back", () => {
    const value = setup({ initial: JSON.stringify({ count: 5, label: "saved" }), delay: 10_000 })
    expect(value.store).toEqual({ count: 5, label: "saved" })
    value.persist.flush()
    expect(value.writes).toEqual([])
    value.dispose()
  })

  test("applies another window's value when clean and ignores it while dirty", () => {
    const listeners: PersistenceSyncCallback[] = []
    const sent: string[] = []

    const value = setup({
      delay: 10_000,
      sync: [(subscriber) => listeners.push(subscriber), (_key, next) => sent.push(String(next))],
    })

    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 3, label: "remote" }), timeStamp: 0 })
    expect(value.store).toEqual({ count: 3, label: "remote" })
    value.set("label", "local")
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 4, label: "remote-2" }), timeStamp: 0 })
    expect(value.store).toEqual({ count: 3, label: "local" })
    value.persist.flush()
    expect(sent).toEqual([JSON.stringify({ count: 3, label: "local" })])
    value.dispose()
  })

  test("a remote value arriving during a no-op local set is adopted when the save finds no change", () => {
    const listeners: PersistenceSyncCallback[] = []
    const sent: string[] = []

    const value = setup({
      delay: 10_000,
      sync: [(subscriber) => listeners.push(subscriber), (_key, next) => sent.push(String(next))],
    })

    value.set("count", 1)
    value.persist.flush()
    // Setting the same value again marks the store dirty without changing it.
    value.set("count", 1)
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 1, label: "remote" }), timeStamp: 0 })
    expect(value.store.label).toBe("")
    value.persist.flush()
    expect(value.store).toEqual({ count: 1, label: "remote" })
    expect(value.writes).toHaveLength(1)
    expect(sent).toHaveLength(1)
    // A later save must not consider the adopted value a local change.
    value.set("count", 1)
    value.persist.flush()
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("a remote revert to the saved value during a no-op local set clears an earlier held change", () => {
    const listeners: PersistenceSyncCallback[] = []
    const value = setup({ delay: 10_000, sync: [(subscriber) => listeners.push(subscriber), () => {}] })
    value.set("label", "saved")
    value.persist.flush()
    value.set("label", "saved")
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 0, label: "changed" }), timeStamp: 0 })
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 0, label: "saved" }), timeStamp: 0 })
    value.persist.flush()
    expect(value.store).toEqual({ count: 0, label: "saved" })
    expect(value.writes).toHaveLength(1)
    value.dispose()
  })

  test("a remote value arriving during a real local change is dropped in favour of the local one", () => {
    const listeners: PersistenceSyncCallback[] = []
    const value = setup({ delay: 10_000, sync: [(subscriber) => listeners.push(subscriber), () => {}] })
    value.set("count", 1)
    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 9, label: "remote" }), timeStamp: 0 })
    value.persist.flush()
    expect(value.store).toEqual({ count: 1, label: "" })
    expect(value.writes).toEqual([JSON.stringify({ count: 1, label: "" })])
    value.dispose()
  })

  test("a broadcast during an async load is not overwritten when the older load resolves", async () => {
    const load = Promise.withResolvers<string | null>()
    const listeners: PersistenceSyncCallback[] = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: { getItem: () => load.promise, setItem: async () => undefined, removeItem: async () => undefined },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        sync: [(subscriber) => listeners.push(subscriber), () => {}],
      })

      return { store, persist, dispose }
    })

    listeners[0]!({ key: "state", newValue: JSON.stringify({ count: 2, label: "remote" }), timeStamp: 0 })
    expect(isPersistReady(root.persist.state())).toBe(true)
    load.resolve(JSON.stringify({ count: 1, label: "stale" }))
    await load.promise
    await Promise.resolve()
    expect(root.store).toEqual({ count: 2, label: "remote" })
    root.dispose()
  })

  test("a rejected load settles ready", async () => {
    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => Promise.reject(new Error("unavailable")),
          setItem: async () => undefined,
          removeItem: async () => undefined,
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
      })

      return { persist, dispose }
    })

    await Promise.resolve(root.persist.init).catch(() => undefined)
    expect(isPersistReady(root.persist.state())).toBe(true)
    root.dispose()
  })

  test("a write the storage refused is retried by the next save of the same value", () => {
    const results = [false, true]
    const writes: string[] = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => null,
          setItem: (_key: string, value: string) => {
            writes.push(value)

            return results.shift()
          },
          removeItem: () => {},
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        delay: 10_000,
      })

      return { set: persist.setStore, persist, dispose }
    })

    root.set("count", 1)
    root.persist.flush()
    root.set("count", 1)
    root.persist.flush()
    expect(writes).toEqual([JSON.stringify({ count: 1, label: "" }), JSON.stringify({ count: 1, label: "" })])
    root.dispose()
  })

  test("a failed save is reported with the store's own payload until that store saves again", () => {
    let refuse = false
    const writes: string[] = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => null,
          setItem: (_key: string, value: string) => {
            writes.push(value)

            return refuse ? false : true
          },
          removeItem: () => {},
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        delay: 10_000,
      })

      return { set: persist.setStore, persist, dispose }
    })

    refuse = true
    root.set("count", 1)
    root.persist.flush()
    expect(root.persist.failure()).toEqual({
      id: 1,
      attempted: JSON.stringify({ count: 1, label: "" }),
      fallback: undefined,
    })

    // The next save of the same store lands, so nothing is left claiming a failure.
    refuse = false
    root.set("count", 2)
    root.persist.flush()
    expect(root.persist.failure()).toBeUndefined()

    // A later refused save is a new observation, ordered after the one it replaced, and says what storage holds.
    refuse = true
    root.set("count", 3)
    root.persist.flush()
    expect(root.persist.failure()).toEqual({
      id: 2,
      attempted: JSON.stringify({ count: 3, label: "" }),
      fallback: JSON.stringify({ count: 2, label: "" }),
    })
    root.dispose()
  })

  test("a save that lands answers an older rejected one instead of becoming a failure", async () => {
    const requests: Array<{ resolve: (value: string) => void; reject: (reason: Error) => void }> = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => null,
          setItem: (_key: string, value: string) => {
            const request = Promise.withResolvers<string>()
            requests.push(request)

            return request.promise
          },
          removeItem: () => {},
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        delay: 10_000,
      })

      return { set: persist.setStore, persist, dispose }
    })

    root.set("count", 1)
    root.persist.flush()
    root.set("count", 2)
    root.persist.flush()
    expect(root.persist.failure()).toBeUndefined()

    // The first write's rejection arrives after a newer write was issued, so it is not this store's fact.
    requests[0]!.reject(new Error("unavailable"))
    await Promise.resolve()
    expect(root.persist.failure()).toBeUndefined()

    requests[1]!.reject(new Error("unavailable"))
    await Promise.resolve()
    expect(root.persist.failure()?.attempted).toBe(JSON.stringify({ count: 2, label: "" }))

    root.set("count", 3)
    root.persist.flush()
    requests[2]!.resolve(JSON.stringify({ count: 3, label: "" }))
    await Promise.resolve()
    expect(root.persist.failure()).toBeUndefined()
    root.dispose()
  })

  test("an older rejected save cannot move this store's own machine state", async () => {
    const requests: Array<{ resolve: (value: string) => void; reject: (reason: Error) => void }> = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => null,
          setItem: (_key: string, value: string) => {
            const request = Promise.withResolvers<string>()
            requests.push(request)

            return request.promise
          },
          removeItem: () => {},
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        delay: 10_000,
      })

      return { set: persist.setStore, persist, dispose }
    })

    const stored = (count: number) => JSON.stringify({ count, label: "" })

    root.set("count", 1)
    root.persist.flush()
    root.set("count", 2)
    root.persist.flush()
    requests[1]!.resolve(stored(2))
    await Promise.resolve()
    expect(root.persist.state()).toEqual({ status: "clean", last: stored(2) })

    // The first write's rejection arrives later. It changes no state, records no failure, and issues no write: the
    // machine's own `last !== attempted` rule already ignores it, and `persist-machine.test.ts` keeps that rule.
    requests[0]!.reject(new Error("unavailable"))
    await Promise.resolve()
    expect(root.persist.state()).toEqual({ status: "clean", last: stored(2) })
    expect(root.persist.failure()).toBeUndefined()

    // Disposing mid-test would hide a queued write, so end the store cleanly.
    root.dispose()
  })

  test("an older rejected save cannot roll back a later save that repeated its value", async () => {
    const requests: Array<{ resolve: (value: string) => void; reject: (reason: Error) => void }> = []

    const root = createRoot((dispose) => {
      const [store, setStore] = createStore<State>({ count: 0, label: "" })

      const persist = persistStore({
        store,
        setStore,
        name: "state",
        storage: {
          getItem: () => null,
          setItem: (_key: string, value: string) => {
            const request = Promise.withResolvers<string>()
            requests.push(request)

            return request.promise
          },
          removeItem: () => {},
        },
        serialize: JSON.stringify,
        deserialize: JSON.parse,
        delay: 10_000,
      })

      return { set: persist.setStore, persist, dispose }
    })

    const stored = (count: number) => JSON.stringify({ count, label: "" })

    // The first write is left in flight and never lands, so its rejection can only arrive after later saves.
    root.set("count", 1)
    root.persist.flush()
    root.set("count", 2)
    root.persist.flush()
    requests[1]!.resolve(stored(2))
    root.set("count", 1)
    root.persist.flush()
    await Promise.resolve()
    expect(root.persist.state()).toEqual({ status: "clean", last: stored(1) })

    // Storage never held this attempt's value any more, and the machine cannot tell that apart here, because a later
    // save repeated the exact text: only the driver's attempt check keeps the rollback from rewriting `last` to a value
    // storage stopped holding, which is what makes the next save of that text write again instead of adopting it.
    requests[0]!.reject(new Error("unavailable"))
    await Promise.resolve()
    expect(root.persist.state()).toEqual({ status: "clean", last: stored(1) })
    expect(root.persist.failure()).toBeUndefined()

    // Dirty/save ordering follows that state: the store is still clean at that text, so a flush writes nothing, and
    // the next edit writes exactly once.
    root.persist.flush()
    await Promise.resolve()
    expect(requests.length).toBe(3)

    root.set("count", 3)
    root.persist.flush()
    await Promise.resolve()
    expect(requests.length).toBe(4)

    root.dispose()
  })

  test("disposing the owner and flushPersisted both save pending changes", () => {
    const first = setup({ delay: 10_000 })
    first.set("count", 1)
    first.dispose()
    expect(first.writes).toHaveLength(1)

    const second = setup({ delay: 10_000 })
    second.set("count", 2)
    flushPersisted()
    expect(second.writes).toEqual([JSON.stringify({ count: 2, label: "" })])
    second.dispose()
    expect(second.writes).toHaveLength(1)
  })
})
