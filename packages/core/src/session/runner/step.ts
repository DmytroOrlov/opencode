export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  isContextOverflowFailure,
  type ToolCall,
} from "@opencode/ai/effect"
import { RequestExecutor } from "@opencode/ai/route"
import { attachMlxObserver } from "@opencode/ai/telemetry/mlx"
import { createSplashObserver } from "@opencode/ai/telemetry/splash"
import type { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Cause, Clock, Data, Deferred, Effect, Exit, Fiber, Option, Ref, Stream, Tracer } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"
import { closeTelemetry, createFallback } from "./telemetry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
    readonly freshAssistant?: boolean
  }
  RecoverFull: {}
  Compacted: {}
  OutputLimit: { readonly needsContinuation: boolean }
  /**
   * An ordinary retry was declined or exhausted, yet the failed attempt settled durably and left no call
   * with an unknown external effect, so a DIFFERENT provider/model identity may serve the next generation
   * without a retry event or backoff. `cause` is the original failing error, so a runner that finds no
   * eligible identity reproduces this exact terminal failure instead of inventing a new one. Nothing else travels
   * with the outcome: the runner re-reads the settlement facts it needs — a fresh assistant, the durable history
   * and the settled tool records — from its own state, so an unused field here could only drift from them.
   */
  DistinctOnly: {
    readonly cause: AIError
  }
  /** The prepared generation was no longer the newest accepted intent when the provider was about to run. */
  Superseded: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  /** Why the execution is being interrupted, once it is: `"user"` when someone stopped it. */
  readonly interruption?: () => "user" | "shutdown" | undefined
  /** Whether this server is handing its process daemon over to the next one (see `PersistentPty.handoffPrepared`). */
  readonly handoffPrepared?: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  /** Set when this attempt runs because an earlier one in the step scheduled a retry. */
  readonly retryAttempt?: number
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
  /** Called synchronously once the accepted dispatch seam claims the physical attempt. */
  readonly onDispatch?: () => void
  /**
   * Asked one last time at the provider-consumption boundary. A prepared generation whose fallback
   * intent has since been superseded is discarded here, before this attempt takes any span, attempt
   * credit or telemetry.
   */
  readonly fresh?: Effect.Effect<boolean>
}

export function selectTelemetryAdapter(model: Pick<SessionRunnerModel.Resolved, "mlxTelemetry" | "splashTelemetry">) {
  if (model.mlxTelemetry === true) return "mlx"
  if (model.splashTelemetry === true) return "splash"
  return undefined
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const
const RESULT_UNRECORDED = {
  type: "tool.result-missing",
  message: "Tool result could not be durably recorded",
} as const

let telemetryAttemptSequence = 0

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const executor = yield* RequestExecutor.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  // The physical attempt: its span, attempt identity, telemetry and attempt credit begin only once the claim below
  // has accepted the prepared generation, so a superseded generation owns none of them.
  const attempt = Effect.fnUntraced(function* (input: Input) {
    const publish = Effect.runPromiseWith(yield* Effect.context())
    let telemetryOpen = true
    let telemetryCompleted = false
    let providerDecodeAccepted = false
    let prefill: SessionEvent.TelemetryMeasurement | undefined
    let decode: SessionEvent.TelemetryMeasurement | undefined
    let telemetryPublication = Promise.resolve()
    const telemetryAbort = new AbortController()
    // The attempt's identity is allocated BY the claim, and while it is absent `queueTelemetry` publishes nothing.
    // An observer that attaches earlier — the MLX attach below can suspend — may therefore buffer measurements into
    // `prefill`/`decode` for the claimed attempt to publish, but it can never put a queued event ahead of the claim,
    // which is what `closeTelemetry` could not undo once one had already been queued.
    let claimed: { readonly id: Event.ID; readonly sequence: number } | undefined
    const queueTelemetry = (phase: SessionEvent.Telemetry["data"]["phase"]) => {
      if (claimed === undefined) return
      const measurements = [prefill, decode].filter(
        (value): value is SessionEvent.TelemetryMeasurement => value !== undefined,
      )
      const data = {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        attemptID: claimed.id,
        attemptSequence: claimed.sequence,
        phase,
        measurements,
      }
      telemetryPublication = telemetryPublication.then(
        () => publish(bus.publish(SessionEvent.Telemetry, data)).then(() => undefined, () => undefined),
        () => undefined,
      )
    }
    const observeTelemetry = (
      observation:
        | { readonly phase: "prefill"; readonly processed: number; readonly total: number }
        | { readonly phase: "decode"; readonly tokensPerSecond: number },
      source: "provider-native" | "estimated",
    ) => {
      if (!telemetryOpen) return
      if (observation.phase === "prefill") {
        if (
          !Number.isFinite(observation.processed) ||
          observation.processed < 0 ||
          !Number.isFinite(observation.total) ||
          observation.total <= 0 ||
          observation.processed > observation.total ||
          (prefill?.metric === "prefill-progress" &&
            (prefill.total !== observation.total || prefill.processed >= observation.processed))
        )
          return
        prefill = {
          metric: "prefill-progress",
          processed: observation.processed,
          total: observation.total,
          source,
          approximate: source === "estimated",
        }
        queueTelemetry("prefill")
        return
      }
      if (!Number.isFinite(observation.tokensPerSecond) || observation.tokensPerSecond <= 0) return
      if (source === "estimated" && providerDecodeAccepted) return
      if (source === "provider-native") {
        providerDecodeAccepted = true
        if (decode?.source === "estimated") decode = undefined
      }
      decode = {
        metric: "decode-rate",
        tokensPerSecond: observation.tokensPerSecond,
        source,
        approximate: source === "estimated",
      }
      queueTelemetry("decode")
    }
    const fallback = createFallback({
      observe: (observation) => observeTelemetry(observation, "estimated"),
      suppressed: () => providerDecodeAccepted || !telemetryOpen,
    })
    const telemetryAdapter = selectTelemetryAdapter(input.model)
    let mlxObserver: { readonly finalize: () => void; readonly discard: () => void } | undefined
    const splashObserver =
      telemetryAdapter !== "splash"
        ? undefined
        : createSplashObserver({
            observe: (observation) => observeTelemetry(observation, "provider-native"),
          })

    if (telemetryAdapter === "mlx") {
      const attach = attachMlxObserver({
        endpoint: input.prepared.request.model.route.endpoint.baseURL,
        auth: input.prepared.request.model.route.auth,
        request: input.prepared.request,
        signal: telemetryAbort.signal,
        observe: (observation) => observeTelemetry(observation, "provider-native"),
      })
      const hooked =
        input.prepared.options.http === undefined
          ? attach
          : RequestExecutor.withMiddleware(input.prepared.options.http)(attach)
      mlxObserver = yield* hooked.pipe(
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    }

    // The fast freshness gate: reject a candidate already superseded before doing any attempt-owned work.
    if (input.fresh !== undefined && !(yield* input.fresh)) {
      // Nothing reached the provider: release the observers and abort their signal without queueing a single
      // telemetry event, so the discarded generation takes no attempt credit and no `Step.Started`.
      closeTelemetry({
        completed: false,
        finalize: () => undefined,
        discard: () => {
          mlxObserver?.discard()
          splashObserver?.discard()
          fallback.discard()
        },
        abort: () => telemetryAbort.abort(),
      })
      return Outcome.Superseded()
    }
    // The physical attempt owns no span, attempt sequence or telemetry until the AI dispatch seam accepts it. The
    // claim below is deliberately later than the early gate: lazy request compilation and transport preparation
    // (including async authentication) suspend after the step begins, so this is the last point that can observe a
    // newer accepted intent without crediting or publishing the superseded generation.
    const dispatchSuperseded = yield* Ref.make(false)
    let attemptSpan: Tracer.Span | undefined
    const physical = Effect.fnUntraced(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          attemptSpan?.end(yield* Clock.currentTimeNanos, Exit.void)
          if (!telemetryOpen) return
          if (telemetryCompleted) {
            closeTelemetry({
              completed: true,
              finalize: () => {
                mlxObserver?.finalize()
                splashObserver?.finalize()
                fallback.finalize()
              },
              discard: () => undefined,
              abort: () => telemetryAbort.abort(),
            })
            telemetryOpen = false
            queueTelemetry("complete")
            return
          }
          telemetryOpen = false
          closeTelemetry({
            completed: false,
            finalize: () => undefined,
            discard: () => {
              mlxObserver?.discard()
              splashObserver?.discard()
              fallback.discard()
            },
            abort: () => telemetryAbort.abort(),
          })
          prefill = undefined
          decode = undefined
          queueTelemetry("discard")
        }),
      )

      // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
      // so it is captured while the provider request is in flight instead of delaying it.
      const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
      const started = yield* Clock.currentTimeMillis
      let firstOutputAt: number | undefined
      const modelAttributes = {
        "gen_ai.provider.name": input.model.ref.providerID,
        "gen_ai.request.model": input.model.ref.id,
      }
      const publisher = createLLMEventPublisher(bus, {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        agent: input.agent,
        model: input.model.ref,
        providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
        pendingSnapshot: Fiber.join(pendingStartSnapshot),
        started,
      })
      const toolRuns: Array<{
        readonly call: ToolCall
        readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
        readonly cancel: Cancel
      }> = []
      const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
      // A user's stop asks each tool awaiting `cancel` to stop and settle its own call, and interrupts every other
      // tool. A tool that does not settle in time is interrupted too. Teardown interrupts every tool.
      const stopTools = Effect.suspend(() => {
        // A reloaded Location still serves the steps that borrow it, so its tools can stop on their own too.
        const user = input.interruption?.() === "user"
        const immediate = toolRuns.flatMap((run) => (user && run.cancel.trigger() ? [] : [run.fiber]))
        return Fiber.interruptAll(immediate).pipe(
          Effect.andThen(Fiber.awaitAll(toolRuns.map((run) => run.fiber)).pipe(Effect.timeoutOption(COOPERATIVE_STOP))),
          Effect.flatMap((settled) => (Option.isSome(settled) ? Effect.void : interruptTools)),
        )
      })
      const executeTool = (call: ToolCall, cancel: Cancel) => {
        if (input.prepared.request.toolChoice?.type === "none")
          return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
        return input.prepared.executeTool({
          sessionID: input.sessionID,
          agent: input.agent,
          messageID: input.assistantMessageID,
          call,
          progress: (update) => publisher.progress(call.id, update),
          cancel: cancel.effect,
        })
      }
      // Attempt-owned work starts only after the final dispatch seam answers yes. Setup above is harmless; an
      // accepted C during lazy compile/auth therefore discards B before it owns a span, sequence, request or event.
      const claimAttempt = Effect.fnUntraced(function* () {
        claimed = { id: Event.ID.create(), sequence: ++telemetryAttemptSequence }
        attemptSpan = yield* Effect.makeSpan("SessionStep.attempt", {
          attributes: {
            ...modelAttributes,
            "gen_ai.agent.name": input.agent,
            ...(input.retryAttempt === undefined ? {} : { "opencode.retry.attempt": input.retryAttempt }),
          },
        })
        queueTelemetry("start")
      })
      const annotateAttempt = (attributes: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(attributes)) attemptSpan?.attribute(key, value)
      }
      const beforeDispatch = Effect.gen(function* () {
        if (input.fresh !== undefined && !(yield* input.fresh)) {
          yield* Ref.set(dispatchSuperseded, true)
          return false
        }
        yield* claimAttempt()
        input.onDispatch?.()
        return true
      })

      // Provider and tool fibers retain per-source order without a shared writer queue.
      // A local execution starts only after its Tool.Called publication completes.
      // Read to the end, not just the finish event, so the next request can reuse this response.
      // The span covers only the provider stream, so model time separates from tools, which run in this consumer.
      // Splash exposes its measurements on the already-decoded frames of this same request, so the observer rides
      // into the stream the attempt is actually executing rather than a second one.
      const providerOptions = {
        ...(splashObserver
          ? { ...input.prepared.options, observeFrame: splashObserver.observeFrame }
          : input.prepared.options),
        beforeDispatch,
        // Opened by the AI seam only after `beforeDispatch` accepts, so the provider span is a child of the attempt
        // that actually dispatched and a discarded generation opens none.
        dispatchSpan: () =>
          attemptSpan === undefined
            ? undefined
            : { name: "LLM.stream", options: { parent: attemptSpan, attributes: modelAttributes } },
      }
      const providerStream = llm.stream(input.prepared.request, providerOptions).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (publisher.record().providerFailed) return
            // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
            if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
            // The estimator only reads the events, so it sees exactly what the publisher publishes.
            fallback.push(event)
            yield* publisher.publish(event)
            if (firstOutputAt === undefined && publisher.record().outputStarted)
              firstOutputAt = yield* Clock.currentTimeMillis
            if (event.type !== "tool-call" || event.providerExecuted) return
            const cancel = makeCancel()
            toolRuns.push({
              call: event,
              cancel,
              fiber: yield* Effect.uninterruptibleMask((restore) =>
                restore(executeTool(event, cancel)).pipe(
                  Effect.flatMap(toolOutput.truncate),
                  Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                  Effect.catchTag("Tool.Error", (error) =>
                    publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                  ),
                ),
              ).pipe(Effect.forkScoped),
            })
          }),
        ),
        Effect.ensuring(publisher.flush()),
      )

      // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          // The AI dispatch seam rejected the prepared request after lazy compile/auth. It never reached the
          // provider, so return the distinct non-provider outcome before any retry, settlement or telemetry logic.
          if (yield* Ref.get(dispatchSuperseded)) return Outcome.Superseded()
          const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
          const streamInterrupted = Exit.hasInterrupts(stream)
          // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
          if (
            Exit.isFailure(stream) &&
            streamInterrupted &&
            !publisher.hasStarted() &&
            !pendingStartSnapshot.pollUnsafe()
          )
            return yield* Effect.failCause(stream.cause)
          if (publisher.hasStarted()) yield* publisher.streamed()
          if (streamInterrupted) yield* stopTools
          const fibers = toolRuns.map((run) => run.fiber)
          const joined = yield* restore(Fiber.awaitAll(fibers)).pipe(Effect.exit)
          if (!streamInterrupted && Exit.isFailure(joined)) yield* stopTools
          // Read each tool's exit once all have ended, so what they raised while stopping (a decline, a defect) counts.
          const exits = Exit.isSuccess(joined) ? joined.value : yield* Fiber.awaitAll(fibers)
          const tools = classifyToolExits(exits, toolRuns, Exit.hasInterrupts(joined))
          // A server handing its process daemon over leaves the step as a crash would: unsettled calls and no step end.
          // The next server settles them when the Session resumes, and takes over the shell commands still running for
          // them. Any other interrupt settles the calls here.
          if (
            (streamInterrupted || tools.interrupted) &&
            tools.declines.length === 0 &&
            input.interruption?.() !== "user" &&
            input.handoffPrepared?.() === true
          )
            return yield* Effect.interrupt

          if (
            !publisher.record().outputStarted &&
            isContextOverflowFailure(streamFailure) &&
            (yield* restore(input.recoverOverflow))
          ) {
            yield* Effect.logWarning("provider rejected the request as too long; compacting", {
              sessionID: input.sessionID,
              model: input.model.ref,
              message: streamFailure?.message,
            })
            return Outcome.Compacted()
          }

          const recorded = publisher.record()
          // Read the attempt's own tool settlement HERE, once every tool fiber has ended and before the
          // cleanup below can synthesize a terminal event for a call that never produced one itself.
          const toolFacts = publisher.toolFacts()
          // Replay safety, asked once every tool fiber has ended and before any cleanup below can synthesize a
          // terminal event for a call that never produced one itself. Only AFFIRMATIVE evidence counts: a local
          // call's own durable result, or a hosted call the provider itself answered (a provider-returned error
          // result included, because the provider answered for it). A local call that ended in a failure IT published
          // settled its RECORD, not the question of what it already did — an edit that wrote files and then failed
          // to persist its output is exactly that case — so it disqualifies BOTH an ordinary retry and a distinct
          // generation, whose next request could ask the model to run that call again. A tool fiber that ended
          // in a DEFECT disqualifies them too: whatever `toolFacts` says about its record, the call's own code
          // raised, so the record cannot be trusted as evidence that the external effect is known, and `tools.failure`
          // is the fact that a publisher bug or a late defect cannot be argued away.
          const replaySafe =
            tools.failure === undefined &&
            toolFacts.local.failures === 0 &&
            toolFacts.local.unresolved === 0 &&
            toolFacts.hosted.unresolved === 0
          // A call that was claimed, settled, and then failed to publish its result must still be terminal in
          // durable history before the assistant completes. `toolFacts` was read above, so this repair cannot
          // grant ordinary retry or distinct recovery; it only prevents a later turn from reconstructing an
          // assistant tool-call with no corresponding tool result.
          yield* publisher.failUnrecordedTools(RESULT_UNRECORDED)
          const unknownFinish =
            Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
              ? new AIError({
                  reason: new InvalidProviderOutputError({
                    message: "The provider response ended with an unknown finish reason.",
                    classification: "incomplete-stream",
                  }),
                })
              : undefined
          const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
          const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
          const tokens = recorded.finish?.usage
          const attemptAttributes = {
            ...(firstOutputAt === undefined ? {} : { "opencode.llm.first_output_ms": firstOutputAt - started }),
            ...(recorded.finish === undefined ? {} : { "gen_ai.response.finish_reasons": [recorded.finish.finish] }),
            ...(tokens?.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": tokens.inputTokens }),
            ...(tokens?.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": tokens.outputTokens }),
            ...(tokens?.cacheReadInputTokens === undefined
              ? {}
              : { "gen_ai.usage.cache_read.input_tokens": tokens.cacheReadInputTokens }),
            ...(tokens?.cacheWriteInputTokens === undefined
              ? {}
              : { "gen_ai.usage.cache_creation.input_tokens": tokens.cacheWriteInputTokens }),
            ...(llmFailure === undefined ? {} : { "error.type": llmFailure.reason._tag }),
          }
          yield* Effect.annotateCurrentSpan(attemptAttributes)
          annotateAttempt(attemptAttributes)
          if (
            input.recoverContinuation &&
            llmFailure?.reason._tag === "Transport" &&
            (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
            !recorded.outputStarted
          )
            return Outcome.RecoverFull()
          const retry =
            llmFailure && llmError && !isContextOverflowFailure(llmFailure)
              ? yield* restore(
                  input.retry(
                    llmFailure,
                    llmError,
                    SessionRunnerRetry.isRetryable(llmFailure) ||
                      (recorded.outputStarted && isInterruptedStream(llmFailure)),
                  ),
                )
              : undefined
          // Ordinary retry before any output: same interruption/decline safety conditions as the branches below, so
          // a step whose tools declined, were interrupted, were defective (through `replaySafe`) or were stopped by
          // the user never re-asks its provider request.
          if (
            llmError &&
            replaySafe &&
            retry?.retry &&
            tools.declines.length === 0 &&
            !tools.interrupted &&
            !streamInterrupted &&
            input.interruption?.() !== "user" &&
            !recorded.outputStarted
          ) {
            // Retry state projects onto the existing assistant, even before it has produced output.
            yield* publisher.startAssistant()
            return Outcome.Retry({ error: llmError, decision: retry })
          }
          if (llmError) yield* publisher.failAssistant(llmError)

          for (const decline of tools.declines)
            yield* publisher.failTool(decline.call.id, {
              type: "aborted",
              message: input.isLocationClosed()
                ? "Interaction cancelled because the location shut down"
                : decline.reason._tag === "QuestionTool.CancelledError"
                  ? decline.reason.message
                  : "The user declined this tool call",
            })
          const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
          const toolFailure = interrupted
            ? TOOLS_INTERRUPTED
            : tools.failure !== undefined
              ? toSessionError(Cause.squash(tools.failure))
              : recorded.providerFailed
                ? TOOLS_INTERRUPTED
                : undefined
          if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
          if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

          // Parsers may leave unfinished calls without an execution event.
          if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
            const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
            if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
            yield* publisher.failIncompleteTools()
          }

          const record = publisher.record()
          if (record.finish || record.failure) {
            const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
            const snapshot = yield* snapshots.capture()
            const files =
              startSnapshot && snapshot
                ? startSnapshot === snapshot
                  ? []
                  : yield* snapshots
                      .files({ from: startSnapshot, to: snapshot })
                      .pipe(Effect.orElseSucceed(() => undefined))
                : undefined
            const usage = record.finish ? SessionUsage.record(record.finish.usage, input.model.cost) : undefined
            if (usage) {
              yield* Effect.annotateCurrentSpan("opencode.usage.cost_usd", usage.cost)
              attemptSpan?.attribute("opencode.usage.cost_usd", usage.cost)
            }
            if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
            if (record.finish && usage && !record.failure)
              yield* bus.publish(SessionEvent.Step.Ended, {
                sessionID: input.sessionID,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: record.finish.finish,
                rawFinish: record.finish.rawFinish,
                native: record.finish.native,
                ...usage,
                snapshot,
                files,
              })
          }

          if (llmError && replaySafe && retry?.retry && tools.declines.length === 0 && !tools.interrupted)
            return Outcome.Retry({ error: llmError, decision: retry, freshAssistant: true })

          // Distinct-only recovery. An ordinary retry was declined by the classifier or the hook, or its schedule
          // ran out, yet this failed attempt settled durably and no call left an unknown external effect, so the
          // runner may serve the next generation from a DIFFERENT provider/model identity — with no retry event,
          // no backoff and no further primary request. `cause` carries the original failure so a runner that finds
          // no eligible identity reproduces this terminal failure exactly.
          if (
            llmError &&
            replaySafe &&
            retry !== undefined &&
            !retry.retry &&
            tools.declines.length === 0 &&
            !tools.interrupted &&
            !streamInterrupted &&
            input.interruption?.() !== "user" &&
            Exit.isFailure(stream) &&
            streamFailure instanceof AIError &&
            streamFailure.reason._tag !== "ContentPolicy"
          )
            return Outcome.DistinctOnly({ cause: streamFailure })

          // A provider stream that ended cleanly is not yet evidence that the attempt settled: its local tools may
          // still decline, interrupt, or fail to settle afterwards, and those settlements publish a durable failure.
          // Only a fully settled attempt closes its telemetry; every return above (handoff interruption, compaction,
          // full recovery, retry, cancellation) leaves it false, so the finalizer discards the attempt's measurements.
          const settledAttempt =
            Exit.isSuccess(stream) &&
            !streamInterrupted &&
            record.finish !== undefined &&
            record.finish.finish !== "unknown" &&
            !record.providerFailed &&
            tools.declines.length === 0 &&
            !tools.interrupted &&
            tools.failure === undefined &&
            record.failure === undefined

          if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
          if (tools.declines.length > 0) {
            if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
            return yield* Effect.interrupt
          }
          if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
          if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
          if (record.failure) return yield* new StepFailedError({ error: record.failure })
          const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
          // Reached only by a genuinely successful attempt, so this is where the terminal telemetry may complete.
          telemetryCompleted = settledAttempt
          if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
          return Outcome.Completed({ needsContinuation })
        }),
      )
    }, Effect.scoped)

    return yield* physical()
  })


  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  exits: ReadonlyArray<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
  // The step was interrupted while it waited for its tools.
  interruptedWhileWaiting: boolean,
) => {
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: interruptedWhileWaiting || causes.some(Cause.hasInterrupts), declines, failure }
}

// How long a user's stop waits for the tools it asked to stop before interrupting them.
const COOPERATIVE_STOP = "5 seconds"

type Cancel = ReturnType<typeof makeCancel>

/**
 * A tool call's `cancel`. `trigger` completes it, and reports whether the tool was awaiting it, so would stop on its
 * own; a tool that was not is interrupted instead.
 */
export const makeCancel = () => {
  let listeners = 0
  let cancelled = false
  const gate = Deferred.makeUnsafe<void>()
  return {
    effect: Effect.suspend(() => {
      if (cancelled) return Effect.void
      listeners++
      return Deferred.await(gate).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            listeners--
          }),
        ),
      )
    }),
    trigger: () => {
      cancelled = true
      if (listeners === 0) return false
      Deferred.doneUnsafe(gate, Exit.void)
      return true
    },
  }
}
