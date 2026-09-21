import { createSignal, type Accessor } from "solid-js"

export type FallbackUpdate<Value> = { readonly revision: number; readonly value: Value }

type State<Value> = {
  readonly optimistic: Accessor<FallbackUpdate<Value> | undefined>
  readonly publish: (value: FallbackUpdate<Value> | undefined) => void
  readonly write: (value: Value) => Promise<unknown>
  revision: number
  pending: Promise<void>
}

const states = new WeakMap<object, object>()

export function fallbackUpdateState<Value>(key: object, write: (value: Value) => Promise<unknown>) {
  const existing = states.get(key) as State<Value> | undefined
  if (existing) return api(existing)

  const [optimistic, setOptimistic] = createSignal<FallbackUpdate<Value> | undefined>()
  const state: State<Value> = {
    optimistic,
    publish: setOptimistic,
    write,
    revision: 0,
    pending: Promise.resolve(),
  }
  states.set(key, state)
  return api(state)
}

function api<Value>(state: State<Value>) {
  return {
    optimistic: state.optimistic,
    save(value: Value, failed: (error: unknown) => void) {
      const revision = ++state.revision
      state.publish({ revision, value })
      const request = state.pending.then(() => state.write(value))
      state.pending = request.then(
        () => undefined,
        () => undefined,
      )
      void request.then(
        () => {
          if (state.revision === revision) state.publish(undefined)
        },
        (error) => {
          if (state.revision !== revision) return
          state.publish(undefined)
          failed(error)
        },
      )
    },
  }
}
