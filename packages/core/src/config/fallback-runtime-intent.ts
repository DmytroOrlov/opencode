export * as FallbackRuntimeIntent from "./fallback-runtime-intent.js"

import { ConfigModel } from "@opencode/schema/config/model"
import { Context, Deferred, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export type Override =
  | { readonly type: "none" }
  | { readonly type: "some"; readonly value: ConfigModel.Selection | null }

export interface Snapshot {
  readonly revision: number
  readonly override: Override
}

export interface Interface {
  /**
   * The latest still-current staged intent, or `none` when it was cleared. Recovery
   * resolves this first, then the latest successfully committed fallback, then the legacy default.
   */
  readonly current: () => Effect.Effect<Snapshot>
  /**
   * Latest successful durable replacement in this application build. Distinct from
   * `staged.revision`: reservations, rejected candidates and direct staging never advance it,
   * so a per-location reader can tell whether it has seen the last committed document.
   */
  readonly committedRevision: () => Effect.Effect<number>
  /** Record a successful rename, never a reservation or rejected candidate. */
  readonly recordCommit: (revision: number) => Effect.Effect<void>
  /**
   * Direct process-local staging outside the update-owner flow: takes the next entry position,
   * publishes the override, and retires that position immediately, because there is no durable
   * commit it must order.
   */
  readonly stage: (value: ConfigModel.Selection | null) => Effect.Effect<number>
  /**
   * Reserve an update-owner entry position BEFORE validation. The position is independent of
   * when validation completes, so accepted commits serialize in entry order even when validation
   * finishes out of order.
   */
  readonly reserve: () => Effect.Effect<number>
  /**
   * Publish the validated selection or explicit clear under its reserved entry revision.
   * An older position never supersedes a newer accepted one, so late validation cannot
   * replace a newer current intent. Returns whether the revision became effective.
   */
  readonly stageValidated: (
    revision: number,
    value: ConfigModel.Selection | null,
  ) => Effect.Effect<boolean>
  /**
   * Wait until every earlier entry position has retired (committed, failed, or cancelled).
   * Interruptible: an interrupted wait removes its own waiter, and the owner's exit cleanup still
   * retires the position so later writers progress.
   */
  readonly awaitPredecessors: (revision: number) => Effect.Effect<void>
  /** Retire a reserved position on every exit path and release later writers it was holding. */
  readonly retire: (revision: number) => Effect.Effect<void>
  /** Clear the override only when the given revision is still the current one. */
  readonly clearIfCurrent: (revision: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FallbackRuntimeIntent") {}

const initial: Snapshot = { revision: 0, override: { type: "none" } }

type State = {
  readonly next: number
  // Highest revision whose durable rename actually succeeded in this build. Independent of
  // `staged.revision`: reserving an entry position or staging an intent proves nothing committed.
  readonly committed: number
  readonly staged: Snapshot
  // Entry positions still open: an open position holds every later entry until it retires.
  readonly open: ReadonlySet<number>
  // Waiters woken by any retirement; each re-checks its own predecessors.
  readonly waiters: readonly Deferred.Deferred<void>[]
}

const initialState: State = { next: 0, committed: 0, staged: initial, open: new Set(), waiters: [] }

export const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<State>(initialState)

  const current = () => SynchronizedRef.get(state).pipe(Effect.map((previous) => previous.staged))

  const committedRevision = () =>
    SynchronizedRef.get(state).pipe(
      Effect.map((previous) => previous.committed),
    )

  const recordCommit = (revision: number) =>
    SynchronizedRef.update(state, (previous): State => ({
      ...previous,
      committed: Math.max(previous.committed, revision),
    }))

  const stage = (value: ConfigModel.Selection | null) =>
    SynchronizedRef.modify(state, (previous) => {
      const revision = previous.next + 1
      const next: State = {
        ...previous,
        next: revision,
        staged: { revision, override: { type: "some", value } },
      }
      return [revision, next] as const
    })

  const reserve = () =>
    SynchronizedRef.modify(state, (previous) => {
      const revision = previous.next + 1
      const next: State = {
        ...previous,
        next: revision,
        open: new Set([...previous.open, revision]),
      }
      return [revision, next] as const
    })

  const stageValidated = (revision: number, value: ConfigModel.Selection | null) =>
    SynchronizedRef.modify(state, (previous) => {
      // An older entry position cannot supersede a newer accepted one.
      if (revision <= previous.staged.revision) return [false, previous] as const
      const next: State = { ...previous, staged: { revision, override: { type: "some", value } } }
      return [true, next] as const
    })

  const retire = (revision: number) =>
    SynchronizedRef.modify(state, (previous) => {
      if (!previous.open.has(revision)) return [[], previous] as const
      const waiters = previous.waiters
      const next: State = {
        ...previous,
        open: new Set([...previous.open].filter((open) => open !== revision)),
        waiters: [],
      }
      return [waiters, next] as const
    }).pipe(
      Effect.flatMap((waiters) =>
        Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), { discard: true }),
      ),
    )

  const awaitPredecessors = (revision: number): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        while (true) {
          const waiter = Deferred.makeUnsafe<void>()
          const blocked = yield* SynchronizedRef.modify(state, (previous) => {
            if (![...previous.open].some((open) => open < revision)) return [false, previous] as const
            return [true, { ...previous, waiters: [...previous.waiters, waiter] }] as const
          })
          if (!blocked) return
          yield* restore(Deferred.await(waiter)).pipe(
            // A cancelled waiter leaves no leaked registration; its own owner retires the
            // reservation through the update's exit cleanup, so later writers still progress.
            Effect.onInterrupt(() =>
              SynchronizedRef.update(state, (previous) => ({
                ...previous,
                waiters: previous.waiters.filter((item) => item !== waiter),
              })),
            ),
          )
        }
      }),
    )

  const clearIfCurrent = (revision: number) =>
    SynchronizedRef.update(state, (previous): State =>
      previous.staged.revision === revision
        ? { ...previous, staged: { ...previous.staged, override: { type: "none" } } }
        : previous,
    )

  return {
    current,
    committedRevision,
    recordCommit,
    stage,
    reserve,
    stageValidated,
    awaitPredecessors,
    retire,
    clearIfCurrent,
  } satisfies Interface
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
