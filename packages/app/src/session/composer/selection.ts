import { configNeedsReconciliation } from "@/runtime/server/config-outcome"

export function resolveSessionComposerSelection(
  info: { agent?: string; model?: { id: string; providerID: string; variant?: string } } | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const model = metadata?.model

  const historical =
    model &&
    typeof model === "object" &&
    !Array.isArray(model) &&
    "providerID" in model &&
    "modelID" in model &&
    typeof model.providerID === "string" &&
    typeof model.modelID === "string"
      ? {
          providerID: model.providerID,
          modelID: model.modelID,
          variant: "variant" in model && typeof model.variant === "string" ? model.variant : undefined,
        }
      : undefined

  return {
    agent: info?.agent ?? (typeof metadata?.agent === "string" ? metadata.agent : undefined),
    model: info?.model
      ? { providerID: info.model.providerID, modelID: info.model.id, variant: info.model.variant }
      : historical,
  }
}

export type ComposerModelPair = {
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly variant?: string
}

/** A model as the pair rule sees it: provider plus model, variant ignored (FR-007). */
export type ComposerModelIdentity = { readonly providerID: string; readonly modelID: string }

/**
 * One model is one model whatever its variant, and the same modelID under two providers is two models: a variant-only
 * fallback is never a second model, and an exchange is always possible between providers. The core states the same rule
 * in `session/runner/llm.ts`'s `modelKey`; the browser cannot import that schema, so the two sides are pinned by paired
 * tests rather than one shared module (FR-031/FR-035).
 */
export function sameModelIdentity(a: ComposerModelIdentity | undefined, b: ComposerModelIdentity | undefined) {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID
}

/**
 * Which variant a model carries when it lands in a slot: the one it held in the other slot, but only where this model
 * offers it, otherwise nothing, which lets that model's own default apply (FR-009/FR-010). One rule, read both by the
 * pair writes and by the picker's preview, so a menu never previews one value and writes another (FR-036/FR-037).
 */
export function pairVariant(variants: readonly string[], variant: string | undefined) {
  return variant && variants.includes(variant) ? variant : undefined
}

export function swapModelPair(input: {
  readonly primary?: ComposerModelPair
  readonly fallback?: ComposerModelPair
  readonly primaryVariants: readonly string[]
  readonly fallbackVariants: readonly string[]
}) {
  if (!input.fallback) return

  return {
    primary: { model: input.fallback.model, variant: pairVariant(input.fallbackVariants, input.fallback.variant) },
    fallback: input.primary
      ? { model: input.primary.model, variant: pairVariant(input.primaryVariants, input.primary.variant) }
      : null,
  }
}

/**
 * The fallback slot's displayed state, recomputed from the two owners and never stored (FR-029/FR-030): `off` is an
 * explicit none, `inactive` is a fallback that would repeat the primary model, whose stored value must be left
 * untouched, and `model` is a fallback recovery could actually use.
 */
export type ComposerFallbackStatus = "model" | "off" | "inactive"

export function composerFallbackStatus(input: {
  readonly enabled: boolean
  readonly primary: ComposerModelIdentity | undefined
  readonly fallback: ComposerModelIdentity | undefined
}): ComposerFallbackStatus {
  // A fallback the config never names, or one disabled outright, leaves recovery nothing to use.
  if (!input.enabled || !input.fallback) return "off"

  return sameModelIdentity(input.primary, input.fallback) ? "inactive" : "model"
}

// The exchange phase. It holds one user action's pair and only the values that action would have to put back. The two
// owners keep their own machines, ordering and rollback; this phase issues none of its own values (FR-026).
export type ComposerExchangeSlot = "primary" | "fallback"

export type ExchangeSlotEntry = {
  readonly model: ComposerModelIdentity
  readonly variant: string | undefined
}

export type ExchangePair = {
  readonly primary: ExchangeSlotEntry | undefined
  readonly fallback: ExchangeSlotEntry | undefined
}

type ExchangeVisibility = {
  readonly primary: boolean
  readonly fallback: boolean
}

/** Which halves of the pair a compensation has asked its owners to write. Both halves are written by one compensation
 *  when the rejected save was the record document's (it rolled the whole document back), and only the acted-on half's
 *  owner is asked when the config chain reverted its own slot (FR-032's two directions). */
type ExchangeIssued = ExchangeVisibility

const IDLE_PHASE: ComposerExchangePhase = Object.freeze({ type: "idle" })

/**
 * A compensation the driver has issued and has not yet seen the outcome of. The record store saves asynchronously
 * (`persist.ts:118-135`), so a compensation cannot count as answered when the write call returns: it is answered by the
 * next observation of that document. Until then, a later failure of the same document is that compensation's own
 * outcome, which is FR-032's third case: the values put back did not stick either.
 */
export type ComposerExchangeCompensation = {
  /** The exchange these writes belong to: an outcome of an action that was already superseded acts on nothing, and an
   *  outcome naming an older attempt can never end a later attempt's compensation. */
  readonly attempt: number
  /** Which halves of the pair this compensation actually asked its owners to write. One failed attempt can issue both
   *  halves (a rejected record save reverted the whole document), and an issued write is not a landed one: the phase
   *  tracks the writes the driver dispatched, not their outcomes (FR-032 with FR-026). */
  readonly issued: ExchangeIssued
  /** The failure observation this compensation was issued behind, so only a strictly newer one can be its outcome. An
   *  owner with no document of its own (a draft's mirrored selection) has none: a record failure can never be its
   *  outcome, and only the config chain's own outcome can (T028). */
  readonly failure: number | undefined
  /** The failure that started the attempt, which is what the one report names. A compensation whose own write landed
     still reports it: the record write that was rejected is what the user must hear about (T028). */
  readonly cause: unknown
}

export type ComposerExchangePhase =
  | { readonly type: "idle" }
  | {
      readonly type: "compensating"
      /** The compensation in flight. Nothing else may act while it waits, and it is never itself compensated. */
      readonly compensation: ComposerExchangeCompensation
    }
  | {
      readonly type: "exchanging"
      /** Which action this exchange belongs to, so an outcome arriving after a newer one cannot act (FR-018). */
      readonly attempt: number
      /** Which slot the user acted in: the half written first, and the half whose guard could refuse the pair. */
      readonly half: ComposerExchangeSlot
      /** What each slot held before the pair was written, used at most once (FR-032). */
      readonly restore: ExchangePair
      /** The pair this action displayed, once its writes land, and whether the exchange may still compensate (FR-015). */
      readonly applied: ExchangePair | undefined
      /** Whether each target was visible before the writes, so a model the user hid goes back to hidden (FR-033). */
      readonly visible: ExchangeVisibility
      /** The persistence observation this exchange claimed behind: `0` means the document had no outstanding failure
       *  when the exchange started, so any later one can be its evidence; `undefined` means the owner has no document
       *  of its own to observe (a draft's mirrored selection), so a record failure can never be its evidence (T028). */
      readonly failure: number | undefined
      /** A slot this attempt wrote into, whose owner may put its own recorded value back when it refuses that write
        *  (`fallback-update.ts:44` clears the optimistic override). The display falling back to the pre-exchange model
        *  accounts for this attempt AT MOST ONCE per slot: an attempt that already absorbed its revert can be moved on
        *  only by a newer write, even one naming that same model again (FR-015 read with FR-018). A write producing an
        *  identical display inside the same revert window cannot be told apart by data at all, and the machine never
        *  claims otherwise (FR-019's honesty limit). */
      readonly reverts: ExchangeVisibility
    }
  | {
      readonly type: "unresolved"
      /** The half whose compensation itself failed. Terminal: never retried, never reported twice. */
      readonly side: ComposerExchangeSlot
      /** The compensation that ended the attempt, so a view can say the pair on display may not be durable. */
      readonly compensation: ComposerExchangeCompensation
    }

export type ComposerExchangeEvent =
  | {
      type: "exchange.claimed"
      attempt: number
      half: ComposerExchangeSlot
      restore: ExchangePair
      visible: ExchangeVisibility
      failure: number | undefined
    }
  | { type: "pair.written"; attempt: number; applied: ExchangePair }
  /** A variant the picker named for a model this exchange chose, which refines the pair this action wrote (FR-036). */
  | { type: "pair.refined"; attempt: number; applied: ExchangePair }
  /** The pair the two owners now display, watched by the driver: this attempt's own write, one of its owners' reverts
   *  (which the attempt absorbs once per slot), or a write this action never made. */
  | { type: "revert.absorbed"; primary: boolean; fallback: boolean }
  | { type: "write.rejected"; side: ComposerExchangeSlot; attempt: number; cause: unknown }
  | { type: "slot.changed" }
  /** The record document this composer's Session belongs to, read after a workspace or route change. */
  | { type: "record.changed" }
  | { type: "target.changed" }
  | { type: "disposed" }
  /**
   * The record document's failure observation, watched by the driver. `id` is the store's observation counter;
   * `attempted` is the payload that save tried to write, or `""` when the store reports no outstanding failure, which
   * can be evidence of nothing (T004's condition (ii)); `session` is the composer's Session, whose entry in that
   * payload is the only one that can carry this pair; `cause` is what the one report names.
   */
  | { type: "observed"; id: number; attempted: string; session: string; cause: unknown }
  /** A compensation the driver is about to write, and the attempt and observation it belongs to. */
  | {
      type: "compensation.issued"
      side: ComposerExchangeSlot
      attempt: number
      failure: number | undefined
      cause: unknown
    }
  /** The compensation's own write was refused synchronously (the config chain's outcome callback), by the owner of the
   *  half named here, for the attempt named here (T028). */
  | { type: "compensation.failed"; side: ComposerExchangeSlot; attempt: number }

export type ComposerExchangeEffect =
  | { type: "restore.primary"; pair: ExchangeSlotEntry }
  | { type: "restore.fallback"; pair: ExchangeSlotEntry }
  /**
   * A compensation the driver is about to write, with the attempt and the observation it belongs to: the driver
   * re-dispatches this as the `compensation.issued` event, which is what moves the phase to `compensating` while the
   * record store's asynchronous save window answers it (T028).
   */
  | {
      type: "compensation.issued"
      side: ComposerExchangeSlot
      attempt: number
      failure: number | undefined
      cause: unknown
    }
  /** One report per attempt, naming the failure that started it. */
  | { type: "report"; cause: unknown }

/** What a pair transition returns: the phase to move to and the effects the driver must run, in order. Named so the
 *  transitions' callers and the machine's own tests read one contract instead of a shape copied per `return`. */
export type ComposerExchangeTransition = {
  state: ComposerExchangePhase
  effects: ComposerExchangeEffect[]
}

export const COMPOSER_EXCHANGE_IDLE: ComposerExchangePhase = IDLE_PHASE

export const createExchangePhase = (): ComposerExchangePhase => IDLE_PHASE

/** The phase while an exchange is in flight, which is what the driver's checks and effects read. */
export type ComposerExchangeHeld = Extract<ComposerExchangePhase, { type: "exchanging" }>

/** Whether `attempt` is still the exchange in flight, which is what drops a late outcome (FR-018/FR-032). */
export const exchangeHoldsAttempt = (phase: ComposerExchangePhase, attempt: number) =>
  phase.type === "exchanging" && phase.attempt === attempt

/** Whether the pair on display still holds the two models this exchange wrote, variants aside (FR-015). */
export const exchangeHoldsModels = (phase: ComposerExchangePhase, pair: ExchangePair) =>
  phase.type === "exchanging" && !!phase.applied && sameModelPair(phase.applied, pair)

/** Whether a record-store failure observation can be this exchange's evidence: only one newer than what it claimed. */
export const exchangeObservedAfter = (phase: ComposerExchangePhase, id: number) =>
  phase.type === "exchanging" && phase.failure !== undefined && phase.failure < id

const sameEntry = (a: ExchangeSlotEntry | undefined, b: ExchangeSlotEntry | undefined) => {
  if (!a || !b) return a === undefined && b === undefined

  return a.model.providerID === b.model.providerID && a.model.modelID === b.model.modelID && a.variant === b.variant
}

const sameModelPair = (a: ExchangePair, b: ExchangePair) =>
  sameModelIdentity(a.primary?.model, b.primary?.model) && sameModelIdentity(a.fallback?.model, b.fallback?.model)

const sameWrittenPair = (a: ExchangePair, b: ExchangePair) =>
  sameEntry(a.primary, b.primary) && sameEntry(a.fallback, b.fallback)

/**
 * Whether the pair on display is exactly the one this exchange wrote. A variant-only change afterwards refines that
 * action's pair rather than superseding it, so the pending exchange survives a variant the picker named for a model
 * this very action chose (FR-036), while any model change drops it (FR-018).
 */
export const exchangeWroteExactly = (phase: ComposerExchangePhase, pair: ExchangePair) =>
  phase.type === "exchanging" && !!phase.applied && sameWrittenPair(phase.applied, pair)

/**
 * Whether a record failure can be THIS compensation's outcome: the same document's observation counter, strictly newer
 * than the observation the compensation was issued behind. An owner with no document of its own (a draft's mirrored
 * selection) has no failure to await, so only the config chain's own outcome can answer it (T028).
 */
export const compensationAwaitsOutcome = (phase: ComposerExchangePhase, id: number) =>
  phase.type === "compensating" && phase.compensation.failure !== undefined && phase.compensation.failure < id

/** The compensation this phase is waiting on, or ended with, which is what names the one report's cause. */
export const compensationOf = (phase: ComposerExchangePhase) =>
  phase.type === "compensating" || phase.type === "unresolved" ? phase.compensation : undefined

/**
 * Whether the row a click names is the SHAPE of a promotion: it names the model sitting in the OTHER slot, and this
 * slot does not already hold it. This is deliberately separable from `admitsExchange`, which adds the guards that decide
 * whether the pair may move: the driver has to know when a click WOULD have promoted a pair, so that a REFUSED one
 * writes nothing at all instead of quietly becoming an ordinary write into one slot (FR-006/FR-017/FR-029/FR-030).
 */
export const promotesPair = (
  held: {
    readonly primary: ComposerModelIdentity | undefined
    readonly fallback: ComposerModelIdentity | undefined
  },
  action: {
    /** Which slot the user acted in, and therefore which model is being displaced. */
    readonly half: ComposerExchangeSlot
    /** The model the click names. */
    readonly model: ComposerModelIdentity
  },
) => {
  const current = action.half === "primary" ? held.primary : held.fallback
  const opposite = action.half === "primary" ? held.fallback : held.primary

  return (
    // The click names the OTHER slot's model, and is not the model this slot already holds. A slot holding nothing
    // still makes a click on the other slot's model promotion-SHAPED, which is what an off fallback's picker naming
    // the primary model looks like: `admitsExchange` then refuses it, and the driver writes nothing at all.
    sameModelIdentity(opposite, action.model) && !sameModelIdentity(current, action.model)
  )
}

/**
 * The row a picker click names, read against the pair on display. It must name the model sitting in the OTHER slot,
 * that pair must be an exchange candidate, and the slot the user acted in must not already hold that model. An off
 * fallback (`enabled` false) and an inactive one (the same model in both slots, or nothing in either) never exchange:
 * choosing the primary model in the fallback picker then writes nothing at all (FR-006/FR-029/FR-030), and an inherited
 * or default A/A display is not two records to swap. A variant-only write (`modelChange` false) is never an exchange
 * (FR-003: variant controls never promote a model).
 */
export const admitsExchange = (
  held: {
    readonly primary: ComposerModelIdentity | undefined
    readonly fallback: ComposerModelIdentity | undefined
  },
  action: {
    /** Which slot the user acted in, and therefore which model is being displaced. */
    readonly half: ComposerExchangeSlot
    /** Whether this action writes a model at all, rather than only naming a variant. */
    readonly modelChange: boolean
    /** The model the click names. */
    readonly model: ComposerModelIdentity
    /** Whether the fallback config is enabled. */
    readonly enabled: boolean
  },
) =>
  // On top of the promotion shape (`promotesPair`): both slots must hold a model — a slot with nothing recorded has
  // no record to put the other half back into, and promoting into it would write an explicit "no fallback" as a
  // side effect, which FR-017 reserves for the dedicated control; the action must write a model at all (FR-003:
  // variant controls never promote a model); and the fallback must be enabled (FR-006/FR-017). An inactive pair —
  // the same model in both slots, which is what an inherited or default A/A display records — is not even
  // promotion-shaped, so it never gets this far in either direction (FR-029/FR-030/FR-034).
  !!held.primary &&
  !!held.fallback &&
  action.modelChange &&
  action.enabled &&
  promotesPair(held, { half: action.half, model: action.model })

/**
 * The entry this composer's Session has in a failed save's payload, decoded the way the record store writes it
 * (`providers/models/selection.tsx:304` writes `{ session: { [id]: { choice: { providerID, modelID, variant } } } }`,
 * and `variant.ts:43` stores a named variant as `{ type: "named", value }` or a default/inherit marker). Nothing at all
 * when the payload is not JSON, has no entry for this Session, or holds no choice in it, which is also what an
 * observation the document has since cleared looks like.
 */
export const payloadChoice = (attempted: string, session: string): ExchangeSlotEntry | undefined => {
  if (!session || !attempted) return

  try {
    // SAFETY: `JSON.parse` hands back untyped text; every field read below goes through optional access, and the
    // `providerID`/`modelID` checks and the `type === "named"` comparison are what decide whether this payload names
    // a choice at all, so a document of any other shape reads as nothing rather than a wrong pair.
    const document = JSON.parse(attempted) as {
      session?: Record<string, { choice?: { providerID?: string; modelID?: string; variant?: { type?: string; value?: string } } }>
    }

    const choice = document.session?.[session]?.choice

    if (!choice?.providerID || !choice.modelID) return

    return {
      model: { providerID: choice.providerID, modelID: choice.modelID },
      variant: choice.variant?.type === "named" ? choice.variant.value : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Condition (a) of the three that make an observation this exchange's evidence (T004): the payload's entry for THIS
 * composer's Session still holds the model and variant this exchange wrote in the primary slot. Another Session in the
 * same document carrying the same model is not this pair, which is why the lookup is keyed by Session. The fallback
 * half lives in the config document, which this observation never carries, so it is not part of the test.
 */
export const payloadCarriesPair = (attempted: string, session: string, applied: ExchangePair | undefined) =>
  !!applied?.primary && sameEntry(payloadChoice(attempted, session), applied.primary)

/**
 * Which write a user action owns, per slot: the driver's second machine, beside the pair phase. A picker writes twice
 * for one intent (the model row at `select-dialog.tsx:536`, then the variant its flyout names) and a pair exchange
 * writes across both slots, so the driver has to know which writes belong to the action already in flight. A variant
 * named as part of a model choice refines that action's intent (FR-036); a later variant-only action, or a variant that
 * contradicts what the action claimed, is a newer action (FR-018). Model and variant are compared exactly: the row a
 * picker clicked names both, and a per-model preference is a different value from the selection this action wrote
 * (`ModelSelection["variant"]`'s `current(item)` is what resolves a preference, so the claim never consults it).
 */
export type ComposerActionClaim = {
  /** The Session this write was for; an outcome of another Session's write claims nothing (FR-014). */
  readonly sessionID: string
  /** The model this action put in the slot, which a follow-up's model must still equal. */
  readonly model: ComposerModelIdentity
  /** The variant this action named for that model, or `undefined` when it named `Default` or left the variant to a
   *  follow-up or to the model's own default, which is what a fallback half with nothing carried writes as `null`. */
  /** Whether this intent NAMED a variant outright: the action boundary the driver read off the call, not inferred from
   *  a later callback. An intent that named one has nothing left for a follow-up to say, so any other variant value
   *  for this slot is a newer action (FR-018), while an intent that left the variant unnamed is still waiting for
   *  its own follow-up (FR-036). */
  readonly value: string | undefined
  readonly named: boolean
}

export type ActionClaims = {
  readonly primary: ComposerActionClaim | undefined
  readonly fallback: ComposerActionClaim | undefined
}

export const IDLE_CLAIMS: ActionClaims = Object.freeze({ primary: undefined, fallback: undefined })

/** What a claim transition returns: the claims after this write and whether the write was the action in flight. */
export type ActionClaimTransition = {
  claims: ActionClaims
  intent: boolean
}

/** One pure transition over the two writes an action makes, per slot. */
export type ActionClaimEvent =
  | {
      type: "model.written"
      half: ComposerExchangeSlot
      sessionID: string
      model: ComposerModelIdentity
      /** The variant this one call named for that model, and whether it named one at all. This is the intent boundary:
       *  the picker passes the flyout's value WITH the row it clicked (`select-dialog.tsx:536`), and a pair exchange
       *  names the variant the pair rule carried, so nothing has to be inferred from a later callback (FR-036/FR-018). */
      value: string | undefined
      named: boolean
    }
  | {
      type: "variant.observed"
      half: ComposerExchangeSlot
      sessionID: string
      model: ComposerModelIdentity | undefined
      value: string | undefined
    }

/**
 * `intent` is whether the write belongs to the action already in flight: `true` means the driver tells the pair machine
 * `pair.refined` (this action wrote the variant too, T013), `false` means it tells it `slot.changed` and the pending
 * exchange is dropped without writing anything back (FR-018). A model write always replaces its slot's claim.
 */
export function transitionActionClaim(
  claims: ActionClaims,
  event: ActionClaimEvent,
): ActionClaimTransition {
  const held = claims[event.half]

  // One slot's claim replaced with the other carried unchanged: the two halves are never half-updated.
  const withClaim = (
    half: ComposerExchangeSlot,
    claim: ComposerActionClaim | undefined,
  ): ActionClaims =>
    Object.freeze(
      half === "primary"
        ? { primary: claim, fallback: claims.fallback }
        : { primary: claims.primary, fallback: claim },
    )

  // A model write is always a fresh intent: it replaces this slot's claim with the model the row clicked, the variant
  // its `variant` option named, and whether it named one at all. Leaving the variant unnamed is what invites the
  // follow-up a picker does (`select-dialog.tsx:536` names the flyout's value in that same call, so it never leaves
  // one unnamed); a pair exchange names the variant the pair rule carried. Nothing here infers the boundary from a
  // later callback, from how long ago a write arrived, or from a claim merely still being on file.
  if (event.type === "model.written") {
    return {
      claims: withClaim(
        event.half,
        Object.freeze({
          sessionID: event.sessionID,
          model: event.model,
          value: event.value,
          named: event.named,
        }),
      ),
      intent: false,
    }
  }

  // A variant-only write counts as the action in flight only while the slot still holds the model that action wrote,
  // in the same Session, and only when that action left the variant unnamed. Anything else — no claim, another Session,
  // a model this action did not write, or an intent that already said which variant its model wears — is a newer action.
  if (!held || held.sessionID !== event.sessionID || !sameModelIdentity(held.model, event.model))
    return { claims: withClaim(event.half, undefined), intent: false }

  if (held.named && held.value !== event.value) {
    // The action already named the variant this slot's model carries, so a different value is a separate, later action,
    // which supersedes: that is T015's asymmetry, and what keeps a variant-only action from being swallowed by a
    // pending exchange it has no part in (FR-018).
    return { claims: withClaim(event.half, undefined), intent: false }
  }

  // The follow-up this action's own model write invited, or the same value named again: one intent, and the repeated
  // write is deduplicated rather than treated as new (FR-036: the named variant wins over the one the pair carried).
  return {
    claims: withClaim(event.half, Object.freeze({ ...held, value: event.value, named: true })),
    intent: true,
  }
}

/**
 * The full reactive-driver decision: whether the pair the two owners now display still belongs to this attempt.
 * Each slot is covered by its claim or the model this action wrote there; a slot showing the model this action
 * DISPLACED is covered only by the phase's one-shot revert permission, which the driver spends with
 * `revert.absorbed`. Anything else can only come from a write this action did not make, so the pending exchange is
 * superseded without writing anything back (FR-018), while the exchange's own writes and its owners' reverts never
 * supersede it (FR-015 read with FR-032).
 */
/** One slot's coverage: whether the pair it displays still belongs to this attempt, and whether that slot spent the
 *  revert permission. Named so `accountForPair` combines two answers of the same contract. */
type PairCoverage = {
  readonly accounted: boolean
  readonly revert: boolean
}

export type ComposerPairAccounting = {
  readonly accounted: boolean
  /** Which slots used the revert permission, so the driver can spend it. */
  readonly reverts: ExchangeVisibility
}

export const accountForPair = (
  held: ComposerExchangeHeld,
  claims: ActionClaims,
  pair: ExchangePair,
): ComposerPairAccounting => {
  const covered = (half: ComposerExchangeSlot): PairCoverage => {
    const model = (half === "primary" ? pair.primary : pair.fallback)?.model
    const claim = half === "primary" ? claims.primary : claims.fallback
    const applied = half === "primary" ? held.applied?.primary : held.applied?.fallback

    if (sameModelIdentity(model, claim?.model) || sameModelIdentity(model, applied?.model))
      return { accounted: true, revert: false }

    const restore = half === "primary" ? held.restore.primary : held.restore.fallback

    return { accounted: held.reverts[half] && sameModelIdentity(model, restore?.model), revert: true }
  }

  const primary = covered("primary")
  const fallback = covered("fallback")

  return {
    accounted: primary.accounted && fallback.accounted,
    reverts: { primary: primary.revert, fallback: fallback.revert },
  }
}

/**
 * One pure transition over the closed event union. It runs no I/O and reads no clock: it decides what the two owners
 * are then asked for, and drops anything that no longer belongs to the exchange in flight.
 */
export function transitionPairExchange(
  phase: ComposerExchangePhase,
  event: ComposerExchangeEvent,
): ComposerExchangeTransition {
  // The driver claims the action before it writes, so a second press cannot start a second exchange (FR-026).
  if (event.type === "exchange.claimed")
    return {
      state: Object.freeze({
        type: "exchanging",
        attempt: event.attempt,
        half: event.half,
        restore: event.restore,
        applied: undefined,
        visible: event.visible,
        failure: event.failure,
        // Every half this attempt writes into may be reverted by its own owner once.
        reverts: { primary: true, fallback: true },
      }),
      effects: [],
    }

  if (event.type === "revert.absorbed") {
    // The driver saw a slot fall back to the model this attempt displaced and used the phase's one-shot permission for
    // it, so the permission is spent: a later write naming that model again is a newer action and supersedes.
    if (phase.type !== "exchanging") return { state: phase, effects: [] }

    const reverts = {
      primary: phase.reverts.primary && !event.primary,
      fallback: phase.reverts.fallback && !event.fallback,
    }

    if (reverts.primary === phase.reverts.primary && reverts.fallback === phase.reverts.fallback)
      return { state: phase, effects: [] }

    return { state: Object.freeze({ ...phase, reverts }), effects: [] }
  }

  if (event.type === "pair.written") {
    // The exchange's own pair write is recorded as it lands, which is what lets the driver tell its own writes apart
    // from a newer user action: the pair on display matching `applied` is this exchange finishing (FR-015), not a
    // supersession.
    if (phase.type !== "exchanging" || phase.attempt !== event.attempt) return { state: phase, effects: [] }

    return { state: Object.freeze({ ...phase, applied: event.applied }), effects: [] }
  }

  if (event.type === "pair.refined") {
    // A variant the picker named for a model this exchange chose refines the pair this action wrote rather than
    // starting a newer one, so the pending exchange survives to compensate for it (FR-036 read with FR-032). Only
    // the models may stay identical: the driver's action claim is what rejects a variant for a model this action did
    // not choose, which reaches the machine as a supersession instead.
    if (phase.type !== "exchanging" || phase.attempt !== event.attempt) return { state: phase, effects: [] }

    if (!phase.applied || !sameModelPair(phase.applied, event.applied)) return { state: phase, effects: [] }

    // The same value named twice (the pickers' repeated follow-up) refines nothing: the phase is returned unchanged.
    if (sameWrittenPair(phase.applied, event.applied)) return { state: phase, effects: [] }

    // Only what this action displayed is refined. `restore` keeps the models AND the variants each slot actually held
    // before the exchange, untouched: that pair is what the two owners had recorded, and it is what a rejection of
    // this action's own write has to put back (FR-032). Restoring a variant this action never wrote into that slot
    // — the one carried across the swap from the other model — would write a value nobody asked for, breaking FR-009's
    // rule that each model keeps its own variant (FR-011/FR-034 read with FR-032).
    return { state: Object.freeze({ ...phase, applied: event.applied }), effects: [] }
  }

  // A compensation is about to be written, so the attempt that produced it has already been released. The record
  // store's save window is asynchronous, so the phase does not fall back to idle: it holds the compensation and waits
  // for that document's next observation, which is the only thing that can answer it (T028).
  if (event.type === "compensation.issued") {
    // The driver re-dispatches the effect it was handed, so the first issue of an attempt opens the wait: the record
    // store saves asynchronously (`persist.ts:118-135`), so the phase holds the compensation rather than claiming it
    // landed, and the document's next observation is what can answer it (T028).
    if (phase.type === "idle")
      return {
        state: Object.freeze({
          type: "compensating",
          compensation: {
            attempt: event.attempt,
            issued: { primary: event.side === "primary", fallback: event.side === "fallback" },
            failure: event.failure,
            cause: event.cause,
          },
        }),
        effects: [],
      }

    // A second half of the SAME attempt's compensation: a rejected record save reverted the whole document, so both
    // halves are re-written, and the phase has to account for the second write too — otherwise its outcome would look
    // like an attempt nobody issued a write for, and a rejection naming that half would be dropped while its write
    // proceeds. A repeat of a half already issued, or an issue naming an older attempt, changes nothing: at most one
    // compensation per attempt, and no endless chain of restorations (FR-018/FR-032).
    if (phase.type !== "compensating" || phase.compensation.attempt !== event.attempt || phase.compensation.issued[event.side])
      return { state: phase, effects: [] }

    return {
      state: Object.freeze({
        ...phase,
        compensation: Object.freeze({
          ...phase.compensation,
          issued: {
            primary: phase.compensation.issued.primary || event.side === "primary",
            fallback: phase.compensation.issued.fallback || event.side === "fallback",
          },
        }),
      }),
      effects: [],
    }
  }

  if (event.type === "write.rejected") {
    // A rejection the phase no longer holds — an older action's, or one this exchange already released — writes and
    // reports nothing: a compensation is issued at most once (FR-018/FR-032).
    if (phase.type !== "exchanging" || phase.attempt !== event.attempt) return { state: phase, effects: [] }

    // A config rejection that says the document already holds what this exchange wrote cannot authorize a compensating
    // write, and `config-outcome.ts` classifies both shapes of that: a coded committed-state error (`CONFIG_COMMITTED_*`,
    // read off the generated error, never off the status), where publication or notification failed after the commit; and
    // a `ConfigConfirmationFailure`, where the PATCH returned 204 but the confirming GET failed, so the commit landed and
    // only the read-back is unknown. Restoring the pre-exchange pair in either case would be a fresh write asserting a durable
    // commit was undone, which the boundary forbids. The config owner answers its own rejection by re-reading the source
    // (`fallback-update.ts` keeps its override until that read lands), so this attempt reports once and asks the two owners
    // for nothing. An ordinary precommit rejection — no code, no confirmation gap — keeps the compensation below.
    if (configNeedsReconciliation(event.cause))
      return { state: IDLE_PHASE, effects: [{ type: "report", cause: event.cause }] }

    const { primary, fallback } = phase.restore
    // One report per attempt, naming the failure that started it. It fires as the compensation is issued, so a
    // compensation whose own write lands still reports the rejection the user acted on (T028), and a compensation that
    // fails afterwards adds nothing.
    const effects: ComposerExchangeEffect[] = [{ type: "report", cause: event.cause }]

    const issue = (side: ComposerExchangeSlot): ComposerExchangeEffect => ({
      type: "compensation.issued",
      side,
      attempt: phase.attempt,
      failure: phase.failure,
      cause: event.cause,
    })

    if (event.side === "fallback") {
      // The config chain reverted its own slot by dropping the optimistic override, so only the primary half is put
      // back (FR-032's first direction).
      if (primary) effects.push(issue("primary"), { type: "restore.primary", pair: primary })
    } else {
      // A rejected record save reverted the whole document, so both halves are written again: the half that had landed
      // cleared its own optimistic override, making the exchanged pair that owner's last recorded value (FR-032's
      // second direction).
      if (primary) effects.push(issue("primary"), { type: "restore.primary", pair: primary })

      if (fallback) effects.push(issue("fallback"), { type: "restore.fallback", pair: fallback })
    }

    return { state: IDLE_PHASE, effects }
  }

  if (event.type === "observed") {
    if (phase.type === "compensating") {
      // The record document's observation answers the compensation's write to the RECORD half: a strictly newer one
      // means the values put back did not stick either (FR-032's third case, SC-010). Nothing is retried, nothing
      // more is reported (the report fired when this compensation was issued), and the terminal phase keeps what it
      // was waiting on so a view can say the pair on display may not be durable. An observation that is not newer
      // than the one this compensation was issued behind says nothing about it, and one cannot answer a half it never
      // wrote to (a compensation that only re-wrote the config half is answered by the config chain, not here).
      if (!compensationAwaitsOutcome(phase, event.id) || !phase.compensation.issued.primary) return { state: phase, effects: [] }

      return {
        state: Object.freeze({
          type: "unresolved",
          side: "primary",
          compensation: phase.compensation,
        }),
        effects: [],
      }
    }

    // Condition (c) of T004's three: only the exchange in flight may compensate, so the evidence of an action that was
    // already superseded is dropped (FR-018 outranks FR-032 once superseded).
    if (phase.type !== "exchanging") return { state: phase, effects: [] }

    if (!exchangeObservedAfter(phase, event.id)) return { state: phase, effects: [] }

    // Conditions (a) and (b): the payload still holds what THIS exchange wrote for THIS composer's Session, and the
    // document has not reported that observation cleared. A newer id on its own is an ordering, never evidence, and an
    // observation the document has since cleared (`attempted: ""`) carries no payload at all (T004).
    if (!payloadCarriesPair(event.attempted, event.session, phase.applied)) return { state: phase, effects: [] }

    const { primary, fallback } = phase.restore
    const effects: ComposerExchangeEffect[] = [{ type: "report", cause: event.cause }]

    if (primary)
      effects.push(
        { type: "compensation.issued", side: "primary", attempt: phase.attempt, failure: event.id, cause: event.cause },
        { type: "restore.primary", pair: primary },
      )

    if (fallback)
      effects.push(
        { type: "compensation.issued", side: "fallback", attempt: phase.attempt, failure: event.id, cause: event.cause },
        { type: "restore.fallback", pair: fallback },
      )

    // The attempt is released before the writes so a compensation can never start another one: a rejection arriving
    // afterwards ends the phase `unresolved` and reports nothing further (FR-019's honesty limit).
    return { state: IDLE_PHASE, effects }
  }

  if (event.type === "compensation.failed") {
    // The compensation's own write was refused by its owner synchronously: one report was already issued, nothing is
    // retried, and the phase ends unresolved. This claims nothing about the two durable records holding the pre-
    // exchange pair (FR-019's limit); the display stays collision-free through the inactive presentation.
    //
    // Attribution is exact: the outcome names the half whose owner reported it and the attempt that write belongs to.
    // A rejection naming a half this compensation never issued, or an attempt other than the one in flight, is an
    // older compensation's outcome and acts on nothing (T028).
    if (
      phase.type !== "compensating" ||
      phase.compensation.attempt !== event.attempt ||
      !phase.compensation.issued[event.side]
    )
      return { state: phase, effects: [] }

    return {
      state: Object.freeze({ type: "unresolved", side: event.side, compensation: phase.compensation }),
      effects: [],
    }
  }

  // Any newer write to either slot, a workspace, Session or record-document change, or the composer going away leaves
  // nothing pending: a discarded `restore` is never written into a newer world (FR-014/FR-018), and a compensation
  // still waiting is dropped rather than re-issued.
  if (
    event.type === "slot.changed" ||
    event.type === "target.changed" ||
    event.type === "record.changed" ||
    event.type === "disposed"
  )
    return phase.type === "idle" ? { state: phase, effects: [] } : { state: IDLE_PHASE, effects: [] }

  return { state: phase, effects: [] }
}

/** The pair identity both slots currently display, which the driver compares against a pending exchange. */
export const exchangePairOf = (primary: ExchangeSlotEntry | undefined, fallback: ExchangeSlotEntry | undefined) => ({
  primary,
  fallback,
})
