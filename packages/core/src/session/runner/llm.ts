export * as SessionRunnerLLM from "./llm.js"

import { AIError, Message } from "@opencode/ai/effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionBackground } from "../background.js"
import { Job } from "../../job.js"
import { SessionHistory } from "../history.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { Config } from "../../config.js"
import { ConfigFallback } from "../../config/fallback.js"
import { FallbackRuntimeIntent } from "../../config/fallback-runtime-intent.js"
import { ConfigModel } from "@opencode/schema/config/model"
import { Model } from "@opencode/schema/model"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient, requestExecutor } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { PersistentPty } from "../../persistent-pty/index.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

type DrainInput = Parameters<Interface["drain"]>[0]

/** Recovery identity is provider + model, and never counts a variant (FR-031). */
const modelKey = (ref: Model.Ref) => `${ref.providerID}/${ref.id}`

/** The effective model a recorded Config fallback or staged override names, variant aside from the identity. */
const selectionRef = (choice: ConfigModel.Selection) =>
  Model.Ref.make({
    providerID: choice.providerID,
    id: choice.model,
    ...(choice.variant === undefined ? {} : { variant: choice.variant }),
  })

/** Two references that resolve to the same request: identity and variant must both agree. */
const sameRef = (left: Model.Ref, right: Model.Ref) =>
  modelKey(left) === modelKey(right) && left.variant === right.variant

/**
 * A fallback generation prepared but not yet dispatched: the model it will serve plus the intent tokens
 * its choice was resolved from. Rechecking those tokens at every suspension before the provider runs is what
 * lets a newer accepted intent supersede the prepared request. The candidate is deliberately NOT recorded
 * as attempted: only a generation that physically reached the provider earns that credit.
 */
type Candidate = {
  readonly ref: Model.Ref
  /** Set when a staged override decided this choice, so retiring that override makes it stale. */
  readonly staged: Model.Ref | undefined
  /** Staged revision and committed document revision observed while resolving. */
  readonly revision: number
  readonly committed: number
}

/** Failed preparation excludes one intent snapshot, not a dispatched model identity. */
const preparationKey = (candidate: Candidate) =>
  JSON.stringify([
    modelKey(candidate.ref),
    candidate.ref.variant ?? null,
    candidate.revision,
    candidate.staged === undefined
      ? ["committed", candidate.committed]
      : [
          "staged",
          modelKey(candidate.staged),
          candidate.staged.variant ?? null,
        ],
  ])

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const jobs = yield* Job.Service
    const title = yield* SessionTitle.Service
    const config = yield* Config.Service
    const fallbackIntent = yield* FallbackRuntimeIntent.Service
    const steps = yield* SessionStep.make
    const pty = yield* PersistentPty.Service
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    // Each drain is one turn and starts its own trace, whatever fiber woke it.
    const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input: DrainInput) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      let stepped = input.stepped ?? false
      const promotable = input.promotable ?? "input"
      // Fallback identities this active turn already dispatched. Transient, never persisted and never written
      // to the Session's own model: it survives a move/reload handoff or a tool-driven continuation of the SAME
      // turn, and is reset when new input begins a new turn.
      const attempted = new Set<string>(input.continuation?.attempted)
      if (!force && !continuing && !stepped) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing ? { step, attempted } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction") {
                    const candidateID = SessionCompaction.manualCandidateID(next.id)
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, {
                        sessionID,
                        reason: "manual",
                        inputID: next.id,
                        candidateID,
                      }],
                    ])
                  }
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
                // Genuinely new input begins a new turn, so a fallback this turn already dispatched is eligible
                // again. Reconstructing a Location graph for the SAME turn never reaches here and keeps the set.
                attempted.clear()
              }
              if (pending?.type === "move")
                return DrainResult.Moved({
                  continuation: continuing ? { step, attempted } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              if (pending?.type === "compaction") {
                const candidateID = SessionCompaction.manualCandidateID(pending.id)
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session, {
                      kind: "compaction",
                      agent: selected.agent.id,
                    })
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      candidateID,
                      started: true,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        candidateID,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                    candidateID: SessionCompaction.manualCandidateID(pending.id),
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Control-only drains such as a manual compaction never ran the model, so they skip the hook.
                if (pending || !stepped) return DrainResult.Complete()
                // The Session would go idle; a plugin may admit input to keep this execution working.
                yield* restore(
                  SessionBackground.outstanding(jobs, store, sessionID).pipe(
                    Effect.flatMap((background) =>
                      hooks.trigger("session", "experimental.idle", { sessionID, background }),
                    ),
                  ),
                )
                if (!(yield* SessionInbox.has(db, sessionID, "input"))) return DrainResult.Complete()
                continue
              }
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  const loaded = yield* context.load(selected)
                  return { _tag: "Ready" as const, context: loaded }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        continuing = yield* runStep(next.context, step, input.interruption, attempted)
        stepped = true
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      interruption: DrainInput["interruption"],
      /** Fallback identities this active turn already dispatched; shared across handoff of the same turn. */
      attempted: Set<string>,
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      let retryAttempt: number | undefined
      // A fallback model is attempted only after a retry's backoff, at most once per model identity, and only
      // for that attempt: the Session's primary model is never rewritten to try it.
      let recoveryPending = false
      // The prepared but undispatched generation, with the intent tokens that justified it. Automatic compaction
      // can run before that attempt and reloads the context; the candidate survives that reload rather than
      // being chosen again, which could retarget the model or consume the attempted-identity guard without
      // dispatching anything.
      let candidate: Candidate | undefined
      // While a distinct-only recovery is pending, the cause its failed attempt carried: such a turn sends no
      // further primary request, so with no eligible distinct identity this is the failure to reproduce.
      let distinctRecovery: AIError | undefined
      // The model the latest accepted dispatch used; a fallback that resolves to it is not a recovery.
      let currentModel = first.model.ref
      // Failed preparations earn no physical attempted-identity credit.
      // Exclude only the failed intent snapshot until another generation dispatches.
      // A newer accepted intent can reconsider the same undispatched identity.
      const failedPreparations = new Set<string>()
      // FR-025's primary half: the model this logical request started with. A retry that has no fallback to use
      // continues on THIS value, so a primary the user selects during this request's backoff cannot relabel the
      // request that is already underway. `currentModel` keeps tracking what the latest attempt actually served.
      const requestModel = first.model.ref
      /**
       * FR-008 (S2): the fallback for the attempt after a retry's backoff is resolved after the backoff
       * finished and immediately before the physical dispatch, never from a request-start snapshot:
       * current validated active intent first, otherwise the latest successfully committed fallback
       * (so a committed update whose staged intent has cleared is still honored, and a failed newer
       * intent that cleared exposes the committed value), otherwise the legacy default. Undefined when
       * disabled (explicit null), unresolvable here, already tried this turn, or resolving to the model
       * already in use, in which case the retry simply continues. Nothing is credited here: attempted identity
       * belongs to the generation that physically reached the provider, so a prepared candidate that is
       * superseded consumes nothing.
       */
      const resolveFallback = Effect.fnUntraced(function* (selection: SessionContext.Selection) {
        // The staged runtime intent outranks the committed value; when it is absent, the committed
        // configuration is read fresh at this boundary. `config.entries()` is the protected read, so
        // a pending commit is reconciled (or the read fails) instead of resolving against a stale
        // document, and the outcome can never be an older recorded value. A staged override answers the
        // choice with NO read at all, and if the staged revision moved across a read that is still in flight,
        // the value that read returned is discarded and the choice is re-resolved before the dispatch.
        let staged: Model.Ref | undefined
        let revision = 0
        let committed = 0
        const choice = yield* Effect.gen(function* () {
          while (true) {
            const before = yield* fallbackIntent.current()
            revision = before.revision

            // A validated staged value wins. In particular, an explicit null
            // disables recovery without touching the committed configuration.
            if (before.override.type === "some") {
              if (before.override.value !== null) staged = selectionRef(before.override.value)
              return before.override.value
            }

            committed = yield* fallbackIntent.committedRevision()
            // Only an absent staged override requires a protected disk-backed read.
            const resolved = ConfigFallback.resolve(
              Config.latest(yield* config.entries(), "fallback"),
            )

            const after = yield* fallbackIntent.current()

            // Intent changed while the protected read was in progress.
            // Re-resolve instead of dispatching from an obsolete snapshot.
            if (
              after.revision !== before.revision ||
              after.override.type !== "none"
            ) {
              continue
            }

            return resolved
          }
        })
        if (choice === null) return undefined
        const fallback = selectionRef(choice)
        // An agent model override wins over the configured fallback, and serving the model already in use is
        // not a recovery, so the retry continues on it instead.
        const served = yield* context
          .resolveModel(
            { ...selection.session, model: fallback },
            { kind: "primary", agent: selection.agent.id },
          )
          .pipe(Effect.orElseSucceed(() => undefined))
        if (served === undefined) return undefined
        return { ref: served.ref, staged, revision, committed } satisfies Candidate
      })
      /**
       * FR-008's freshness half, asked at every boundary below: is the prepared generation still the newest
       * accepted intent? Cheap by construction, since it consults the staged intent and, for a committed-tier
       * choice, that document's revision, and never repeats the protected read. A staged value that changed,
       * was retired or was replaced supersedes the prepared generation, which then re-resolves at the next
       * boundary; an unchanged candidate stays valid, so nothing rebuilds repeatedly.
       */
      const fresh = Effect.fnUntraced(function* (forCandidate: Candidate | undefined) {
        if (forCandidate === undefined) return true
        const current = yield* fallbackIntent.current()
        if (current.override.type === "some" && current.override.value !== null) {
          // A staged intent decides what the next generation serves, so a candidate chosen from staging stands
          // only while that SAME staged value at that SAME revision is still authoritative. A newly staged value
          // supersedes an older staged candidate even when its provider, model and variant happen to coincide,
          // because the newer accept is what the next dispatch must serve.
          return (
            forCandidate.staged !== undefined &&
            current.revision === forCandidate.revision &&
            sameRef(selectionRef(current.override.value), forCandidate.staged)
          )
        }
        // Nothing is staged now: a choice a staged override made is stale, because the committed tier is
        // effective again, and a committed choice stands only while no newer staged revision landed and no
        // newer document committed.
        if (forCandidate.staged !== undefined) return false
        return (
          current.revision === forCandidate.revision &&
          (yield* fallbackIntent.committedRevision()) === forCandidate.committed
        )
      })
      const chooseFallback = Effect.fnUntraced(function* (selection: SessionContext.Selection) {
        while (true) {
          const resolved = yield* resolveFallback(selection)
          if (resolved === undefined) return undefined

          // Model resolution can suspend. Do not terminate recovery by excluding
          // an obsolete snapshot when a newer intent became authoritative there.
          if (!(yield* fresh(resolved))) continue

          const identity = modelKey(resolved.ref)
          if (
            identity === modelKey(currentModel) ||
            attempted.has(identity) ||
            failedPreparations.has(preparationKey(resolved))
          )
            return undefined

          return resolved
        }
      })
      /**
       * Discards a prepared generation superseded before it went out: no `Step.Started`, no retry event, no
       * attempt telemetry, no physical-attempt credit and no attempted identity for it, and no stale request
       * is served. The next pass through this loop re-resolves the newest eligible candidate and rebuilds its
       * resolved model, variant, options and model-specific history.
       */
      const superseded = Effect.fnUntraced(function* () {
        candidate = undefined
        recoveryPending = true
        initial = undefined
      })
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const pendingRecovery = recoveryPending
        recoveryPending = false
        let loaded = initial
        initial = undefined
        if (loaded === undefined) {
          const selection = yield* prepareContext(sessionID)
          // Resolved at the boundary where this attempt's retry backoff finished. A reload caused by pre-attempt
          // compaction keeps that candidate rather than choosing again, which could retarget the model or
          // consume the attempted-identity guard without dispatching anything.
          if (pendingRecovery) candidate = yield* chooseFallback(selection)
          // A distinct-only recovery has no other primary request it could fall back onto, so an ineligible,
          // disabled or unresolvable candidate ends the turn with the failure its failed attempt carried.
          if (pendingRecovery && candidate === undefined && distinctRecovery !== undefined)
            return yield* Effect.failCause(Cause.fail(distinctRecovery))
          // A retry keeps the model attribution it started with: the fallback chosen for it, otherwise the model
          // this request began on. Everything else in the reload is still re-read by `prepareContext`, so plugins,
          // agents, tools, instructions and the history window behave exactly as the accepted reload tests require.
          // A reload that is not a retry (pre-attempt or overflow compaction) keeps reading the current selection,
          // which is what `reloads a model switch ...` and the overflow cases depend on.
          const recoveryModel = candidate?.ref ?? (pendingRecovery ? requestModel : undefined)
          loaded = yield* context.load(
            recoveryModel
              ? { ...selection, session: { ...selection.session, model: recoveryModel } }
              : selection,
          )
          // Freshness checkpoint 2: asynchronous model resolution and model-specific history loading have both
          // suspended since the candidate was chosen.
          if (!(yield* fresh(candidate))) {
            yield* superseded()
            continue
          }
        }
        const estimate = SessionCompaction.estimatePrompt(loaded)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        // Freshness checkpoint 3: automatic/preflight compaction has suspended. A summary that already ran keeps
        // its own attribution, and only the generation that had not gone out yet is re-selected.
        if (!(yield* fresh(candidate))) {
          yield* superseded()
          continue
        }
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.request
          .primary({
            session: loaded.session,
            agent: loaded.agent.id,
            model: loaded.model,
            tools: loaded.tools,
            system: transcript.system,
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
            // Keep tool definitions on the final Step to preserve the provider's cached prefix.
            toolChoice: stepLimitReached ? "none" : undefined,
            webSocket: "session",
            inputTokens: estimate,
          })
          .pipe(
            // The hook event holds every message from before images are bounded, screenshots included, and is a separate
            // copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the slowest tool,
            // so they keep only what they use.
            Effect.map((prepared) => ({
              request: prepared.request,
              options: prepared.options,
              retry: prepared.retry,
              executeTool: prepared.executeTool,
            })),
          )
        // Freshness checkpoint 4: request preparation and its plugin hooks have suspended. A candidate that
        // moved during that window is discarded before `Step.Started` can be published for it.
        if (!(yield* fresh(candidate))) {
          yield* superseded()
          continue
        }
        let dispatched = false
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          interruption,
          handoffPrepared: pty.handoffPrepared,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared: {
            ...prepared,
            // A tool call can arrive during a reload; its permission check reads the session's agent.
            executeTool: (call) => plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
          },
          retryAttempt,
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: loaded.agent.id,
              model: loaded.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          onDispatch: () => {
            dispatched = true
            failedPreparations.clear()
            currentModel = loaded.model.ref
            attempted.add(modelKey(loaded.model.ref))
          },
          // Freshness checkpoint 5: asked one last time by the attempt, immediately before it consumes the
          // provider stream, so an intent accepted during any earlier preparation cannot be outrun by this
          // already-prepared request.
          fresh: fresh(candidate),
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow
              ? compaction
                  .compact({ reason: "overflow", context: loaded, estimate })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        // A generation that reached the provider is spent, and only such a generation earns attempted-identity
        // credit: a provisional candidate superseded at checkpoint 5 credits nothing and dispatches nothing.
        if (outcome._tag === "Superseded") {
          yield* superseded()
          continue
        }
        // A typed preparation failure before the dispatch seam is not an attempt. Exclude only that resolved
        // intent snapshot; an accepted dispatch clears this transient set, so the identity is eligible again
        // later in the same turn. Primary preparation failure has no fallback candidate and stays on its
        // ordinary retry policy.
        if (
          !dispatched &&
          candidate !== undefined &&
          (outcome._tag === "Retry" || outcome._tag === "DistinctOnly")
        )
          failedPreparations.add(preparationKey(candidate))
        candidate = undefined
        retryAttempt = undefined
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            return outcome.needsContinuation
          }),
          Retry: Effect.fnUntraced(function* (outcome) {
            retryAttempt = outcome.decision.attempt
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            if (outcome.freshAssistant) assistantMessageID = SessionMessage.ID.create()
            // The backoff finished, so this is the boundary where a fallback attempt may start.
            recoveryPending = true
            distinctRecovery = undefined
          }),
          // Distinct-only recovery: an ordinary retry was declined or exhausted after this attempt settled durably
          // and safely. No retry event, no backoff wait and no further primary request: the next generation must
          // be served by a freshly resolved, DIFFERENT provider/model identity, on a fresh assistant, carrying
          // the already durable settled tool results through history rather than executing them again.
          DistinctOnly: Effect.fnUntraced(function* (outcome) {
            recoveryPending = true
            distinctRecovery = outcome.cause
            assistantMessageID = SessionMessage.ID.create()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
          // Unreachable here: the check above already restarted the loop for it. Included so the policy stays
          // total over `SessionStep.Outcome`.
          Superseded: Effect.fnUntraced(function* () {}),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          // Candidate rows are settled by identity; a legacy running row has no candidate to name.
          ...(message.candidateID === undefined ? {} : { candidateID: message.candidateID }),
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* SessionHistory.incompleteAssistants(db, sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({
      drain: (input) => drain(input).pipe(Effect.annotateSpans("session.id", input.sessionID)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    requestExecutor,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    Config.node,
    FallbackRuntimeIntent.node,
    SessionCompaction.node,
    Plugin.node,
    PluginHooks.node,
    Job.node,
    SessionTitle.node,
    Snapshot.node,
    PersistentPty.node,
    ToolOutput.node,
    Database.node,
  ],
})
