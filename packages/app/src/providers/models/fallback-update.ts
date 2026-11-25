import { createSignal, type Accessor } from "solid-js"
import { configNeedsReconciliation } from "@/runtime/server/config-outcome"

export type FallbackUpdate<Value> = { readonly revision: number; readonly value: Value }

type State<Value> = {
  readonly optimistic: Accessor<FallbackUpdate<Value> | undefined>
  readonly publish: (value: FallbackUpdate<Value> | undefined) => void
  readonly write: (value: Value) => Promise<unknown>
  /** Reads the source again, so a durable-but-unconfirmed write is answered from disk, not from what preceded it.
   * Reconciliation is only complete when the read itself has finished, so a caller MUST return the Promise of its
   * GET: the chain releases this revision's optimistic value when that Promise resolves, and keeps the value
   * visible as unconfirmed when it rejects. An absent callback means no authoritative read is available at all. */
  readonly reconcile?: () => Promise<void>
  revision: number
  pending: Promise<void>
}

const states = new WeakMap<object, object>()

export function fallbackUpdateState<Value>(
  key: object,
  write: (value: Value) => Promise<unknown>,
  reconcile?: () => Promise<void>,
) {
  const existing = states.get(key) as State<Value> | undefined
  if (existing) return api(existing)

  const [optimistic, setOptimistic] = createSignal<FallbackUpdate<Value> | undefined>()
  const state: State<Value> = {
    optimistic,
    publish: setOptimistic,
    write,
    reconcile,
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

          // A committed-state code, or a confirmation that failed after the PATCH landed, says this value reached the
          // document (or cannot be assumed to have been withdrawn): restoring what was written over would claim a durable
          // commit was undone. The override stays until the source has been read again, so the displayed value then comes
          // from disk. Every other failure keeps the rollback: the old bytes are the authority there.
          if (configNeedsReconciliation(error)) {
            // Report this write exactly once. A durable commit or failed
            // confirmation is not evidence the server rolled it back.
            failed(error)

            // Without an authoritative read, never manufacture a rollback
            // by revealing an older cached document.
            const reconcile = state.reconcile
            if (!reconcile) return

            void Promise.resolve()
              .then(reconcile)
              .then(
                () => {
                  // Only an actually completed authoritative read may
                  // release this revision's optimistic value.
                  if (state.revision === revision) state.publish(undefined)
                },
                () => {
                  // The GET failed. The source is not confirmed, so keep
                  // this revision visible as unconfirmed instead of
                  // exposing the stale value it replaced.
                  //
                  // Do not report the same write again, retry indefinitely,
                  // or compensate with another PATCH.
                },
              )

            return
          }

          state.publish(undefined)
          failed(error)
        },
      )
    },
  }
}
