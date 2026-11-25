import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigModel } from "@opencode/schema/config/model"
import { createRoot } from "solid-js"
import { ConfigConfirmationFailure } from "@/runtime/server/config-outcome"
import {
  IDLE_CLAIMS,
  accountForPair,
  admitsExchange,
  compensationAwaitsOutcome,
  compensationOf,
  COMPOSER_EXCHANGE_IDLE,
  composerFallbackStatus,
  createExchangePhase,
  exchangeHoldsAttempt,
  exchangeHoldsModels,
  exchangeObservedAfter,
  exchangeWroteExactly,
  pairVariant,
  payloadChoice,
  promotesPair,
  resolveSessionComposerSelection,
  sameModelIdentity,
  swapModelPair,
  transitionActionClaim,
  transitionPairExchange,
  type ActionClaims,
  type ComposerExchangeEffect,
  type ComposerFallbackStatus,
  type ComposerExchangeEvent,
  type ComposerExchangePhase,
} from "./selection"
import { fallbackUpdateState } from "../../providers/models/fallback-update"
import type { ServerSync } from "@/runtime/server/sync"
import {
  createModelSelectionState,
  selectSession,
  transitionModelSelection,
  type ModelSelectionEffect,
  type ModelSelectionEvent,
} from "../../providers/models/selection-machine"

/** `ServerSync.refreshConfig` must be awaitable, not a fire-and-forget refetch: `fallback-update.ts` releases a committed
 *  override only once the authoritative GET it returns has finished, and a `() => void` callback would let that chain settle
 *  the display while the read is still in flight — or, on a failed read, release it at all. `import type` keeps this a
 *  compile-time pin, and the annotation is what fails to check if the callback ever loses its `Promise<void>`. The
 *  deferred-GET cases above are the runtime half of the same contract. */
const awaitableConfigRefresh: (sync: ServerSync) => Promise<void> = (sync) => sync.refreshConfig()

void awaitableConfigRefresh

/** The driver re-dispatches the machine's `compensation.issued` effect as that event (`composer/selection.ts`'s
 *  `runEffect`), and these cases take the same path: the tag is CHECKED, so an effect that is not one fails the case
 *  out loud instead of being cast into one (T028's re-dispatch). */
const issuedEvent = (effect: ComposerExchangeEffect): ComposerExchangeEvent => {
  if (effect.type !== "compensation.issued")
    throw new Error(`expected a compensation.issued effect, got ${effect.type}`)

  return effect
}

describe("resolveSessionComposerSelection", () => {
  test("prefers durable Session state over historical message metadata", () => {
    expect(
      resolveSessionComposerSelection(
        { agent: "build", model: { id: "claude", providerID: "anthropic" } },
        { agent: "review", model: { modelID: "gpt", providerID: "openai" } },
      ),
    ).toEqual({
      agent: "build",
      model: { modelID: "claude", providerID: "anthropic", variant: undefined },
    })
  })

  test("falls back to historical metadata while durable state is unavailable", () => {
    expect(
      resolveSessionComposerSelection(undefined, {
        agent: "review",
        model: { modelID: "gpt", providerID: "openai", variant: "high" },
      }),
    ).toEqual({
      agent: "review",
      model: { modelID: "gpt", providerID: "openai", variant: "high" },
    })
  })
})

describe("swapModelPair", () => {
  test("swaps supported model variants symmetrically", () => {
    expect(
      swapModelPair({
        primary: { model: { providerID: "p1", modelID: "m1" }, variant: "high" },
        fallback: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
        primaryVariants: ["high"],
        fallbackVariants: ["fast"],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
      fallback: { model: { providerID: "p1", modelID: "m1" }, variant: "high" },
    })
  })

  test("clears variants unsupported by the destination and clears fallback without a primary", () => {
    expect(
      swapModelPair({
        fallback: { model: { providerID: "p2", modelID: "m2" }, variant: "fast" },
        primaryVariants: [],
        fallbackVariants: [],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: undefined },
      fallback: null,
    })
  })

  test("keeps provider-default variants unset when swapping models", () => {
    expect(
      swapModelPair({
        primary: { model: { providerID: "p1", modelID: "m1" } },
        fallback: { model: { providerID: "p2", modelID: "m2" } },
        primaryVariants: ["high"],
        fallbackVariants: ["fast"],
      }),
    ).toEqual({
      primary: { model: { providerID: "p2", modelID: "m2" }, variant: undefined },
      fallback: { model: { providerID: "p1", modelID: "m1" }, variant: undefined },
    })
  })

  test("does nothing when no fallback is selected", () => {
    expect(swapModelPair({ primaryVariants: [], fallbackVariants: [] })).toBeUndefined()
  })
})

describe("fallback update ordering", () => {
  test("a delayed older rejection from another composer cannot roll back newer client intent", async () => {
    const requests: { resolve: () => void; reject: (error: Error) => void }[] = []
    const writes: string[] = []
    const failures: unknown[] = []
    const key = {}
    const write = (value: string) => {
      writes.push(value)
      return new Promise<void>((resolve, reject) => requests.push({ resolve, reject }))
    }
    const firstComposer = fallbackUpdateState(key, write)
    const secondComposer = fallbackUpdateState(key, write)
    const failed = (error: unknown) => failures.push(error)

    firstComposer.save("older", failed)
    secondComposer.save("newer", failed)
    expect(firstComposer.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests[0]!.reject(new Error("older update failed"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toEqual(["older", "newer"])
    expect(secondComposer.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    expect(failures).toEqual([])

    requests[1]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(firstComposer.optimistic()).toBeUndefined()
  })

  test("an older success does not clear a newer composer selection", async () => {
    const requests: { resolve: () => void; reject: (error: Error) => void }[] = []
    const key = {}
    const state = fallbackUpdateState(key, (value: string) => new Promise<void>((resolve, reject) => requests.push({ resolve, reject })))
    state.save("older", () => {})
    state.save("newer", () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests[0]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.optimistic()).toMatchObject({ revision: 2, value: "newer" })
    requests[1]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.optimistic()).toBeUndefined()
  })

  test("a rejection naming a durable commit re-reads the source instead of asserting the pre-write value", async () => {
    // The wire said this write's value IS the document: only publication or notification failed. Restoring the pre-write
    // value would display a document the server no longer holds, so the chain reports once, asks for a source read, and
    // holds the override until that read has landed. A rejection with no code keeps the rollback.
    const committed = {
      _tag: "UnknownError",
      message: "Committed /global/opencode.json without publishing it to protected readers",
      code: "CONFIG_COMMITTED_BUT_UNPUBLISHED",
    }

    const reported: unknown[] = []
    const reads: string[] = []
    let recorded = "before"

    let finishReconcile!: () => void
    const reconciled = new Promise<void>((resolve) => {
      finishReconcile = resolve
    })

    const chain = fallbackUpdateState<string>(
      {},
      () => {
        // The commit landed: the source holds this value now, and the outcome still failed.
        recorded = "after"

        return Promise.reject(committed)
      },
      () => {
        reads.push("get")

        return reconciled
      },
    )

    chain.save("after", (cause) => void reported.push(cause))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reported).toEqual([committed])
    expect(reads).toEqual(["get"])
    // The override still names the value the source holds, so nothing showed the pre-write document meanwhile.
    expect(chain.optimistic()).toMatchObject({ revision: 1, value: "after" })

    finishReconcile()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The re-read landed, so the display falls through to the source's own value: the committed one.
    expect(chain.optimistic()).toBeUndefined()
    expect(recorded).toBe("after")

    // No code means nothing was committed: the old bytes are the authority, so the override drops at once and the
    // source is read again for no reason it cannot answer.
    const ordinaryReads: string[] = []
    const ordinary = fallbackUpdateState<string>(
      {},
      () => Promise.reject(new Error("malformed JSON or JSONC document")),
      () => {
        ordinaryReads.push("get")

        return Promise.resolve()
      },
    )
    const ordinaryReported: unknown[] = []
    ordinary.save("zsh", (cause) => void ordinaryReported.push(cause))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ordinaryReported).toHaveLength(1)
    expect(ordinary.optimistic()).toBeUndefined()
    expect(ordinaryReads).toEqual([])
  })

  test("a committed failure of an explicit disable leaves the fallback disabled", async () => {
    // `null` is a value, not an absence: the write that disables answers with a committed code, and the source's own
    // answer is `null` too, so neither the override nor the re-read re-enables a fallback the user switched off.
    let recorded: string | null = "zsh"
    // Read through a closure so the assertion sees the source's declared type rather than what a callback assigned.
    const sourceValue = () => recorded
    let finishReconcile!: () => void
    const reconciled = new Promise<void>((resolve) => {
      finishReconcile = resolve
    })

    const chain = fallbackUpdateState<string | null>(
      {},
      () => {
        recorded = null

        return Promise.reject({
          _tag: "UnknownError",
          message: "Committed and published /global/opencode.json with an incomplete completion step",
          code: "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
        })
      },
      () => reconciled,
    )

    chain.save(null, () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The disable stays displayed while the source is being read again: the field is not treated as unset.
    expect(chain.optimistic()).toMatchObject({ revision: 1, value: null })

    finishReconcile()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The override yields to the re-read, and the re-read says the same thing: disabled.
    expect(chain.optimistic()).toBeUndefined()
    expect(sourceValue()).toBe(null)
  })

  test("a confirmation that failed after the write landed is not read as a rollback", async () => {
    // `sync.updateConfig` awaits its confirming re-read, so a rejection carrying `ConfigConfirmationFailure` says the
    // PATCH answered 204 and only the confirmation is unknown. Same handling as a committed code: read the source
    // again, never fall back to the value written over.
    const reads: string[] = []
    const chain = fallbackUpdateState<string>(
      {},
      () => Promise.reject(new ConfigConfirmationFailure(new Error("confirming GET failed"))),
      () => {
        reads.push("get")

        return Promise.resolve()
      },
    )

    chain.save("zsh", () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toEqual(["get"])
    expect(chain.optimistic()).toBeUndefined()
  })

  test("an older committed outcome arriving after a newer intent acts on nothing", async () => {
    // FR-018 read with the committed identities: B answers after C was issued, so it may neither clear C's override nor
    // start a re-read that would settle the display on B's document.
    const reads: string[] = []
    const chain = fallbackUpdateState<string>(
      {},
      (value: string) =>
        value === "B"
          ? Promise.reject({
              _tag: "UnknownError",
              message: "Committed and published with an incomplete completion step",
              code: "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
            })
          : new Promise<never>(() => {}),
      () => {
        reads.push("get")

        return new Promise<void>(() => {})
      },
    )

    chain.save("B", () => {})
    chain.save("C", () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chain.optimistic()).toMatchObject({ revision: 2, value: "C" })
    expect(reads).toEqual([])
  })

  // ── The reconciliation GET is awaited, not merely issued (T019: the caller's read decides when a committed override
  // releases) ────────────────────────────────────────────────────────────────────────────────────────────────────────
  //
  // These cases wait on real signals rather than a clock. `issued(n)` waits until the chain has STARTED its n-th write
  // (the callback records it, so no microtask count is guessed), and `answered(x)` waits for `x`'s outcome AS THE CHAIN
  // SEES IT: `fallback-update.ts:47-52` adopts `x` and attaches its own reaction before a test can attach one, so the
  // test's reaction is queued behind the chain's and its own follow-on work (`Promise.try`-style instant settles) drains
  // first. That ordering is what makes every "still holding" assertion below about settled state rather than a reaction
  // that has not run yet.

  type Pending = {
    readonly promise: Promise<void>
    readonly resolve: () => void
    readonly reject: (cause: unknown) => void
  }

  const pending = (): Pending => {
    let resolve!: () => void
    let reject!: (cause: unknown) => void

    const promise = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })

    return { promise, resolve, reject }
  }

  /** One chain's write queue, read as a signal: which values were sent, the n-th write once issued, its outcome once seen. */
  const writeQueue = () => {
    const written: string[] = []
    const started: Pending[] = []
    let waiting: Array<(write: Pending) => void> = []

    const write = (value: string) => {
      written.push(value)

      const request = pending()
      started.push(request)

      const resume = waiting
      waiting = []
      resume.forEach((ok) => void ok(request))

      return request.promise
    }

    return {
      written,
      write,
      issued: async (index: number): Promise<Pending> => {
        while (started.length <= index) await new Promise<Pending>((resume) => void waiting.push(resume))

        return started[index]!
      },
      answered: async (outcome: Pending) => {
        await outcome.promise.then(
          () => undefined,
          () => undefined,
        )
      },
    }
  }

  const committedFailure = {
    _tag: "UnknownError",
    message: "Committed /global/opencode.json without publishing it to protected readers",
    code: "CONFIG_COMMITTED_BUT_UNPUBLISHED",
  } as const

  test("an in-flight reconciliation GET holds the committed value, and the completed read settles the display", async () => {
    // A refetch is not a read: while the GET is in flight the display must keep naming the value the server committed,
    // and only a COMPLETED authoritative read may release the override. One report, one read, no write in between.
    const queue = writeQueue()
    const reads: string[] = []
    const reported: unknown[] = []
    // What the document holds, as the GET's own read writes it (`sync.refreshConfig` feeds `globalStore.config`).
    let document = "before"

    // The GET's completion, handed over by the chain rather than raced: `reconciling` says the read was issued.
    const get = pending()
    let getIssued!: () => void
    const reconciling = new Promise<void>((ok) => {
      getIssued = ok
    })

    const chain = fallbackUpdateState<string>(
      {},
      (value: string) => queue.write(value),
      () => {
        reads.push("get")
        getIssued()

        return get.promise
      },
    )

    chain.save("committed", (cause) => void reported.push(cause))
    const bWrite = await queue.issued(0)
    bWrite.reject(committedFailure)
    await queue.answered(bWrite)
    await reconciling

    expect(reported).toEqual([committedFailure])
    expect(reads).toEqual(["get"])
    // The GET has not landed, so the value on display is still the committed one, not the older document.
    expect(chain.optimistic()).toMatchObject({ revision: 1, value: "committed" })
    expect(document).toBe("before")

    // The authoritative read completes and reports the document it returned.
    document = "committed"
    get.resolve()
    await queue.answered(get)

    // Only now does the override release, into a source that agrees with it.
    expect(chain.optimistic()).toBeUndefined()
    expect(document).toBe("committed")
    expect(reads).toEqual(["get"])
    expect(queue.written).toEqual(["committed"])
  })

  test("a reconciliation GET that fails keeps the committed value visible rather than exposing the older one", async () => {
    // A failed GET is not a confirmed source: revealing what this write replaced would assert a durable commit was
    // undone. The value stays visible as unconfirmed, reported once, and nothing is written back or retried.
    const queue = writeQueue()
    const reads: string[] = []
    const reported: unknown[] = []

    const get = pending()
    let getIssued!: () => void
    const reconciling = new Promise<void>((ok) => {
      getIssued = ok
    })

    const chain = fallbackUpdateState<string>(
      {},
      (value: string) => queue.write(value),
      () => {
        reads.push("get")
        getIssued()

        return get.promise
      },
    )

    chain.save("committed", (cause) => void reported.push(cause))
    const bWrite = await queue.issued(0)
    bWrite.reject(committedFailure)
    await queue.answered(bWrite)
    await reconciling

    expect(chain.optimistic()).toMatchObject({ revision: 1, value: "committed" })

    get.reject(new Error("confirming GET failed"))
    await queue.answered(get)

    expect(chain.optimistic()).toMatchObject({ revision: 1, value: "committed" })
    // One report for the write, no second report for the failed read, and no compensation behind it.
    expect(reported).toEqual([committedFailure])
    expect(queue.written).toEqual(["committed"])
    expect(reads).toEqual(["get"])
  })

  test("a committed failure with no reconciliation read available does not release the override", async () => {
    // `Promise.try(() => state.reconcile?.())` used to settle instantly when the caller had no read at all, clearing
    // the override and showing the older cached document as though the source had confirmed it. No read is not a read.
    const queue = writeQueue()
    const reported: unknown[] = []

    const chain = fallbackUpdateState<string>({}, (value: string) => queue.write(value))
    chain.save("committed", (cause) => void reported.push(cause))

    const bWrite = await queue.issued(0)
    bWrite.reject(committedFailure)
    await queue.answered(bWrite)

    expect(reported).toEqual([committedFailure])
    expect(chain.optimistic()).toMatchObject({ revision: 1, value: "committed" })
    expect(queue.written).toEqual(["committed"])
  })

  test("a reconciliation GET landing after a newer intent cannot settle the display on the older document", async () => {
    // FR-018 read through the awaited GET: B's read is still in flight when C is issued, so B's completion may neither
    // clear C's override nor re-write or re-report C, whatever document its read happened to return.
    const queue = writeQueue()
    const reported: unknown[] = []
    const reads: string[] = []

    const get = pending()
    let getIssued!: () => void
    const reconciling = new Promise<void>((ok) => {
      getIssued = ok
    })

    const chain = fallbackUpdateState<string>(
      {},
      (value: string) => queue.write(value),
      () => {
        reads.push("get")
        getIssued()

        return get.promise
      },
    )

    chain.save("B", (cause) => void reported.push(cause))
    const bWrite = await queue.issued(0)
    bWrite.reject(committedFailure)
    await queue.answered(bWrite)
    await reconciling

    chain.save("C", (cause) => void reported.push(cause))
    expect(chain.optimistic()).toMatchObject({ revision: 2, value: "C" })

    // B's read lands now. Its own revision is no longer current, so it answers with nothing.
    get.resolve()
    await queue.answered(get)

    expect(chain.optimistic()).toMatchObject({ revision: 2, value: "C" })
    expect(reported).toEqual([committedFailure])
    expect(queue.written).toEqual(["B", "C"])
    expect(reads).toEqual(["get"])

    // C's own write then lands, and only that releases the override: the state is live rather than frozen.
    const cWrite = await queue.issued(1)
    cWrite.resolve()
    await queue.answered(cWrite)
    expect(chain.optimistic()).toBeUndefined()
  })

  test("a composer created after an earlier owner disposed still shares one optimistic override", () => {
    const key = {}
    const write = (value: string) => Promise.resolve(value)

    // One server sync keeps one override for every composer, and the composer that created it can go away with its tab.
    const first = createRoot((dispose) => {
      const composer = fallbackUpdateState(key, write)
      composer.save("older", () => {})
      return { override: composer.optimistic(), dispose }
    })

    expect(first.override).toMatchObject({ revision: 1, value: "older" })
    first.dispose()

    const second = createRoot((dispose) => {
      const composer = fallbackUpdateState(key, write)
      const left = composer.optimistic()
      composer.save("newer", () => {})
      return { left, override: composer.optimistic(), dispose }
    })

    // The later owner starts on the value the disposed owner left, and its own save still advances the shared state.
    expect(second.left).toMatchObject({ revision: 1, value: "older" })
    expect(second.override).toMatchObject({ revision: 2, value: "newer" })

    second.dispose()
  })

  // SC-008 with FR-015/FR-018/FR-019: ten consecutive selections whose writes are answered LATE — always after a
  // newer intent has been issued — nine of them rejected. The value on display stays the newest intent throughout,
  // because each machine drops only what its OWN token marks stale: the fallback chain's `revision`
  // (`fallback-update.ts:44-47`), the primary owner's commit `attempt` (`selection-machine.ts`), and the pair
  // phase's exchange `attempt`. Nothing here asserts a pair surviving a reload, which FR-019's honesty limit puts
  // outside these machines.
  test("ten consecutive selections answered late or failing suppress only inside their own layer", async () => {
    // The chain serializes its writes (`state.pending`), so one write starts only once the older one has answered:
    // every write below is answered AFTER the next selection was issued, which is the delay that makes a stale
    // outcome able to arrive at all. That queue is the test's clock, read off the chain rather than counted in
    // turns or slept through: `started` waits for the chain to ISSUE a save, and `answered` waits for that save's
    // own promise, behind which the chain's reaction to it — its revert and the caller's `failed` callback,
    // `fallback-update.ts:37-51` — has already run. Both helpers are used on the one write this table expects to
    // report (`reported` reaching 1 below), which is what stops the nine suppressed ones from passing vacuously.
    const key = {}
    const written: string[] = []

    type Save = {
      readonly value: string
      readonly promise: Promise<void>
      readonly resolve: () => void
      readonly reject: (cause: Error) => void
    }

    // The one save's answering pair, named so the queue hands it over as a contract rather than a shape repeated per
    // place it is written.
    type SaveToken = {
      readonly resolve: () => void
      readonly reject: (cause: Error) => void
    }

    const writes: Save[] = []
    let started: Array<(write: Save) => void> = []

    const chain = fallbackUpdateState(key, (value: string) => {
      written.push(value)

      let token!: SaveToken

      const promise = new Promise<void>((resolve, reject) => {
        token = { resolve, reject }
      })

      const write: Save = Object.freeze({ value, promise, ...token })

      writes.push(write)

      const waiting = started
      started = []
      waiting.forEach((resume) => resume(write))

      return promise
    })

    // The chain's `index`th save, once it has been issued. A queued waiter answers it, so a test can wait for a save
    // the chain has not started yet without guessing how many microtasks its own serialization takes.
    const issued = async (index: number): Promise<Save> => {
      while (writes.length <= index) await new Promise<Save>((resume) => void started.push(resume))

      return writes[index]!
    }

    // That save's outcome, as the chain sees it: awaiting the promise the chain was handed (through a derived one,
    // which is one queue slot behind the chain's own reaction) means its revert and its callback have run.
    const answered = async (index: number) => {
      await writes[index]!.promise.then(
        () => undefined,
        () => undefined,
      )
    }

    const reported: unknown[] = []
    const revisions: number[] = []

    // The pair phase and the driver's action claims, and the primary owner's machine, over the same ten intents.
    let phase: ComposerExchangePhase = createExchangePhase()
    let claims: ActionClaims = IDLE_CLAIMS
    let primaryState = createModelSelectionState({ status: "ready", sessions: {} })
    const primaryEffects: ModelSelectionEffect[] = []
    const slot = (modelID: string) => ({ model: { providerID: "provider", modelID }, variant: undefined })

    for (let index = 1; index <= 10; index += 1) {
      chain.save(`m${index}`, (cause) => void reported.push(cause))

      // The previous selection's write answers only now, so a newer revision is already current in the chain. The
      // chain is waited for, not slept through: its own reaction to that save has run when `answered` returns, which
      // is what makes the `reported` assertions below about suppression rather than about an outcome that has not
      // arrived yet.
      if (index > 1) {
        const previous = await issued(index - 2)

        if (index <= 9) previous.reject(new Error(`selection ${index - 1} rejected`))
        else previous.resolve()
        await answered(index - 2)
      }

      // The same intent in the other two machines: a tracked commit for the primary half, then the pair exchange this
      // selection's own write supersedes when the next one arrives.
      for (const event of [
        {
          type: "edited",
          sessionID: "ses_pair",
          edit: {
            type: "model",
            agent: "build",
            choice: { providerID: "provider", modelID: `m${index}`, variant: { type: "named", value: "high" } },
          },
        },
        {
          type: "commit.tracked",
          sessionID: "ses_pair",
          target: { agent: "build", model: { providerID: "provider", modelID: `m${index}` }, variant: "high" },
          visible: true,
          durable: undefined,
        },
      ] satisfies ModelSelectionEvent[]) {
        const next = transitionModelSelection(primaryState, event)

        primaryState = next.state
        primaryEffects.push(...next.effects)
      }

      phase = transitionPairExchange(phase, { type: "slot.changed" }).state
      claims = transitionActionClaim(claims, {
        type: "model.written",
        half: "fallback",
        sessionID: "ses_pair",
        model: { providerID: "provider", modelID: `m${index}` },
        value: undefined,
        named: false,
      }).claims
      phase = transitionPairExchange(phase, {
        type: "exchange.claimed",
        attempt: index,
        half: "fallback",
        restore: { primary: slot(`p${index}`), fallback: slot(`f${index}`) },
        visible: { primary: true, fallback: true },
        failure: undefined,
      }).state
      revisions.push(chain.optimistic()!.revision)
      // This intent's own save is the chain's next queue slot: waiting for it to be ISSUED behind the older attempt's
      // outcome is what proves the chain ran every write in order instead of suppressing one, so the `written`
      // assertion at the end of this table cannot be a coincidence of timing (FR-015 read with FR-019).
      await issued(index - 1)
    }

    // Every write ran, in issue order, while the override the two owners show is the tenth intent: no older value is
    // ever offered while a newer one waits (FR-015).
    expect(written).toEqual(Array.from({ length: 10 }, (_, index) => `m${index + 1}`))
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(chain.optimistic()).toMatchObject({ revision: 10, value: "m10" })

    // The chain reports none of the nine rejections that arrived: its own `revision` token says they are not the
    // current value, so no older save clears a newer override or reaches a caller (`fallback-update.ts:44-47`).
    expect(reported).toEqual([])

    // The pair machine drops the same nine for its own reason — the exchange attempt, not the chain's revision: a
    // `write.rejected` naming an attempt other than the one in flight reports and restores nothing (FR-018).
    for (let index = 1; index <= 9; index += 1)
      expect(transitionPairExchange(phase, { type: "write.rejected", side: "fallback", attempt: index, cause: new Error("stale") }).effects, `attempt ${index}`)
        .toEqual([])

    // The primary machine's token is its commit `attempt`, and nothing else substitutes for it: a cancel naming any
    // older attempt leaves the tenth commit waiting with its own ack timer armed, while each newer selection cleared
    // only the timer its own write replaced.
    for (let index = 1; index <= 9; index += 1)
      expect(transitionModelSelection(primaryState, { type: "commit.cancelled", sessionID: "ses_pair", attempt: index }))
        .toEqual({ state: primaryState, effects: [] })
    expect(selectSession(primaryState, "ses_pair")).toMatchObject({ phase: "awaiting-ack", attempt: 10 })
    expect(primaryEffects.filter((effect) => effect.type === "ack-timer.start")).toHaveLength(10)
    expect(primaryEffects.filter((effect) => effect.type === "ack-timer.clear")).toHaveLength(9)

    // The tenth write answers while it is still the current one: the chain reverts its own override and reports once,
    // and the exchange still in flight issues its compensation, which carries the machine's single report.
    const current = await issued(9)

    current.reject(new Error("selection 10 rejected"))
    await answered(9)
    expect(reported).toHaveLength(1)
    expect(chain.optimistic()).toBeUndefined()

    const compensated = transitionPairExchange(phase, {
      type: "write.rejected",
      side: "fallback",
      attempt: 10,
      cause: new Error("selection 10 rejected"),
    })

    expect(compensated.effects.filter((effect) => effect.type === "report")).toHaveLength(1)
    // A rejected config write leaves that slot to its own revert, so only the primary half is put back (FR-032).
    expect(compensated.effects.filter((effect) => effect.type.startsWith("restore")))
      .toEqual([{ type: "restore.primary", pair: slot("p10") }])
    // The attempt is released as it compensates, so no later outcome of it can start a second one (FR-032's limit).
    expect(transitionPairExchange(compensated.state, { type: "write.rejected", side: "fallback", attempt: 10, cause: new Error("again") }))
      .toEqual({ state: compensated.state, effects: [] })
    // And the layer boundaries still hold afterwards: the chain's revert left the primary's ack wait alone, and
    // superseding nine exchanges never suppressed a chain revision.
    expect(selectSession(primaryState, "ses_pair")).toMatchObject({ phase: "awaiting-ack", attempt: 10 })
    expect(compensated.state.type).toBe("idle")
  })
})

describe("exchange pairing", () => {
  const model = (providerID: string, modelID: string) => ({ providerID, modelID })

  test("each model keeps its own variant in both directions, variant ignored for identity", () => {
    // FR-009/FR-007: the pair is (B with m2's variant, A with m1's variant) whichever slot the user acted in.
    expect(
      swapModelPair({
        primary: { model: model("p1", "m1"), variant: "high" },
        fallback: { model: model("p2", "m2"), variant: "fast" },
        primaryVariants: ["high", "low"],
        fallbackVariants: ["fast", "high"],
      }),
    ).toEqual({
      primary: { model: model("p2", "m2"), variant: "fast" },
      fallback: { model: model("p1", "m1"), variant: "high" },
    })

    expect(sameModelIdentity(model("p1", "m1"), { ...model("p1", "m1") })).toBe(true)
    expect(sameModelIdentity(model("p1", "m1"), model("p1", "m2"))).toBe(false)
  })

  test("a variant the destination does not offer lands on nothing, so that model's own default applies", () => {
    // FR-010: `pairVariant` is the one selector both the exchange's writes and the picker's preview read.
    expect(pairVariant(["low", "medium"], "high")).toBeUndefined()
    expect(pairVariant(["low", "medium"], "medium")).toBe("medium")
    expect(pairVariant([], "medium")).toBeUndefined()
    expect(pairVariant(["medium"], undefined)).toBeUndefined()
  })

  test("an off or inactive fallback exchanges nothing, and never empties the primary slot", () => {
    // FR-006: nothing to promote, so this is a no-op rather than a refusal.
    expect(swapModelPair({ primary: { model: model("p1", "m1") }, primaryVariants: ["high"], fallbackVariants: [] })).toBeUndefined()

    const status = composerFallbackStatus({
      enabled: true,
      primary: model("p1", "m1"),
      fallback: model("p1", "m1"),
    })

    expect(status).toBe("inactive")
  })

  test("the three displayed states come from the two owners, and a variant-only fallback is not a second model", () => {
    // FR-029/FR-030/FR-031: `off` is an explicit none, `inactive` repeats the primary model, `model` is usable.
    expect(composerFallbackStatus({ enabled: false, primary: model("p1", "m1"), fallback: model("p2", "m2") })).toBe("off")
    expect(composerFallbackStatus({ enabled: true, primary: undefined, fallback: undefined })).toBe("off")
    expect(composerFallbackStatus({ enabled: true, primary: model("p1", "m1"), fallback: model("p2", "m2") })).toBe("model")
  })

  // A recorded config fallback decoded through the schema the config owner reads
  // (`selection.tsx:812` `Schema.decodeUnknownOption(ConfigModel.Selection)`), so the values below are the wire
  // values core also reads (`fallback` in `config.entries()`), not a stand-in for them.
  const recorded = (short: string) => Schema.decodeUnknownSync(ConfigModel.Selection)(short)
  // The two readings the driver passes to `composerFallbackStatus` (`composer/selection.ts:701-705`), as LOCAL
  // projections of what the config owner publishes: `enabled()` is `raw() !== null` (`selection.tsx:893`) and `key()`
  // is provider + model with the variant dropped (`selection.tsx:814`). This table pins the PURE rule those readings
  // feed; the owner calling its own methods is exercised at owner level (`test-browser/fixtures/model-selection.ts`)
  // and by the e2e chip keepers, and is not claimed here. Recovery reads the recorded value itself, so the pair of
  // readings is where the two sides have to agree.
  const enabledOf = (value: ConfigModel.Selection | null) => value !== null

  // The brand types (`Provider.ID`/`Model.ID`) are string brands, and both owners hand plain `{providerID, modelID}`
  // pairs to the rule (`ModelKey`, `selection.tsx:814`), so the readings below are compared as plain strings.
  const keyOf = (value: ConfigModel.Selection | null) =>
    value ? { providerID: String(value.providerID), modelID: String(value.model) } : undefined

  const variantOf = (value: ConfigModel.Selection | null) =>
    value?.variant === undefined ? undefined : String(value.variant)

  test("identity rule, app pure rule (composerFallbackStatus) and core recovery (session/runner/llm.ts modelKey): a variant-only fallback is one model", () => {
    // FR-031/SC-013 as one rule read twice. Core decides with `modelKey` (`session/runner/llm.ts:277` = provider +
    // model, variant ignored) and answers the variant-only pair by continuing the retry on the model the Session
    // already serves, in the scenario named `does not treat a variant of the active model as a distinct fallback
    // model`; the composer answers the same pair with `inactive`, in `composerFallbackStatus`. Rows: [recorded
    // fallback, primary model, verdict].
    const rows: readonly [string, string | null, readonly [string, string], ComposerFallbackStatus][] = [
      // A fallback that repeats the primary's model under another variant: one model, so nothing to recover to.
      ["variant-only copy of the primary", "p1/m1#low", ["p1", "m1"], "inactive"],
      // The identical spelling is the same case, and stays inactive rather than becoming a usable pair.
      ["identical provider, model and variant", "p1/m1#high", ["p1", "m1"], "inactive"],
      // The same modelID under another provider is two models: recovery has somewhere to go, the chip shows a model.
      ["same modelID under another provider", "p2/m1#high", ["p1", "m1"], "model"],
      // A recorded fallback with no variant at all is still another model.
      ["recorded with no variant", "p2/m2", ["p1", "m1"], "model"],
      // An explicit "None" has no fallback value to name.
      ["explicit None", null, ["p1", "m1"], "off"],
    ]

    for (const [, short, [providerID, modelID], status] of rows) {
      const value = short === null ? null : recorded(short)
      expect(composerFallbackStatus({ enabled: enabledOf(value), primary: model(providerID, modelID), fallback: keyOf(value) })).toBe(status)
    }

    // `inactive` and `off` are never interchangeable: the collision has a stored value this action must leave
    // untouched, and `off` has nothing stored, which is why the two render different copy and write different
    // amounts (FR-029/FR-030).
    const collision = model("p1", "m1")
    expect(composerFallbackStatus({ enabled: enabledOf(recorded("p1/m1#low")), primary: collision, fallback: keyOf(recorded("p1/m1#low")) })).toBe(
      "inactive",
    )
    expect(composerFallbackStatus({ enabled: enabledOf(null), primary: collision, fallback: keyOf(null) })).toBe("off")
    expect(keyOf(recorded("p1/m1#low"))).toEqual(collision)
    expect(keyOf(null)).toBeUndefined()
  })

  test("value agreement on the recorded config value, app pure rule (composerFallbackStatus) and core's Config service (Config.latest entries fallback): provider, model and variant travel together", () => {
    // FR-035/FR-025 read narrowly and honestly. Four separate things prove this, and only two of them are here:
    //   1. HERE, the app's PURE rule applied to a value decoded through the schema the config owner reads.
    //   2. The config OWNER reading that recorded value: `test-browser/fixtures/model-selection.ts`.
    //   3. Core producing it from the real Config service with NO runtime retry intent staged: the scenario
    //      `serves the fallback the Config service records, with its variant, and keeps an explicit off apart from
    //      the legacy value` (`packages/core/test/session-runner.test.ts`) asserts the served model of the attempt
    //      that recorded value dispatches, variant included.
    //   4. The browser display against what `GET /api/config` answers: the e2e case
    //      `the fallback chip names the value the config endpoint answers, in a configured, a repeated, and a saved
    //      none`.
    // The variant is ignored only where identity is decided (`modelKey`, `key()`). The runtime-intent scenario
    // `serves the recorded fallback value with its variant as the attempt it dispatches` proves a DIFFERENT contract
    // — an accepted `FallbackRuntimeIntent` override — and is kept as independent evidence, not as this proof.
    const value = recorded("p1/m1#high")
    const shown = keyOf(value)!

    // Reassembling what the chip names (`key()` plus the variant offered beside it, `variant.configured()`) gives back
    // the recorded value with wire field names and all — the same `providerID`/`model`/`variant` triple core reads
    // through its Config service. `modelKey` drops the variant when it decides identity, and ONLY there.
    expect(keyOf(value)).toEqual({ providerID: "p1", modelID: "m1" })
    expect(variantOf(value)).toBe("high")
    expect({ providerID: String(value.providerID), model: String(value.model), variant: variantOf(value) }).toEqual({
      providerID: "p1",
      model: "m1",
      variant: "high",
    })

    // One recorded value serves both verdicts, unchanged: while the primary repeats it the chip is inactive, and a
    // primary change re-arms the same recorded value — variant and all — with no click (FR-029/FR-021).
    expect(composerFallbackStatus({ enabled: enabledOf(value), primary: model("p1", "m1"), fallback: shown })).toBe("inactive")
    expect(composerFallbackStatus({ enabled: enabledOf(value), primary: model("p2", "m9"), fallback: shown })).toBe("model")
    expect(value).toEqual(recorded("p1/m1#high"))
  })
})

describe("exchange phase", () => {
  const entry = (providerID: string, modelID: string, variant?: string) => ({
    model: { providerID, modelID },
    variant,
  })

  const A = entry("p1", "m1", "high")
  const B = entry("p2", "m2", "fast")
  const C = entry("p3", "m3")

  const claim = (attempt: number, half: "primary" | "fallback" = "primary") => ({
    type: "exchange.claimed" as const,
    attempt,
    half,
    restore: { primary: A, fallback: B },
    visible: { primary: true, fallback: false },
    failure: 3,
  })

  const written = (attempt: number, half: "primary" | "fallback" = "primary") => ({
    type: "pair.written" as const,
    attempt,
    applied: { primary: B, fallback: A },
  })

  const failed = { message: "record save rejected" }
  const config = { message: "config rejected" }

  /**
   * A failed save's `attempted` payload, built the way the record store writes it (`persist.ts:24` serializes the
   * document, and `selection.tsx:304` puts one Session's entry under its ID): `{ session: { [id]: { choice } } }`, where
   * a variant is `{ type: "named", value }` or the default marker for nothing named.
   */
  const choiceOf = (session: string, item: typeof A) =>
    JSON.stringify({
      session: {
        [session]: {
          choice: {
            providerID: item.model.providerID,
            modelID: item.model.modelID,
            variant: item.variant === undefined ? { type: "default" } : { type: "named", value: item.variant },
          },
        },
      },
    })

  /** The same document with an extra Session's entry, which is how a collision with another Session is built. */
  const withOther = (session: string, item: typeof A, extra: Record<string, typeof A>) =>
    JSON.stringify({
      session: {
        [session]: {
          choice: {
            providerID: item.model.providerID,
            modelID: item.model.modelID,
            variant: item.variant === undefined ? { type: "default" } : { type: "named", value: item.variant },
          },
        },
        ...Object.fromEntries(
          Object.entries(extra).map(([id, entry]) => [
            id,
            {
              choice: {
                providerID: entry.model.providerID,
                modelID: entry.model.modelID,
                variant: entry.variant === undefined ? { type: "default" } : { type: "named", value: entry.variant },
              },
            },
          ]),
        ),
      },
    })

  const observed = (attempted: string, id = 4) => ({
    type: "observed" as const,
    id,
    attempted,
    session: "session-1",
    cause: failed,
  })

  /** Claim the exchange, let its pair land, and read the document's failure of it: the sequence the driver runs. */
  const failingRecord = () => {
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const applied = transitionPairExchange(claimed, written(1)).state

    return { claimed, applied, waiting: transitionPairExchange(applied, observed(choiceOf("session-1", B))) }
  }

  test("a refusal never claims: the phase stays the idle singleton and no owner is asked for anything", () => {
    // FR-020: the driver checks each target against the guard of the slot it is moving into before it claims, so the
    // machine sees no event at all and the pair on display is untouched.
    const before = createExchangePhase()

    expect(transitionPairExchange(before, { type: "slot.changed" })).toEqual({ state: before, effects: [] })
    expect(transitionPairExchange(before, { type: "write.rejected", side: "primary", attempt: 1, cause: undefined }))
      .toEqual({ state: before, effects: [] })
  })

  test("the claim carries only the pre-exchange pair and both targets' visibility, which the compensation reuses", () => {
    // FR-026/FR-033: the phase stores the values to put back plus the visibility needed to put them back hidden.
    const next = transitionPairExchange(createExchangePhase(), claim(1))

    expect(next.state).toEqual({
      type: "exchanging",
      attempt: 1,
      half: "primary",
      restore: { primary: A, fallback: B },
      applied: undefined,
      visible: { primary: true, fallback: false },
      failure: 3,
      // Every half this attempt writes into may be reverted by its own owner, once.
      reverts: { primary: true, fallback: true },
    })
    expect(next.effects).toEqual([])
    expect(Object.isFrozen(next.state)).toBe(true)
  })

  test("a rejected config write reports once, re-writes the primary half only, and waits for that compensation's outcome", () => {
    // FR-032 direction 1: the config chain reverted its own slot by dropping its optimistic override, so only the
    // primary half goes back through its owner (T025/T026).
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const after = transitionPairExchange(claimed, { type: "write.rejected", side: "fallback", attempt: 1, cause: config })

    expect(after.effects).toEqual([
      { type: "report", cause: config },
      { type: "compensation.issued", side: "primary", attempt: 1, failure: 3, cause: config },
      { type: "restore.primary", pair: A },
    ])
    expect(after.state).toEqual(createExchangePhase())

    // The driver re-dispatches the issue as an event: the record store saves asynchronously (`persist.ts:118-135`),
    // so the phase holds the compensation rather than claiming it landed, and the document's next observation is
    // what can answer it. Only the half actually written is accounted for.
    const waiting = transitionPairExchange(after.state, issuedEvent(after.effects[1]))

    expect(waiting.state).toEqual({
      type: "compensating",
      compensation: { attempt: 1, issued: { primary: true, fallback: false }, failure: 3, cause: config },
    })
    expect(waiting.effects).toEqual([])
    expect(compensationOf(waiting.state)?.issued.primary).toBe(true)
    expect(compensationOf(waiting.state)?.issued.fallback).toBe(false)

    // A second rejection for the released attempt writes and reports nothing: no loop can form.
    expect(transitionPairExchange(waiting.state, { type: "write.rejected", side: "fallback", attempt: 1, cause: config }))
      .toEqual({ state: waiting.state, effects: [] })
    // The compensation is never itself compensated: its own rejection only ends the attempt. Attribution names the
    // half whose owner reported it and the attempt that write belongs to, so a rejection of a half this compensation
    // never issued, or of another attempt, acts on nothing (T028).
    expect(transitionPairExchange(waiting.state, { type: "compensation.failed", side: "fallback", attempt: 1 }))
      .toEqual({ state: waiting.state, effects: [] })
    expect(transitionPairExchange(waiting.state, { type: "compensation.failed", side: "primary", attempt: 2 }))
      .toEqual({ state: waiting.state, effects: [] })

    const ended = transitionPairExchange(waiting.state, { type: "compensation.failed", side: "primary", attempt: 1 })

    expect(ended.effects).toEqual([])
    expect(ended.state).toEqual({
      type: "unresolved",
      side: "primary",
      compensation: { attempt: 1, issued: { primary: true, fallback: false }, failure: 3, cause: config },
    })
    expect(transitionPairExchange(ended.state, { type: "write.rejected", side: "primary", attempt: 1, cause: config }))
      .toEqual({ state: ended.state, effects: [] })
    expect(transitionPairExchange(ended.state, { type: "compensation.failed", side: "primary", attempt: 1 }))
      .toEqual({ state: ended.state, effects: [] })
  })

  test("a rejection naming a durable commit reports once and writes nothing back", () => {
    // The config chain's own outcome already answered that rejection by re-reading its source (`fallback-update.ts`):
    // the document on disk holds what this exchange wrote, so putting the pair back would be a fresh write asserting a
    // durable commit was undone. The code, read off the generated error rather than the status, is the whole difference
    // from the case above, and it is what stops both halves from being restored.
    const committed = {
      _tag: "UnknownError",
      message: "Committed /global/opencode.json without publishing it to protected readers",
      code: "CONFIG_COMMITTED_BUT_UNPUBLISHED",
    }

    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const after = transitionPairExchange(claimed, { type: "write.rejected", side: "fallback", attempt: 1, cause: committed })

    expect(after.effects).toEqual([{ type: "report", cause: committed }])
    expect(after.effects.filter((effect) => effect.type.startsWith("compensation") || effect.type.startsWith("restore")))
      .toEqual([])
    expect(after.state).toEqual(createExchangePhase())

    // The other committed identity reads the same way, and a `code` outside the two literals names no committed state
    // the client knows, so that cause keeps its compensation.
    for (const code of ["CONFIG_COMMITTED_BUT_UNPUBLISHED", "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE"] as const)
      expect(
        transitionPairExchange(claimed, {
          type: "write.rejected",
          side: "fallback",
          attempt: 1,
          cause: { ...committed, code },
        }).effects,
      ).toEqual([{ type: "report", cause: { ...committed, code } }])

    const invented = { ...committed, code: "CONFIG_COMMITTED_BUT_MAYBE_NOT" }
    expect(
      transitionPairExchange(claimed, { type: "write.rejected", side: "fallback", attempt: 1, cause: invented }).effects
        .filter((effect) => effect.type.startsWith("restore")),
    ).toEqual([{ type: "restore.primary", pair: A }])

    // Supersession outranks it: a committed outcome naming an attempt the phase no longer holds still acts on nothing.
    const newer = transitionPairExchange(createExchangePhase(), claim(2)).state
    expect(transitionPairExchange(newer, { type: "write.rejected", side: "fallback", attempt: 1, cause: committed }))
      .toEqual({ state: newer, effects: [] })
  })

  test("a confirmation that failed after the write landed reports once and compensates neither half", () => {
    // The other half of `configNeedsReconciliation`: `sync.updateConfig` awaits its confirming re-read (`sync.tsx`), so a
    // rejection carrying `ConfigConfirmationFailure` says the PATCH answered 204 and only the read-back is unknown. The
    // pair this exchange wrote is on disk, so putting it back would be a fresh write asserting a durable commit was undone
    // — the same prohibition the committed codes above carry. Checking only the codes let this rejection restore both halves.
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const failure = new ConfigConfirmationFailure(new Error("confirming GET failed"))

    const result = transitionPairExchange(claimed, {
      type: "write.rejected",
      side: "fallback",
      attempt: 1,
      cause: failure,
    })

    expect(result.effects).toEqual([{ type: "report", cause: failure }])

    for (const type of ["restore.primary", "restore.fallback", "compensation.issued"] as const)
      expect(result.effects.filter((effect) => effect.type === type).length, type).toBe(0)

    expect(result.state).toEqual(createExchangePhase())

    // Negative control, same claim and same slot: an uncoded failure names no durable commit, so it keeps the ordinary
    // precommit compensation the boundary requires.
    const ordinary = transitionPairExchange(claimed, {
      type: "write.rejected",
      side: "fallback",
      attempt: 1,
      cause: config,
    })

    expect(ordinary.effects).toEqual([
      { type: "report", cause: config },
      { type: "compensation.issued", side: "primary", attempt: 1, failure: 3, cause: config },
      { type: "restore.primary", pair: A },
    ])

    // And a confirmation gap naming an attempt the phase no longer holds is completely inert: it reports nothing, and
    // neither compensates nor clears the newer exchange.
    const newer = transitionPairExchange(createExchangePhase(), claim(2)).state
    expect(transitionPairExchange(newer, { type: "write.rejected", side: "fallback", attempt: 1, cause: failure }))
      .toEqual({ state: newer, effects: [] })
  })

  test("a failed record write reports once and re-writes both halves through their owners", () => {
    // FR-032 direction 2 (T025/T026): a rejected record save reverted the whole document, so the half that landed
    // cleared its own optimistic override and both halves have to be written again. The evidence is the document's
    // observation, not a per-write callback, and it arrives as `observed`.
    const { applied, waiting } = failingRecord()

    expect(waiting.effects).toEqual([
      { type: "report", cause: failed },
      { type: "compensation.issued", side: "primary", attempt: 1, failure: 4, cause: failed },
      { type: "restore.primary", pair: A },
      { type: "compensation.issued", side: "fallback", attempt: 1, failure: 4, cause: failed },
      { type: "restore.fallback", pair: B },
    ])
    // The attempt is released BEFORE the writes, so a compensation can never start another one; the phase then waits
    // on the outcomes, which the driver's dispatch of each `compensation.issued` puts back in place. BOTH halves the
    // driver actually wrote are tracked: the second issue is not discarded because a wait is already open, or an
    // issued write would go unaccounted for while its outcome arrives.
    expect(waiting.state).toEqual(createExchangePhase())
    expect(exchangeHoldsAttempt(waiting.state, 1)).toBe(false)

    const primary = transitionPairExchange(waiting.state, issuedEvent(waiting.effects[1]))
    const holding = transitionPairExchange(primary.state, issuedEvent(waiting.effects[3]))

    expect(compensationOf(holding.state)?.failure).toBe(4)
    expect(compensationOf(holding.state)?.issued).toEqual({ primary: true, fallback: true })
    // The same half issued twice, or an issue naming a different attempt, adds nothing: at most one compensation per
    // attempt, and no endless chain of restorations.
    expect(transitionPairExchange(holding.state, issuedEvent(waiting.effects[1]))).toEqual({
      state: holding.state,
      effects: [],
    })
    expect(
      transitionPairExchange(holding.state, { type: "compensation.issued", side: "fallback", attempt: 2, failure: 4, cause: failed }),
    ).toEqual({ state: holding.state, effects: [] })
    // One report per attempt: the machine issues the report effect once, whatever the compensation then does.
    expect(waiting.effects.filter((effect) => effect.type === "report").length).toBe(1)

    // A rejection of either issued half ends the attempt unresolved, naming the half that reported, and reports nothing
    // further: the failure that started the attempt was already the one report's cause (T028).
    for (const side of ["primary", "fallback"] as const) {
      const failed2 = transitionPairExchange(holding.state, { type: "compensation.failed", side, attempt: 1 })

      expect(failed2.effects).toEqual([])
      expect(failed2.state).toMatchObject({ type: "unresolved", side })
    }

    // The pair this attempt wrote is what the phase holds, which is what the driver's watcher compares the display
    // against to decide whether a write is its own (FR-015).
    expect(exchangeWroteExactly(applied, { primary: B, fallback: A })).toBe(true)
  })

  test("an observation admits nothing unless the payload carries this exchange's pair for this composer's Session", () => {
    // T004's admission rule, all three conditions: the payload must name the model AND the variant this exchange
    // wrote, for THIS composer's Session key, and the observation must not have been cleared since. The pair below
    // wrote B into the primary slot of Session `session-1`, behind observation 3.
    const { applied } = failingRecord()

    for (const attempted of [
      // (i) a payload from an earlier save window: it still holds the pre-exchange pair, so it predates this exchange.
      choiceOf("session-1", A),
      // a payload naming this model but not the variant this exchange wrote there.
      choiceOf("session-1", { ...B, variant: "high" }),
      // (iii) another document or store: no entry for this composer's Session at all.
      choiceOf("some-other-session", B),
      // another Session in the same document carrying this pair, while this composer's entry holds something else.
      withOther("session-1", C, { "session-9": B }),
      // (ii) an observation the document has since cleared by a save that landed: no payload to carry anything.
      "",
    ]) {
      const dropped = transitionPairExchange(applied, observed(attempted))

      expect(dropped.effects).toEqual([])
      expect(dropped.state).toEqual(applied)
      expect(exchangeHoldsAttempt(dropped.state, 1)).toBe(true)
    }

    // The payload that does carry it admits it, and the variant marker for "nothing named" decodes to nothing.
    expect(transitionPairExchange(applied, observed(choiceOf("session-1", B))).effects.length).toBe(5)
    expect(payloadChoice(choiceOf("session-1", C), "session-1")).toEqual({
      model: { providerID: "p3", modelID: "m3" },
      variant: undefined,
    })
    expect(payloadChoice("not json", "session-1")).toBeUndefined()
    expect(payloadChoice(choiceOf("session-1", B), "")).toBeUndefined()
    // Payload containment is only condition (a): an id that is not newer than the one the attempt claimed behind
    // (3 here) admits nothing on its own, which is what `exchangeObservedAfter` guards.
    expect(exchangeObservedAfter(applied, 4)).toBe(true)
    expect(exchangeObservedAfter(applied, 3)).toBe(false)
    expect(exchangeObservedAfter(applied, 2)).toBe(false)
    expect(exchangeObservedAfter(COMPOSER_EXCHANGE_IDLE, 4)).toBe(false)
    // An owner with no document of its own (a draft's mirrored selection, `failure: undefined`) can never use one.
    const mirrored = transitionPairExchange(createExchangePhase(), { ...claim(1), failure: undefined }).state
    expect(exchangeObservedAfter(mirrored, 1)).toBe(false)
    expect(transitionPairExchange(mirrored, observed(choiceOf("session-1", B)))).toEqual({ state: mirrored, effects: [] })
  })

  test("a superseded attempt never compensates, and a waiting compensation is dropped rather than re-issued", () => {
    // FR-018 outranks FR-032: a discarded `restore` is never written into a newer world (T027).
    const { waiting } = failingRecord()
    const holding = transitionPairExchange(waiting.state, issuedEvent(waiting.effects[1])).state

    for (const event of [
      { type: "slot.changed" } as const,
      { type: "target.changed" } as const,
      { type: "record.changed" } as const,
      { type: "disposed" } as const,
    ]) {
      const dropped = transitionPairExchange(holding, event)

      expect(dropped.state).toEqual(createExchangePhase())
      expect(dropped.effects).toEqual([])
      // Nothing about the dropped compensation can act afterwards: the observation it was waiting on answers nothing
      // once the phase no longer holds it, which is what keeps a superseded attempt from restoring or re-writing.
      expect(compensationAwaitsOutcome(dropped.state, 5)).toBe(false)
      expect(transitionPairExchange(dropped.state, observed(choiceOf("session-1", A), 5)).effects).toEqual([])
    }

    // One compensation per attempt: the same half issued again, or an issue naming an attempt that is not the one
    // in flight, changes nothing, so a rejection cannot queue an endless chain of restorations (FR-018/FR-032). A
    // second HALF of the attempt already in flight is the only thing that may extend it.
    expect(transitionPairExchange(holding, { type: "compensation.issued", side: "primary", attempt: 1, failure: 4, cause: failed }))
      .toEqual({ state: holding, effects: [] })
    expect(transitionPairExchange(holding, { type: "compensation.issued", side: "fallback", attempt: 2, failure: 4, cause: failed }))
      .toEqual({ state: holding, effects: [] })
    expect(compensationOf(transitionPairExchange(holding, { type: "compensation.issued", side: "fallback", attempt: 1, failure: 4, cause: failed }).state)?.issued)
      .toEqual({ primary: true, fallback: true })

    // A late outcome for the dropped attempt neither restores nor re-writes anything.
    expect(transitionPairExchange(holding, { type: "write.rejected", side: "primary", attempt: 1, cause: failed }))
      .toEqual({ state: holding, effects: [] })
  })

  test("the compensation's own outcome: a newer failure of the same document ends it unresolved with one report", () => {
    // FR-032's third case (SC-010, T028): the values put back did not stick either. Nothing retries, the report
    // already issued is not repeated, and the terminal phase keeps what it was waiting on so a view can say the pair
    // on display may not be durable.
    const { waiting } = failingRecord()
    const holding = transitionPairExchange(waiting.state, issuedEvent(waiting.effects[1])).state

    // A save that landed clears the document's observation: an observation that has since cleared can be evidence
    // of nothing (T004's condition (ii)), and it answers a waiting compensation with nothing either.
    expect(transitionPairExchange(holding, { type: "record.changed" })).toEqual({
      state: createExchangePhase(),
      effects: [],
    })

    // An observation that is not strictly newer than the one this compensation was issued behind (4) says nothing.
    expect(transitionPairExchange(holding, { ...observed(choiceOf("session-1", A)), id: 4 }))
      .toEqual({ state: holding, effects: [] })
    expect(transitionPairExchange(holding, { ...observed(choiceOf("session-1", A)), id: 3 }))
      .toEqual({ state: holding, effects: [] })

    // A strictly newer one is its outcome: the attempt ends unresolved, and no report is added, because the failure
    // that started the attempt was already the one report's cause (T028). The record document answers the write to
    // its OWN half, which is what the terminal phase names.
    const ended = transitionPairExchange(holding, { ...observed(choiceOf("session-1", A)), id: 5 })

    expect(ended.effects).toEqual([])
    expect(ended.state).toEqual({
      type: "unresolved",
      side: "primary",
      compensation: { attempt: 1, issued: { primary: true, fallback: false }, failure: 4, cause: failed },
    })
    expect(compensationAwaitsOutcome(holding, 5)).toBe(true)
    expect(compensationAwaitsOutcome(holding, 4)).toBe(false)
    expect(compensationAwaitsOutcome(createExchangePhase(), 5)).toBe(false)
  })

  test("a record observation answers only a compensation that wrote to that half", () => {
    // Attribution again: a compensation that re-wrote only the config half is answered by that owner's own outcome
    // callback, never by a newer failure of the Session document, whose payload says nothing about a config write.
    const idle = transitionPairExchange(createExchangePhase(), { type: "compensation.issued", side: "fallback", attempt: 1, failure: 4, cause: failed })

    expect(idle.state).toMatchObject({ type: "compensating" })
    expect(compensationOf(idle.state)?.issued).toEqual({ primary: false, fallback: true })

    for (const id of [5, 9]) {
      expect(transitionPairExchange(idle.state, { ...observed(choiceOf("session-1", B)), id })).toEqual({
        state: idle.state,
        effects: [],
      })
    }

    // Its own owner does answer it, and nothing else does afterwards.
    expect(transitionPairExchange(idle.state, { type: "compensation.failed", side: "fallback", attempt: 1 }))
      .toMatchObject({ state: { type: "unresolved", side: "fallback" }, effects: [] })
  })

  test("the stale sequence: A/B, exchange to B/A, select C, then the old exchange fails, settling C/B", () => {
    // FR-018 outranks FR-032 once superseded (T010/T026's required case). The pair below moves only by writes the
    // machine asked for: none is emitted for the dropped attempt, so the fallback slot's own last recorded value (B)
    // survives its rejection and C stays in the primary slot.
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const applied = transitionPairExchange(claimed, written(1)).state

    // The user selects C: a newer write, which drops the pending exchange.
    const superseded = transitionPairExchange(applied, { type: "slot.changed" })
    expect(superseded.state).toEqual(createExchangePhase())
    expect(superseded.effects).toEqual([])

    // A, B are never written back: a compensation would resurrect values that are not the newest intent's.
    expect(exchangeHoldsAttempt(superseded.state, 1)).toBe(false)
    expect(exchangeHoldsModels(superseded.state, { primary: C, fallback: A })).toBe(false)

    // The old attempt's record failure arriving afterwards can neither restore nor report (T026).
    const late = transitionPairExchange(superseded.state, observed(choiceOf("session-1", B)))
    expect(late.effects).toEqual([])
    expect(late.state).toEqual(createExchangePhase())

    // A later successful action's own exchange is unaffected by the old attempt's outcome.
    const second = transitionPairExchange(superseded.state, claim(2))
    expect(second.state.type).toBe("exchanging")
    expect(exchangeHoldsAttempt(second.state, 1)).toBe(false)
    expect(exchangeHoldsAttempt(second.state, 2)).toBe(true)
  })

  test("any newer write to either slot drops the pending exchange without compensating", () => {
    // FR-018: a variant-only write, an agent cycle or another window's selection all reach the same event, because
    // the driver watches the pair rather than the call sites.
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const applied = transitionPairExchange(claimed, written(1)).state

    for (const event of [
      { type: "slot.changed" } as const,
      { type: "target.changed" } as const,
      { type: "record.changed" } as const,
      { type: "disposed" } as const,
    ]) {
      const dropped = transitionPairExchange(applied, event)

      expect(dropped.state).toEqual(createExchangePhase())
      expect(dropped.effects).toEqual([])

      // A late outcome for the dropped attempt writes nothing into the newer world.
      expect(transitionPairExchange(dropped.state, { type: "write.rejected", side: "primary", attempt: 1, cause: failed }))
        .toEqual({ state: dropped.state, effects: [] })
    }
  })

  test("the exchange's own writes are its own: the pair on display releases the attempt, and a variant in between refines it", () => {
    // FR-015/FR-036: the driver dispatches `pair.written` before the writes so they can be recognised as the action
    // already in flight, and the pair matching what this exchange wrote is what releases it. A variant the picker
    // named for a model this action chose refines that pair instead of superseding it, and a model change does.
    const claimed = transitionPairExchange(createExchangePhase(), claim(1)).state
    const applied = transitionPairExchange(claimed, written(1)).state

    expect(exchangeWroteExactly(applied, { primary: B, fallback: A })).toBe(true)
    expect(exchangeWroteExactly(applied, { primary: { ...B, variant: "high" }, fallback: A })).toBe(false)
    expect(exchangeHoldsModels(applied, { primary: { ...B, variant: "high" }, fallback: A })).toBe(true)
    expect(exchangeHoldsModels(applied, { primary: C, fallback: A })).toBe(false)

    const refined = transitionPairExchange(applied, {
      type: "pair.refined",
      attempt: 1,
      applied: { primary: { ...B, variant: "fast" }, fallback: A },
    })

    expect(exchangeWroteExactly(refined.state, { primary: { ...B, variant: "fast" }, fallback: A })).toBe(true)
    // A refinement that changes a model is not this action's write: it never reaches this event, the driver's claim
    // rejects it first, so the machine refuses it too.
    expect(transitionPairExchange(applied, { type: "pair.refined", attempt: 1, applied: { primary: C, fallback: A } }))
      .toEqual({ state: applied, effects: [] })
    // A refinement for a superseded attempt does nothing.
    const superseded = transitionPairExchange(applied, { type: "slot.changed" }).state
    expect(transitionPairExchange(superseded, { type: "pair.refined", attempt: 1, applied: { primary: B, fallback: A } }))
      .toEqual({ state: superseded, effects: [] })

    // The values a compensation puts back are exactly the pair the two owners held before this action wrote anything:
    // the models AND the variants they carried, untouched by the refinement. A rejected write of this action's own
    // pair has to restore THAT pair; putting a variant this action never wrote into that slot — the one carried
    // ACROSS the swap from the other model — would write a value nobody asked for and break FR-009's rule that each
    // model keeps its own variant (FR-011/FR-034 read with FR-032).
    const renamed = transitionPairExchange(applied, {
      type: "pair.refined",
      attempt: 1,
      applied: { primary: { ...B, variant: "xhigh" }, fallback: A },
    })

    expect(exchangeWroteExactly(renamed.state, { primary: { ...B, variant: "xhigh" }, fallback: A })).toBe(true)
    // Naming the same variant again refines nothing: the phase is returned unchanged, so a repeated follow-up is
    // deduplicated rather than treated as a newer action (FR-036). Naming `Default`, or a variant for the half the
    // user did not act in, is the same shape: `applied` moves, `restore` never does. A variant the destination does
    // not offer is resolved to nothing by `pairVariant` in the driver before it reaches this event (FR-010/FR-037).
    expect(transitionPairExchange(renamed.state, { type: "pair.refined", attempt: 1, applied: { primary: { ...B, variant: "xhigh" }, fallback: A } }))
      .toEqual({ state: renamed.state, effects: [] })

    for (const refined of [
      { primary: { ...B, variant: undefined }, fallback: A },
      { primary: B, fallback: { ...A, variant: "medium" } },
    ] as const) {
      const step = transitionPairExchange(applied, { type: "pair.refined", attempt: 1, applied: refined })

      expect(exchangeWroteExactly(step.state, refined), JSON.stringify(refined)).toBe(true)
      expect(step.state).toMatchObject({ restore: { primary: A, fallback: B } })
      expect(step.effects).toEqual([])
    }

    const restored = transitionPairExchange(renamed.state, { ...observed(choiceOf("session-1", { ...B, variant: "xhigh" })), id: 5 })
    expect(restored.effects.filter((effect) => effect.type.startsWith("restore")))
      .toEqual([
        { type: "restore.primary", pair: A },
        { type: "restore.fallback", pair: B },
      ])
    // The attempt stays pending until an outcome or a newer action ends it, which is what keeps FR-032's compensation
    // available while the record store's save window is still open (the record half's rejection can only arrive later).
    expect(transitionPairExchange(applied, { type: "compensation.failed", side: "primary", attempt: 1 }))
      .toEqual({ state: applied, effects: [] })
    expect(transitionPairExchange(applied, { type: "compensation.issued", side: "primary", attempt: 1, failure: 4, cause: failed }))
      .toEqual({ state: applied, effects: [] })
    // A newer model write supersedes it (FR-018), and nothing is written back for it afterwards.
    expect(transitionPairExchange(applied, { type: "slot.changed" }).state).toEqual(createExchangePhase())
  })

  test("an owner's revert is accounted for once, and a newer write naming that model again supersedes", () => {
    // FR-015 read with FR-018 (A3): the config chain puts its own recorded value back before it reports the rejection
    // (`fallback-update.ts:44`), so the display falling back to the model this action displaced is this attempt's
    // outcome — ONCE per slot. A later write that happens to name that same model is a newer action and must invalidate
    // the attempt, which is what `revert.absorbed` spends.
    const claims: ActionClaims = {
      primary: { sessionID: "session-1", model: B.model, value: "fast", named: true },
      fallback: { sessionID: "session-1", model: A.model, value: "high", named: true },
    }

    const held = (state: ComposerExchangePhase) => {
      if (state.type !== "exchanging") throw new Error(`expected an exchange in flight, got ${state.type}`)

      return state
    }

    const applied = held(transitionPairExchange(transitionPairExchange(createExchangePhase(), claim(1)).state, written(1)).state)

    // The pair on display is the one this action wrote: accounted for by the writes themselves, no revert spent.
    expect(accountForPair(applied, claims, { primary: B, fallback: A })).toEqual({
      accounted: true,
      reverts: { primary: false, fallback: false },
    })

    // The fallback owner's revert: the config slot is back to the model this action displaced.
    const revert = accountForPair(applied, claims, { primary: B, fallback: B })
    expect(revert.accounted).toBe(true)
    expect(revert.reverts).toEqual({ primary: false, fallback: true })

    // The driver spends the permission, and the attempt is still pending: a rejection may still compensate for it.
    const spent = transitionPairExchange(applied, { type: "revert.absorbed", primary: false, fallback: true })
    expect(spent.state).toMatchObject({ type: "exchanging", reverts: { primary: true, fallback: false } })
    expect(spent.effects).toEqual([])

    // The same value arriving again is no longer this attempt's revert: nothing else can account for it, so the
    // exchange is superseded and nothing is written back (a compensation would resurrect a pair nobody wants).
    expect(accountForPair(held(spent.state), claims, { primary: B, fallback: B }).accounted).toBe(false)
    expect(transitionPairExchange(spent.state, { type: "slot.changed" }).state).toEqual(createExchangePhase())

    // A revert of a half this attempt never got to display (no `pair.written` yet) is covered the same way, and the
    // permission for a half is only ever spent by that half.
    const claimed = held(transitionPairExchange(createExchangePhase(), claim(1)).state)
    expect(accountForPair(claimed, claims, { primary: A, fallback: A })).toEqual({
      accounted: true,
      reverts: { primary: true, fallback: false },
    })
    // Absorbing an already-spent revert changes nothing: the permission is not a counter to be decremented twice.
    expect(transitionPairExchange(spent.state, { type: "revert.absorbed", primary: false, fallback: true }))
      .toEqual({ state: spent.state, effects: [] })
  })

  test("the row clicked is only an exchange candidate when it names the other slot's model of an active pair", () => {
    // FR-001/FR-002 read with FR-006/FR-017/FR-029/FR-030: the guard is one predicate over the pair on display, so
    // an off fallback, an inactive pair, an empty slot, a model in neither slot, a model already in this slot, and a
    // variant-only action are all decided identically in both directions.
    const active = {
      primary: { providerID: "p1", modelID: "m1" },
      fallback: { providerID: "p2", modelID: "m2" },
    }

    const same = { providerID: "p1", modelID: "m1" }
    const neither = { providerID: "p9", modelID: "m9" }

    for (const half of ["primary", "fallback"] as const)
      expect(admitsExchange(active, { half, modelChange: true, model: half === "primary" ? active.fallback : active.primary, enabled: true })).toBe(true)

    for (const action of [
      // A model in neither slot is an ordinary selection.
      { half: "primary", modelChange: true, model: neither, enabled: true },
      // The model already in this slot: nothing to promote, and an A/A pair is not two records to swap.
      { half: "primary", modelChange: true, model: same, enabled: true },
      // A variant-only action never exchanges (FR-003).
      { half: "primary", modelChange: false, model: active.fallback, enabled: true },
      // An off fallback: the fallback picker choosing the primary model records nothing at all (FR-006/FR-017).
      { half: "fallback", modelChange: true, model: active.primary, enabled: false },
    ] as const)
      expect(admitsExchange(active, action), JSON.stringify(action)).toBe(false)

    // An inactive fallback — the same model in both slots — has no pair to promote in either direction (FR-029/FR-030
    // and FR-034's recovery rule), and an empty slot is the same no-op.
    expect(admitsExchange({ primary: same, fallback: same }, { half: "primary", modelChange: true, model: same, enabled: true })).toBe(false)
    expect(admitsExchange({ primary: undefined, fallback: active.fallback }, { half: "primary", modelChange: true, model: active.fallback, enabled: true })).toBe(false)
    expect(admitsExchange({ primary: active.primary, fallback: undefined }, { half: "fallback", modelChange: true, model: active.primary, enabled: true })).toBe(false)
  })

  test("a refused promotion is separated from an ordinary selection, so the driver can write nothing at all", () => {
    // B2's machine half: `promotesPair` says whether the row WOULD have moved the pair, and `admitsExchange` adds the
    // guards. A click in the first set that the second refuses must be a NO-OP rather than a write into one slot, so
    // an off fallback's picker choosing the primary model performs no model write, no variant write and no config
    // save, and an inherited or default A/A display is never treated as two records to swap (FR-006/FR-017/FR-029/FR-030
    // read with FR-003).
    const active = {
      primary: { providerID: "p1", modelID: "m1" },
      fallback: { providerID: "p2", modelID: "m2" },
    }

    const same = { providerID: "p1", modelID: "m1" }
    const neither = { providerID: "p9", modelID: "m9" }

    for (const [held, action, promotes] of [
      // The model in the other slot: a promotion in both directions.
      [active, { half: "primary", model: active.fallback }, true],
      [active, { half: "fallback", model: active.primary }, true],
      // A model in neither slot is an ordinary selection, in either slot.
      [active, { half: "primary", model: neither }, false],
      [active, { half: "fallback", model: neither }, false],
      // The model this slot already holds: ordinary, and not a promotion.
      [active, { half: "primary", model: same }, false],
      // An A/A display: the same model is both slots' own, so there is nothing to promote either way (FR-029/FR-030).
      [{ primary: same, fallback: same }, { half: "primary", model: same }, false],
      [{ primary: same, fallback: same }, { half: "fallback", model: same }, false],
      // An empty slot is promotion-SHAPED — the click names the other slot's model — while `admitsExchange` still
      // refuses it: a slot with nothing recorded has no record to put the other half back into (FR-017).
      [{ primary: undefined, fallback: active.fallback }, { half: "primary", model: active.fallback }, true],
      [{ primary: active.primary, fallback: undefined }, { half: "fallback", model: active.primary }, true],
    ] as const)
      expect(promotesPair(held, action), `${JSON.stringify(held)} ${JSON.stringify(action)}`).toBe(promotes)

    // The guard set is what turns a promotion into a refusal, and every refusal above is still a promotion-shaped
    // click the driver must swallow: an off fallback, and a variant-only action, which never promotes at all (FR-003).
    expect(promotesPair(active, { half: "fallback", model: active.primary })).toBe(true)
    expect(admitsExchange(active, { half: "fallback", modelChange: true, model: active.primary, enabled: false })).toBe(false)
    expect(promotesPair(active, { half: "primary", model: active.fallback })).toBe(true)
    expect(admitsExchange(active, { half: "primary", modelChange: false, model: active.fallback, enabled: true })).toBe(false)
  })
})

describe("action claims", () => {
  const model = { providerID: "p1", modelID: "m1" }
  const other = { providerID: "p2", modelID: "m2" }
  const C = { providerID: "p3", modelID: "m3" }

  const modelWrite = (
    value: string | undefined,
    options: { half?: "primary" | "fallback"; named?: boolean; sessionID?: string } = {},
  ) => ({
    type: "model.written" as const,
    half: options.half ?? "primary",
    sessionID: options.sessionID ?? "session-1",
    model,
    value,
    // Whether this one call NAMED a variant: the boundary the driver reads off the call (`Object.hasOwn` on its
    // `variant` option), never from a later callback.
    named: options.named ?? value !== undefined,
  })

  const variantWrite = (
    value: string | undefined,
    options: { half?: "primary" | "fallback"; model?: typeof model; sessionID?: string } = {},
  ) => ({
    type: "variant.observed" as const,
    half: options.half ?? "primary",
    sessionID: options.sessionID ?? "session-1",
    model: options.model ?? model,
    value,
  })

  test("one model write claims the intent, and the follow-up the pickers do belongs to that same action", () => {
    // A row click that names no variant leaves the variant unnamed, so the follow-up the picker does for that same
    // row (`select-dialog.tsx:536`) is the one this claim invited (FR-036/T014). The model write is itself a fresh
    // action, and the follow-up is the one that left the variant open.
    const after = transitionActionClaim(IDLE_CLAIMS, modelWrite(undefined))

    expect(after.intent).toBe(false)
    expect(after.claims.primary?.named).toBe(false)
    expect(after.claims.fallback).toBeUndefined()

    const followUp = transitionActionClaim(after.claims, variantWrite("high"))
    expect(followUp.intent).toBe(true)
    expect(followUp.claims.primary?.value).toBe("high")

    // The same value named again is deduplicated, not treated as a new action.
    expect(transitionActionClaim(followUp.claims, variantWrite("high")).intent).toBe(true)

    // A different variant after the action already named one is a separate, later action, which supersedes: T015's
    // asymmetry, and what keeps a variant-only action from being swallowed by a pending exchange it has no part in.
    const later = transitionActionClaim(followUp.claims, variantWrite("fast"))
    expect(later.intent).toBe(false)
    expect(later.claims.primary).toBeUndefined()
  })

  test("an intent that named its variant has no follow-up, so any later variant write supersedes it", () => {
    // This is A2's boundary, and why an exchange cannot swallow a later variant-only action: a pair exchange names the
    // variant the pair rule carried (`composer/selection.ts`'s claims), as does a row click whose flyout named one.
    // Nothing about the model, the Session or the ordering has to be guessed: the write that NAMED a value has said
    // its piece, and a further variant value for the same slot in the same model is a newer action (FR-018) even
    // when no model identity changes (T015).
    const exchangeClaim = transitionActionClaim(IDLE_CLAIMS, modelWrite("fast", { named: true }))

    expect(exchangeClaim.claims.primary?.named).toBe(true)
    // The value it named again: the same intent, deduplicated.
    expect(transitionActionClaim(exchangeClaim.claims, variantWrite("fast")).intent).toBe(true)

    // A different value, in the same slot, for the same model, in the same Session: a newer action.
    for (const value of ["high", "xhigh", undefined])
      expect(transitionActionClaim(exchangeClaim.claims, variantWrite(value)).intent, String(value)).toBe(false)
    // And the intent that left the variant unnamed still accepts its own follow-up, which is the asymmetry.
    const unnamed = transitionActionClaim(IDLE_CLAIMS, modelWrite(undefined, { named: false }))
    expect(transitionActionClaim(unnamed.claims, variantWrite("high")).intent).toBe(true)
  })

  test("a variant write for a model this action did not write is a newer action in both slots", () => {
    // The claim is scoped to the slot's exact model, so a flyout value for another model — the case where a stale
    // per-model preference would otherwise contradict the pair on display — cannot be absorbed by the action in
    // flight (FR-037 read with FR-018).
    const after = transitionActionClaim(IDLE_CLAIMS, modelWrite(undefined))

    for (const options of [{ model: other }, { model: C }, { half: "fallback" as const }, { sessionID: "session-2" } as const])
      expect(transitionActionClaim(after.claims, variantWrite("high", options)).intent, JSON.stringify(options)).toBe(false)
  })

  test("a variant-only action with no model write of its own supersedes the exchange in flight", () => {
    // T015: choosing a variant alone is a newer intent than an exchange still in flight, in either slot.
    for (const half of ["primary", "fallback"] as const)
      expect(transitionActionClaim(IDLE_CLAIMS, variantWrite("high", { half })).intent, half).toBe(false)

    // A claim recorded in one slot does not answer a write in the other.
    const primary = transitionActionClaim(IDLE_CLAIMS, modelWrite(undefined))
    expect(transitionActionClaim(primary.claims, variantWrite("high", { half: "fallback" })).intent).toBe(false)
  })

  test("an outcome of another Session's write claims nothing", () => {
    // FR-014/T027: the claim is keyed by the Session this composer belongs to, so a value arriving for a different
    // Session's entry is a newer action and the phase drops with its target.
    const after = transitionActionClaim(IDLE_CLAIMS, modelWrite(undefined, { sessionID: "session-1" }))

    expect(transitionActionClaim(after.claims, variantWrite("high", { sessionID: "session-2" })).intent).toBe(false)
    expect(transitionActionClaim(after.claims, variantWrite("high")).intent).toBe(true)
  })
})
