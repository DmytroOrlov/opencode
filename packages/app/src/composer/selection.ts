import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import type { ComposerControls } from "./adapter"
import { createFallbackModelSelection, useLocal, type ModelKey, type ModelSelection } from "@/providers/models/selection"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { useProviders } from "@/providers/catalog/providers"
import { useData } from "@/runtime/server/current"
import { normalizeAgentList, normalizeProviderList } from "@/runtime/server/global-sync/utils"
import { useModels } from "@/providers/models/models"
import {
  cycleModelVariant,
  durableVariantSelection,
  getConfiguredAgentVariant,
  INHERIT_VARIANT,
  promptVariantValue,
  recordedVariant,
  resolveModelVariant,
  variantSelectionFrom,
} from "@/providers/models/variant"
import type { AgentChoices } from "@/providers/models/selection-machine"
import { useComposerState } from "./persistence"
import { useConfiguredModel } from "@/providers/models/configured"
import { useGlobal } from "@/runtime/server/runtime"
import { composerModelLabelKey, composerModelLabels, composerProviderName } from "./model-label"
import { showToast } from "@/shell/notifications/toast"
import { formatServerError } from "@/runtime/server/errors"
import { useLanguage } from "@/runtime/i18n/language"
import {
  IDLE_CLAIMS,
  admitsExchange,
  compensationOf,
  accountForPair,
  createExchangePhase,
  composerFallbackStatus,
  pairVariant,
  promotesPair,
  sameModelIdentity,
  swapModelPair,
  transitionActionClaim,
  transitionPairExchange,
  type ActionClaimEvent,
  type ActionClaims,
  type ComposerExchangeEffect,
  type ComposerExchangeEvent,
  type ComposerExchangePhase,
  type ComposerExchangeSlot,
  type ExchangePair,
  type ExchangeSlotEntry,
} from "@/session/composer/selection"

/**
 * One model slot as the exchange sees it, both as owner and as the wrapped slot the composer hands out. Each owner
 * already refuses what it cannot select (`validModel` for the session model, `models.find` for the fallback) and can
 * answer for its own variant, so the driver asks the slot instead of guessing one rule for both. The optional `failed`
 * outcome is the owner's own per-write result (`fallback-update.ts:34`), not a second result channel.
 */
type ExchangeSlotSelection = ModelSelection & {
  // `variant` is the fallback owner's own combined write: one save naming the model and the variant it carries.
  set: (
    item: ModelKey | undefined,
    options?: { recent?: boolean; variant?: string | null; failed?: (cause: unknown) => void },
  ) => void
  variant: ModelSelection["variant"] & {
    set: (value: string | undefined, failed?: (cause: unknown) => void) => void
  }
}

export function createComposerControls(input: { model?: ModelSelection } = {}) {
  const local = useLocal()
  const sdk = useWorkspaceLocation()
  // The event stream this composer's Session is deleted on is the server's own, not the Location-scoped one: the
  // payload's `location` is optional (`client/promise/generated/types.ts:1301` `SessionDeleted.location?`), so a
  // Location-filtered `on` would silently answer nothing for the event this rule exists for. `providers/models/selection.tsx:565`
  // reads the same channel for the same reason.
  const serverSDK = useServerSDK()
  const data = useData()
  const language = useLanguage()
  const providers = useProviders(() => sdk().directory)
  const models = useGlobal().models
  // The Session this composer belongs to, and the server and workspace it belongs to. The record document is keyed by
  // this ID, so the failed-snapshot check below reads one session's entry rather than scanning every session's
  // (`payloadCarriesPair`), and a change to any of the three is a new target: an outcome of the old one can neither
  // compensate nor report into the new one (FR-014/FR-018).
  const params = useParams<{ serverKey?: string; id?: string }>()
  const sessionID = () => params.id || undefined
  const targetSignature = () => `${sdk().directory}\u001f${params.id ?? ""}\u001f${params.serverKey ?? ""}`

  const modelLabels = createMemo(() =>
    composerModelLabels(
      providers.all(),
      providers.connected().map((provider) => provider.id),
    ),
  )

  const loading = () => {
    const selection = input.model ?? local.model

    return (
      !selection.ready() || data.location.agent.list({ directory: sdk().directory }) === undefined || !providers.ready()
    )
  }

  // Until this Location's catalog loads, the default Location's or one visited earlier nearly always lists the same
  // model, so it names the chips; the loaded names then replace them in place.
  const preview = createMemo(() => {
    if (!loading()) return
    const expected = (input.model ?? local.model).preview?.()

    if (!expected) return

    const catalogs = providers.ready()
      ? [
          {
            all: providers.all(),
            connected: providers.connected().map((provider) => provider.id),
          },
        ]
      : [undefined, ...data.session.list().map((item) => item.location)].map((location) => {
          const provider = data.location.provider.list(location)
          const catalog = data.location.model.list(location)

          if (!provider || !catalog) return
          const normalized = normalizeProviderList(provider, catalog)

          return { all: normalized.all, connected: normalized.connected }
        })

    const match = catalogs
      .map(
        (catalog) =>
          catalog && {
            ...catalog,
            model: catalog.all.get(expected.model.providerID)?.models[expected.model.modelID],
          },
      )
      .find((item) => !!item?.model)

    if (!match?.model) return
    const variants = Object.keys(match.model.variants ?? {})

    return {
      provider: composerProviderName(expected.model.providerID, match.all, match.connected),
      model: match.model.name.replace("(latest)", "").trim(),
      label: composerModelLabels(match.all, match.connected).get(
        composerModelLabelKey(expected.model.providerID, expected.model.modelID),
      ),
      variants,
      variant:
        resolveModelVariant({
          variants,
          selected: expected.selected,
          configured: undefined,
          preferred: models.store.variant?.[`${expected.model.providerID}/${expected.model.modelID}`],
        }) ?? "default",
    }
  })

  // Every composer write path goes through these wrapped slots (FR-005): the callers that read
  // `controls().model.selection` directly (`session/composer/submit.ts`, `providers/models/unpaid.tsx:55`, the pickers)
  // obey the pair rule through them. Only `set`, `variant.set` and `variant.current` are replaced; `trackSessionCommit`,
  // `preview`, `recordFailure`, `ready`, `key`, `current`, `recent`, `favorite`, `list`, `cycle`, `visible` and
  // `setVisibility` stay exactly the owners', which is what keeps a submission's own model write working.
  const primary: ModelSelection = input.model ?? local.model
  const backup = createFallbackModelSelection()

  // A draft's selection mirrors this workspace's model-selection document rather than owning a record of its own
  // (`createComposerModelSelection` at `:236-242`), so that document's failure observation is never evidence that a
  // draft's own write was rejected. The config chain's per-write outcome still is.
  const mirrored = input.model !== undefined

  const variantsOf = (item: ModelKey) =>
    Object.keys(providers.all().get(item.providerID)?.models[item.modelID]?.variants ?? {})

  let phase: ComposerExchangePhase = createExchangePhase()
  let claimed = 0
  // At most one report per attempt (FR-032). Counted at the edge, not stored in the phase, which holds only the pair
  // and the values needed to put it back (FR-026).
  let reported = false

  /**
   * One report through the fallback owner's own toast copy, the copy its default outcome would have used
   * (`selection.tsx:791-797`): the pair exchange replaced that default with its own outcome callback, so the report
   * travels with it rather than through the app-wide storage notice, which cannot name a slot or an action (T028).
   */
  const reportOnce = (cause: unknown) => {
    if (reported) return

    reported = true
    showToast({
      title: language.t("common.requestFailed"),
      description: formatServerError(cause, language.t),
    })
  }

  const dispatch = (event: ComposerExchangeEvent) => {
    const next = transitionPairExchange(phase, event)

    if (next.state === phase && next.effects.length === 0) return

    phase = next.state
    next.effects.forEach(runEffect)
  }

  // A pair write and its compensation go to the owners themselves. The wrapped setters are the entry point a user
  // action comes through, and writing through them would re-enter the pair rule inside the exchange it started.
  const ownerOf = (half: ComposerExchangeSlot): ExchangeSlotSelection => half === "primary" ? primary : backup

  const slotEntry = (slot: ExchangeSlotSelection) => {
    const item = slot.key()

    return item ? { model: { providerID: item.providerID, modelID: item.modelID }, variant: slot.variant.current() } : undefined
  }

  const displayedPair = (): ExchangePair => ({ primary: slotEntry(primarySlot), fallback: slotEntry(fallbackSlot) })

  /**
   * Which write a user action owns, per slot: the driver's second machine, beside the pair phase. A picker writes twice
   * for one intent (the model row at `select-dialog.tsx:536`, then the variant its flyout names), and a pair exchange
   * writes across both slots, so the driver has to know which writes belong to the action already in flight. A variant
   * named as part of a model choice refines that action's intent (FR-036) instead of superseding it, while a later
   * variant-only action does supersede it (FR-018), and a variant that contradicts what the action named is a newer
   * action. Both the phase and this claim drop when the Session, server or workspace changes, and neither is ever
   * written back into a newer one (FR-014).
   */
  let claims: ActionClaims = IDLE_CLAIMS

  const claimAction = (event: ActionClaimEvent) => {
    const next = transitionActionClaim(claims, event)

    claims = next.claims

    return next.intent
  }

  const slotOf = (half: ComposerExchangeSlot): ExchangeSlotSelection => half === "primary" ? primarySlot : fallbackSlot

  /**
   * One slot's pair identity, read at the moment a write lands: the exact model and variant its picker wrote, never a
   * per-model preference, which is what `ModelSelection["variant"]`'s `current(item)` resolves for a model that is not
   * this slot's own and would otherwise contradict the selection this action wrote.
   */
  const slotSignature = (half: ComposerExchangeSlot) => {
    const slot = slotOf(half)
    const item = slot.key()

    return `${item?.providerID ?? ""}\u001f${item?.modelID ?? ""}\u001f${slot.variant.current() ?? ""}`
  }

  const pairSignature = () => `${slotSignature("primary")}\u001e${slotSignature("fallback")}`

  const runEffect = (effect: ComposerExchangeEffect) => {
    // The machine owns the one report per attempt, through the fallback owner's own copy of that copy: the pair rule
    // replaced the owner's default outcome, so the report travels with the exchange rather than through the app-wide
    // storage notice, which cannot name a slot or an action (T028).
    if (effect.type === "report") return void reportOnce(effect.cause)

    // A compensation the driver is about to write: the phase moves to `compensating`, which is what lets the document's
    // next observation answer it (the record store saves asynchronously, `persist.ts:118-135`).
    if (effect.type === "compensation.issued")
      return void dispatch({
        type: "compensation.issued",
        side: effect.side,
        attempt: effect.attempt,
        failure: effect.failure,
        cause: effect.cause,
      })

    if (effect.type === "restore.primary") return void restoreHalf("primary", effect.pair)

    if (effect.type === "restore.fallback") return void restoreHalf("fallback", effect.pair)
  }

  // A compensation re-uses the exchange's own writer, so both halves go back through their owners with the same
  // ordering, visibility bookkeeping and outcome plumbing, instead of a third write path (FR-026: no second store,
  // queue or transaction layer). It writes the pair the machine decided rather than re-entering the wrapped setter:
  // a compensation is decided state, not a new user action, so it must never start another exchange. A compensation
  // is never itself compensated: its own rejection only ends the attempt `unresolved`, and the report for the failure
  // that started it was already issued (T028).
  const restoreHalf = (half: ComposerExchangeSlot, entry: ExchangeSlotEntry | undefined) => {
    const slot = ownerOf(half)
    const item = entry ? { providerID: entry.model.providerID, modelID: entry.model.modelID } : undefined
    // A slot with nothing in it to put back has no model whose visibility could change.
    const visible = item ? slot.visible(item) : true
    // The attempt this write belongs to is the compensation the phase is holding: a restore effect always follows its
    // own `compensation.issued`, so the phase already names it. Attribution has to be exact — a rejection naming
    // another attempt, or a half that write was never issued for, is an older compensation's outcome and must not
    // end this one (T028).
    const attempt = compensationOf(phase)?.attempt

    writeSlot(half, entry, {
      recent: false,
      onRejected: () => {
        if (attempt === undefined) return

        dispatch({ type: "compensation.failed", side: half, attempt })
      },
    })

    if (item && visible === false) slot.setVisibility(item, false)
  }

  // One slot's half of a pair write: the model first, then the variant, because `variant.set` resolves from `current()`
  // (`selection.tsx:662`), so a variant can only land on the model already in that slot. `recent` moves only for the
  // model the user clicked (FR-003), never for the one being displaced.
  const writeSlot = (
    half: ComposerExchangeSlot,
    entry: ExchangeSlotEntry | undefined,
    options: { recent: boolean; onRejected: (cause: unknown) => void },
  ) => {
    const slot = ownerOf(half)
    const item = entry ? { providerID: entry.model.providerID, modelID: entry.model.modelID } : undefined

    // One outcome per half: the fallback owner's chain would otherwise toast through its default copy, and the exchange
    // dispatches the machine's `write.rejected` for either. Reporting is the machine's, not this callback's.
    const rejected = (cause: unknown) => options.onRejected(cause)

    // The fallback owner names the model and its variant in one write, so a pair's fallback half crosses in a single
    // config save: both halves of that half land together, and nothing re-reads a value that is still being written.
    if (half === "fallback") {
      slot.set(item, {
        recent: options.recent,
        variant: entry?.variant ?? null,
        failed: rejected,
      })

      return
    }

    // The session owner has no combined form of its own in the exchange's hands, so its half names the variant the pair
    // rule carried WITH the model (`selection.tsx:624`'s `set` writes both when the key is present), because `variant.set`
    // resolves from `current()` (`selection.tsx:662`): a variant can only land on the model already in that slot, and
    // naming one outright is what makes the write this action's own intent. That owner has no per-write outcome: a
    // rejected record of this half arrives as the document's failure observation, watched above (FR-032's second
    // direction). The variant write is the session's own selection; the per-model preference the owner also keeps is
    // that model's value, and `variant.current()` of the pair rule never consults it (FR-037).
    slot.set(item, { recent: options.recent, variant: entry?.variant ?? undefined })
  }


  // Wrapping is structural: the owner's own members are copied, so `submit.ts:357/:411/:555` and `unpaid.tsx:55` keep
  // working, while the three writes below are the only ones the pair rule governs (T013).
  const wrapSlot = <O extends ExchangeSlotSelection>(
    owner: O,
    half: ComposerExchangeSlot,
  ): O & ExchangeSlotSelection => {
    // Read lazily: both slots exist only after this call returns, and the pair rule needs the other one.
    const other = (): ExchangeSlotSelection => half === "primary" ? fallbackSlot : primarySlot

    // SAFETY: the three members written below replace exactly `set`, `variant.set` and `variant.current`, each with the
    // pair rule's own write typed as `ExchangeSlotSelection` declares it; every other member is `owner`'s, spread first
    // and untouched. TypeScript cannot see that through a spread of the generic `O`, so this restates the intersection
    // the function already promises rather than inventing a wider shape.
    return {
      ...owner,
      set: (item, options: { recent?: boolean; variant?: string | null } | undefined) => {
        if (item && !(owner.valid?.(item) ?? true)) return

        // A second "None" on a fallback that is already off has nothing to write: the config field already holds an
        // explicit `null`. It is not a newer intent either, so it must neither reach the owner nor supersede an
        // exchange that has nothing to do with it (FR-013 read with FR-018). The owner's derived `enabled()` is what
        // decides — `off` is its own state, never the absence of a configured fallback.
        if (half === "fallback" && item === undefined && !backup.enabled()) return

        // Whether this one call named a variant outright (`Object.hasOwn`, the convention the config owner already
        // uses at `selection.tsx:908`): that is the action's boundary, read off the call rather than guessed from a
        // later callback (FR-036 read with FR-018).
        const named = options !== undefined && Object.hasOwn(options, "variant")
        // The pair on display before this write, which is what the machine reads: the clicked model must be the OTHER
        // slot's, and this slot's own model must still be what it was, so the exchange is decided from the display and
        // not from a value the write already moved.
        const held = { primary: primarySlot.key(), fallback: fallbackSlot.key() }

        // Selecting the model that sits in the other slot is one promotion of the pair, not a write into one slot
        // (FR-001/FR-002/FR-008): the same row click in either picker exchanges, and no separate affordance exists.
        // Whether the pair MAY move is the machine's decision (`admitsExchange`): an off fallback, an inactive pair,
        // or an empty slot refuses, and a REFUSED promotion writes nothing at all — no model, no variant, no config
        // save, and no implicit enabling of a fallback the user switched off (FR-006/FR-017/FR-029/FR-030).
        if (item && promotesPair(held, { half, model: item })) {
          if (admitsExchange(held, { half, modelChange: true, model: item, enabled: backup.enabled() }))
            exchange(item, half, named ? { value: options?.variant ?? undefined } : undefined)

          // Either this action wrote its own pair, which the machine already claimed and released by its own
          // outcome, or it was REFUSED and wrote nothing at all: neither is a newer write, so nothing is
          // superseded, and a compensation of this very attempt is never started by it (FR-006/FR-017/FR-020/FR-026).
          return
        }

        // A click naming the model this slot already holds, wearing the variant it already wears, has nothing to write:
        // re-selecting A must not re-save A, promote a pair, or rewrite settings (FR-029/FR-030 read with FR-003).
        const current = half === "primary" ? held.primary : held.fallback

        if (
          item &&
          current &&
          sameModelIdentity(current, item) &&
          (!named || (options?.variant ?? undefined) === (slotOf(half).variant.current() ?? undefined))
        )
          return

        // The write goes to the owner, not the wrapped slot: the wrapped setter is the user-facing entry that starts
        // an exchange, and a pair write re-entering it would start an exchange inside its own batch.
        owner.set(
          item,
          // Two shapes, not one with a hole: naming no variant leaves the owner's own key handling untouched, and a
          // named call writes the value it named (an explicit `null` reads as `Default`'s nothing).
          named ? { recent: options?.recent, variant: options?.variant ?? undefined } : { recent: options?.recent },
        )

        // A model write is always a fresh intent: it claims this slot's model, the variant the call named, and the fact
        // that it named one. A later variant-only write is then a newer action, not this action's follow-up (FR-018).
        if (item)
          claimAction({
            type: "model.written",
            half,
            sessionID: sessionID() ?? "",
            model: { providerID: item.providerID, modelID: item.modelID },
            value: named ? options?.variant ?? undefined : undefined,
            named,
          })

        // A write that reaches this setter is a user action: it supersedes any exchange still in flight (FR-018), which
        // is what keeps a plain selection from being swallowed by a pending pair.
        dispatch({ type: "slot.changed" })
      },
      variant: {
        ...owner.variant,
        set: (value, failed) => {
          // The session owner's setter takes no outcome argument and ignores the extra one; the fallback owner reports
          // through it. Neither gains a second result channel of its own.
          owner.variant.set(value, failed)

          // One intent, two writes: this variant write belongs to the action that wrote the model now in this slot, so
          // while that action is still in flight it refines the pair it wrote (`pair.refined`) instead of superseding
          // it (FR-036). A variant for a model that action did not write, a variant contradicting the one it named, or a
          // variant-only action with no model write of its own is a newer action, and drops the pending exchange without
          // writing anything back (FR-018, T015).
          if (
            claimAction({
              type: "variant.observed",
              half,
              sessionID: sessionID() ?? "",
              model: slotOf(half).key() ?? undefined,
              value,
            })
          ) {
            if (phase.type === "exchanging")
              dispatch({ type: "pair.refined", attempt: phase.attempt, applied: displayedPair() })
          } else dispatch({ type: "slot.changed" })
        },
        // A picker previewing the model that sits in the other slot answers with the pair rule and nothing else: the
        // name it carries, or that model's OWN Default when the pair carries no name (FR-010). Falling back to the
        // owner's answer here would preview the variant remembered for that model while the exchange writes Default,
        // which is exactly the menu-versus-write disagreement FR-037 forbids. Any other model, including this slot's
        // own, is answered by the owner unchanged, which keeps the ordinary flyout keeper meaningful.
        current: (item) => {
          const held = other().key()

          if (item && held && sameModelIdentity(item, held)) return pairVariant(variantsOf(item), other().variant.current())

          return owner.variant.current(item)
        },
      },
    } as O & ExchangeSlotSelection
  }

  const primarySlot: ModelSelection & ExchangeSlotSelection = wrapSlot(primary, "primary")
  const fallbackSlot = wrapSlot(backup, "fallback")

  // Any newer write to either slot supersedes a pending exchange, including paths that never pass through these objects
  // (the agent change at `composer/selection.ts:177-183`, another window's write): the pair is watched, not the call
  // sites, and superseding writes nothing (FR-018). Every first read of the owners happens inside the effect: reading
  // the pair once outside it, to seed the previous value, would evaluate those memos untracked and leave them
  // permanently stale for every later reader.
  {
    let lastSignature = ""

    createEffect(() => {
      const signature = pairSignature()

      if (signature === lastSignature) return

      lastSignature = signature

      if (phase.type !== "exchanging") return

      // The exchange's own pair write, and its owners' reverts, are not a newer intent: each slot's model is either the
      // one this action claimed there or the one it wrote there, and a slot showing the model this action DISPLACED
      // spends the phase's one-shot revert permission for that slot. A pair outside that set can only come from a
      // write this action did not make — another window's selection, an agent change, a fallback config written
      // elsewhere — so the pending exchange is superseded without writing anything back (FR-018), while the exchange's
      // own writes and its owners' reverts never supersede it (FR-015 read with FR-032). The attempt is released only
      // by an outcome, which is what keeps the compensation available while the record store's save window is open.
      const accounting = accountForPair(phase, claims, displayedPair())

      if (accounting.accounted) {
        // A revert this attempt displaced, absorbed once per slot: a later write naming that same model again can only
        // be a newer action, and the spent permission is what makes the machine say so (`revert.absorbed`).
        if (accounting.reverts.primary || accounting.reverts.fallback)
          dispatch({ type: "revert.absorbed", primary: accounting.reverts.primary, fallback: accounting.reverts.fallback })

        return
      }

      dispatch({ type: "slot.changed" })
    })
  }

  // The record document this Session belongs to, and its failure observation. A rejected save of that document is the
  // only evidence a rejected primary record has, since that owner offers no per-write outcome, and the machine decides
  // whether it can belong to this attempt: the payload's entry for THIS composer's Session must still hold the model
  // and variant this exchange wrote, the observation must be newer than the one the attempt claimed behind, and only
  // the exchange in flight may use it (T004's three conditions — an earlier save window's payload, an observation the
  // document has since cleared, or another document's, admit nothing). While a compensation waits, a strictly newer
  // observation of the same document is that compensation's own outcome (T028). A change of workspace, route Session or
  // server is a new target: its exchanges start a new phase, and no outcome of the old one can compensate or report
  // into the new one (FR-014).
  {
    let lastTarget = ""
    let lastObservation = ""

    createEffect(() => {
      const target = targetSignature()
      const failure = mirrored ? undefined : primary.recordFailure?.()

      if (target !== lastTarget) {
        lastTarget = target
        lastObservation = ""
        claims = IDLE_CLAIMS

        dispatch({ type: "target.changed" })

        return
      }

      const observation = failure ? `${failure.id}\u001f${failure.attempted}` : ""

      if (observation === lastObservation) return

      lastObservation = observation

      if (!failure) {
        // Nothing outstanding: an observation the document has since cleared by a save that landed can be evidence of
        // nothing (T004's condition (ii)), and a compensation waiting on an answer gets none from it either.
        dispatch({ type: "record.changed" })

        return
      }

      dispatch({
        type: "observed",
        id: failure.id,
        attempted: failure.attempted,
        session: sessionID() ?? "",
        cause: failure,
      })
    })
  }

  // A Session being deleted is a change of this composer's target of the same kind as the route moving to another
  // Session: whatever the deleted Session's action owned is dropped, not written back into a Session that is no longer
  // here (FR-014). The event names the Session that went away, so a deletion anywhere else in the workspace leaves this
  // composer's pending exchange and its claims exactly as they were, and nothing here touches the shared config owner's
  // chain, which stays keyed per server and keeps behaving on its own (`providers/models/fallback-update.ts:13-28`).
  onCleanup(
    serverSDK.event.on("session.deleted", (event) => {
      if (event.data.sessionID !== sessionID()) return

      claims = IDLE_CLAIMS

      dispatch({ type: "target.changed" })
    }),
  )

  // The composer going away dispatches rather than leaving a flag behind, so a pending exchange or compensation is
  // dropped instead of being written into a session that is no longer here.
  onCleanup(() => dispatch({ type: "disposed" }))

  /**
   * One model row in either slot promotes the other slot's model into the clicked one (FR-001/FR-002), exchanging the
   * pair. The pair is claimed before anything is written, so a second press cannot start a second exchange (FR-026),
   * and a refusal writes nothing at all (FR-020). The return value is the only result channel: the pair on display, or
   * its absence after a compensation, is what the user sees (FR-015/FR-020).
   *
   * `named` is the variant this same click named for the model it chose, present only when the flyout named one (an
   *   explicit `undefined` is the user's own `Default`).
   */
  const exchange = (item: ModelKey, from: ComposerExchangeSlot, named?: { value: string | undefined }) => {
    const half = from === "primary" ? "fallback" : "primary"

    // The contract of a promotion, checked here rather than assumed of the caller: the target must name the model
    // sitting in the slot the user did NOT act in, both slots must hold a model, the pair must not be inactive, and the
    // fallback must be enabled (`admitsExchange`). A direct call naming anything else is refused with `false` and
    // performs no owner write at all (FR-006/FR-017/FR-020/FR-029/FR-030), which is why the row clicked is validated
    // rather than trusted.
    const held = { primary: primarySlot.key(), fallback: fallbackSlot.key() }

    if (!item || !admitsExchange(held, { half: from, modelChange: true, model: item, enabled: backup.enabled() })) return false

    // What it computes here is the pair the rule decided, once, so the writes and the phase's record of them cannot
    // disagree with what the row displayed.
    const pair = swapModelPair({
      primary: slotEntry(primarySlot),
      fallback: slotEntry(fallbackSlot),
      primaryVariants: primarySlot.variant.list(),
      fallbackVariants: fallbackSlot.variant.list(),
    })

    // An off or empty fallback has nothing to promote: a no-op, never a refusal, and never a write (FR-006).
    if (!pair) return false

    const primaryKey = { providerID: pair.primary.model.providerID, modelID: pair.primary.model.modelID }

    const fallbackKey = pair.fallback
      ? { providerID: pair.fallback.model.providerID, modelID: pair.fallback.model.modelID }
      : undefined

    // Refusal is pre-flight against the guard of each slot the model is moving into; the predicates differ, so each
    // slot answers for its own target rather than the driver guessing one rule.
    if (!(primarySlot.valid?.(primaryKey) ?? true)) return false

    if (fallbackKey && !(fallbackSlot.valid?.(fallbackKey) ?? true)) return false

    const restore = { primary: slotEntry(primarySlot), fallback: slotEntry(fallbackSlot) }

    const visible = {
      primary: primarySlot.visible(primaryKey),
      fallback: fallbackKey ? fallbackSlot.visible(fallbackKey) : true,
    }

    const attempt = ++claimed

    reported = false

    const carriedPrimary: ExchangeSlotEntry = { model: primaryKey, variant: pair.primary.variant }

    const carriedFallback: ExchangeSlotEntry | undefined = pair.fallback
      ? { model: fallbackKey ?? primaryKey, variant: pair.fallback.variant }
      : undefined

    // The variant this same click named for the model it chose wins over the one the pair rule carried (FR-036), and
    // still lands on nothing where that destination does not offer it (FR-010) — the same `pairVariant` the picker's
    // preview read, so the menu never previews one value and writes another (FR-037). Only the slot the user acted in
    // is asked for: the other half carries what the rule decided.
    const asked = named
      ? pairVariant(
          variantsOf(from === "primary" ? primaryKey : (fallbackKey ?? primaryKey)),
          named.value,
        )
      : undefined

    const primaryEntry: ExchangeSlotEntry = from === "primary" && named ? { model: primaryKey, variant: asked } : carriedPrimary

    const fallbackEntry: ExchangeSlotEntry | undefined =
      from === "fallback" && named && carriedFallback ? { ...carriedFallback, variant: asked } : carriedFallback

    batch(() => {
      // Both slots' intents are claimed before the writes, each naming the variant it will write: the pair on display
      // is then this action's own, and a later variant-only write — one the user makes in a picker or with the cycle
      // command — is a newer action that supersedes this attempt, even when no model identity changes (T015, FR-018).
      claimAction({
        type: "model.written",
        half: "primary",
        sessionID: sessionID() ?? "",
        model: primaryKey,
        value: primaryEntry.variant,
        named: true,
      })

      if (fallbackKey)
        claimAction({
          type: "model.written",
          half: "fallback",
          sessionID: sessionID() ?? "",
          model: fallbackKey,
          value: fallbackEntry?.variant,
          named: true,
        })

      dispatch({
        type: "exchange.claimed",
        attempt,
        half: from,
        restore,
        visible,
        failure: mirrored ? undefined : primary.recordFailure?.()?.id ?? 0,
      })

      // The claim names the pair this action will display BEFORE either owner writes, which is what lets the driver
      // recognise its own writes: the watched pair then matches this exchange rather than reading the exchange's own
      // writes as a newer user action that supersedes it (FR-015). The click's own variant is then recorded as a
      // refinement of the same attempt, which is what keeps the pair this action displayed in one piece (FR-036).
      dispatch({ type: "pair.written", attempt, applied: { primary: carriedPrimary, fallback: carriedFallback } })

      if (named)
        dispatch({ type: "pair.refined", attempt, applied: { primary: primaryEntry, fallback: fallbackEntry } })

      // The slot the user acted in is written first, so its model never passes through a state where its own variant
      // was already moved (FR-011: one intent, and no intermediate pair is ever offered to a picker). `recent` moves
      // only for the clicked model. The primary half's rejection is not a callback the owner offers: it arrives
      // through the record-store observation watched above.
      writeSlot(from, from === "primary" ? primaryEntry : fallbackEntry, {
        recent: true,
        onRejected: (cause) => dispatch({ type: "write.rejected", side: from, attempt, cause }),
      })
      writeSlot(half, half === "primary" ? primaryEntry : fallbackEntry, {
        recent: false,
        onRejected: (cause) => dispatch({ type: "write.rejected", side: half, attempt, cause }),
      })
    })

    // The exchange makes both targets visible because a selection owns its record (`visibleModel()` in the core), so
    // a model the user hid, or one the catalog did not know before the writes, goes back to hidden (FR-033).
    if (!visible.primary && primarySlot.visible(primaryKey)) primarySlot.setVisibility(primaryKey, false)

    if (fallbackKey && !visible.fallback && fallbackSlot.visible(fallbackKey)) fallbackSlot.setVisibility(fallbackKey, false)

    return true
  }

  return createMemo<ComposerControls>(() => ({
    agents: {
      available: normalizeAgentList(data.location.agent.list({ directory: sdk().directory }) ?? []),
      options: local.agent.list().map((agent) => agent.name),
      current: local.agent.current()?.name ?? "",
      visible: local.agent.visible(),
      select: local.agent.set,
    },
    model: {
      selection: primarySlot,
      providerName: primarySlot.key()
        ? composerProviderName(
            primarySlot.key()!.providerID,
            providers.all(),
            providers.connected().map((provider) => provider.id),
          )
        : undefined,
      label: primarySlot.key() && modelLabels().get(composerModelLabelKey(primarySlot.key()!.providerID, primarySlot.key()!.modelID)),
      fallback: fallbackSlot,
      // Recomputed from the two owners, never stored: what the fallback chip names (FR-029/FR-030).
      fallbackStatus: composerFallbackStatus({
        enabled: backup.enabled(),
        primary: primarySlot.key(),
        fallback: fallbackSlot.key(),
      }),
      exchange,
      paid: providers.paid().length > 0,
      // The session's model applies only to its agent, so resolve agents before showing a model.
      loading: loading(),
      preview: preview(),
    },
  }))
}

export function createComposerModelSelection(input: {
  agent: () => { name: string; model?: ModelKey; variant?: string } | undefined
}) {
  const sdk = useWorkspaceLocation()
  const models = useModels()
  const local = useLocal()
  const prompt = useComposerState()
  const configuredModel = useConfiguredModel()
  const [remembered, setRemembered] = createStore<Record<string, ModelKey | undefined>>({})
  createEffect(
    on(
      () => input.agent()?.name,
      (name, previous) => {
        if (!name || !previous || name === previous) return
        batch(() => {
          const model = prompt.model.current()
          setRemembered(previous, model ? { providerID: model.providerID, modelID: model.modelID } : undefined)
          prompt.model.set(remembered[name] ? { ...remembered[name] } : undefined)
        })
      },
    ),
  )
  const providers = useProviders(() => sdk().directory)
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

  const valid = (model: Pick<ModelKey, "providerID" | "modelID">) => {
    const provider = providers.all().get(model.providerID)

    return !!provider?.models[model.modelID] && connected().has(model.providerID)
  }

  const recent = () => models.recent.list().find(valid)

  const fallback = () =>
    providers.connected().flatMap((provider) => {
      const modelID = Object.values(provider.models)[0]?.id

      return modelID ? [{ providerID: provider.id, modelID }] : []
    })[0]

  const key = () => {
    if (!configuredModel.ready()) return

    return [prompt.model.current(), input.agent()?.model, configuredModel(), recent(), fallback()].find(
      (item): item is ModelKey => !!item && valid(item),
    )
  }

  const current = () => {
    const item = key()

    return item ? models.find(item) : undefined
  }

  const recentModels = createMemo(() =>
    models.recent
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const favoriteModels = createMemo(() =>
    models.favorite
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const selection = {
    trackSessionCommit: local.model.trackSessionCommit,
    /**
     * The draft has no record of its own to fail: its values are promoted into this workspace's model-selection
     * document, whose failed saves this reports. Never evidence about a draft action, only about that document.
     */
    recordFailure: local.model.recordFailure,
    remembered: (): AgentChoices =>
      Object.fromEntries(
        Object.entries(remembered).flatMap(([name, model]) =>
          model ? [[name, { providerID: model.providerID, modelID: model.modelID, variant: INHERIT_VARIANT }]] : [],
        ),
      ),
    ready: Object.assign(() => models.ready() && configuredModel.ready(), { promise: models.ready.promise }),
    key,
    current,
    recent: recentModels,
    favorite: { list: favoriteModels, toggle: models.favorite.toggle },
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()

      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)

      const next =
        items[
          index === -1 ? (direction === 1 ? 0 : items.length - 1) : (index + direction + items.length) % items.length
        ]

      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    /** This draft's own guard, asked by a pair exchange before it writes anything. */
    valid,
    set(item: ModelKey | undefined, options?: { recent?: boolean; variant?: string | null }) {
      batch(() => {
        if (item && !valid(item)) return
        const previous = current()
        const same = item && previous?.provider.id === item.providerID && previous.id === item.modelID
        prompt.model.set(
          item
            ? {
                ...item,
                // A model change seeds the variant recorded for that model, never the replaced model's (FR-034); where
                // nothing is recorded it inherits, so the model's own defaults still apply. A variant named by this
                // call (key present; an explicit `null` is the user's own `Default`) is this selection's own value.
                ...(Object.hasOwn(options ?? {}, "variant")
                  ? { variant: options?.variant ?? null }
                  : { variant: same ? (selection.variant.current() ?? null) : promptVariantValue(recordedVariant(models, item)) }),
              }
            : undefined,
        )

        if (!item) return
        models.setVisibility(item, true)

        if (Object.hasOwn(options ?? {}, "variant")) models.variant.set(item, options?.variant ?? undefined)

        if (options?.recent) models.recent.push(item)
      })
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured(model = current()) {
        const item = input.agent()

        if (!item || !model) return
        const global = configuredModel()

        return (
          getConfiguredAgentVariant({
            agent: { model: item.model, variant: item.variant },
            model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
          }) ??
          getConfiguredAgentVariant({
            agent: { model: global, variant: global?.variant },
            model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
          })
        )
      },
      current(item?: ModelKey) {
        const model = item ? models.find(item) : current()
        const same = !item || (current()?.provider.id === item.providerID && current()?.id === item.modelID)
        const prompted = prompt.model.current()

        return resolveModelVariant({
          variants: Object.keys(model?.variants ?? {}),
          selected: same && prompted && valid(prompted) ? variantSelectionFrom(prompted.variant) : INHERIT_VARIANT,
          configured: this.configured(model),
          preferred: model ? models.variant.get({ providerID: model.provider.id, modelID: model.id }) : undefined,
        })
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      set(value: string | undefined) {
        batch(() => {
          const model = current()

          if (!model) return
          prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value ?? null })
          models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
        })
      },
      cycle() {
        const variants = this.list()

        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: durableVariantSelection(this.current()),
            configured: undefined,
          }),
        )
      },
    },
  }

  return selection satisfies ModelSelection
}
