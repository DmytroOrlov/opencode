import { describe, expect, test } from "bun:test"
import { AIError, AuthenticationError, ProviderInternalError, TransportError } from "@opencode/ai/effect"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Bus } from "@opencode/core/bus"
import type { SessionRetry } from "@opencode/plugin/effect/session"
import { Clock, Duration, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { SessionMessage } from "@opencode/core/session/message"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const dnsFailure = new AIError({
  reason: new TransportError({
    message: "getaddrinfo ENOTFOUND opencode.ai",
    transport: "http",
    operation: "request",
    code: "ENOTFOUND",
    url: "https://opencode.ai/zen/v1/responses",
  }),
})
const refused = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ECONNREFUSED",
  }),
})

const unauthorized = new AIError({
  reason: new AuthenticationError({ message: "Unauthorized" }),
})

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("keeps retrying an unreachable host for an hour with gaps of at most 30 seconds", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const delays: number[] = []
      while (true) {
        const decision = yield* policy(input(dnsFailure))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      const waited = (yield* Clock.currentTimeMillis) - started
      expect(delays.length).toBeGreaterThan(100)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)
      expect(waited).toBeGreaterThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW))
      expect(waited).toBeLessThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW) + 30_000)
    }),
  )

  it.effect("keeps a refused connection on the general allowance", () =>
    Effect.gen(function* () {
      expect(ModelRetry.isUnreachable(refused)).toBe(false)
      expect(yield* decisions(refused, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("doesn't spend the general allowance on an unreachable host", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      for (let i = 0; i < 20; i++) expect((yield* policy(input(dnsFailure))).retry).toBe(true)
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("keeps a hook from reviving the exhausted timeout cap", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      // Every decision is asked for with the hook that always asks for another attempt.
      const revive = (event: SessionRetry) => {
        event.decision = { retry: true, delay: 0 }
        return Effect.void
      }
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) results.push((yield* policy({ ...input(timeout), hook: revive })).retry)
      expect(results).toEqual([true, true, true, false, false])

      // The runner sends the first attempt plus one per accepted decision, so an exhausted cap stops
      // the turn at four physical requests rather than letting the hook extend it.
      let physicalAttempts = 1
      for (const retry of results) {
        if (!retry) break
        physicalAttempts++
      }
      expect(physicalAttempts).toBe(4)
    }),
  )

  it.effect("honours a hook that authorizes a retry the classifier declined", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const approve = (event: SessionRetry) => {
        event.decision = { retry: true, delay: 500.4 }
        return Effect.void
      }
      expect(SessionRunnerRetry.isRetryable(unauthorized)).toBe(false)
      const decision = yield* policy({ ...input(unauthorized), hook: approve })
      if (!decision.retry) return yield* Effect.die(new Error("Hook authorization was refused"))
      expect(decision.attempt).toBe(2)
      expect(decision.delay).toBe(501)

      // `wait` keeps scheduling the retry from that decision: one RetryScheduled event whose
      // timestamp is the normalized delay after the wait begins, and a wait that lasts exactly that long.
      const published: Array<Record<string, unknown>> = []
      const bus = {
        publish: (definition: unknown, data: Record<string, unknown>) => {
          published.push(data)
          return Effect.succeed(data)
        },
      } as unknown as Bus.Interface
      const runner = yield* SessionRunnerRetry.make(bus, SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const waited = yield* Deferred.make<void>()
      const waiting = yield* runner
        .wait({
          decision,
          assistantMessageID: SessionMessage.ID.make("msg_retry"),
          error: toSessionError(unauthorized),
        })
        .pipe(Effect.andThen(Deferred.succeed(waited, undefined)), Effect.forkScoped({ startImmediately: true }))
      expect(published.length).toBe(1)
      expect(published[0].attempt).toBe(2)
      expect(published[0].at).toBe(started + 501)
      yield* TestClock.adjust(Duration.millis(500))
      expect(yield* Deferred.isDone(waited)).toBe(false)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.join(waiting)
      expect(yield* Deferred.isDone(waited)).toBe(true)
      expect((yield* Clock.currentTimeMillis) - started).toBe(501)
    }),
  )
})

describe("ModelRetry.retryOneShot", () => {
  it.effect("doesn't replay a call whose response was cut off by the network going down", () =>
    Effect.gen(function* () {
      let calls = 0
      const cutOff = new AIError({
        reason: new TransportError({
          message: "Network is down",
          transport: "http",
          operation: "read",
          code: "ENETDOWN",
        }),
      })
      yield* ModelRetry.retryOneShot(Effect.suspend(() => (calls++, Effect.fail(cutOff)))).pipe(Effect.flip)
      expect(calls).toBe(1)
    }),
  )
})

describe("toSessionError", () => {
  test("names the network when the provider's host can't be reached", () => {
    expect(toSessionError(dnsFailure)).toEqual({
      type: "provider.transport",
      message: "Can't reach opencode.ai. Check the network connection. (getaddrinfo ENOTFOUND opencode.ai)",
    })
    expect(toSessionError(refused)).toEqual({ type: "provider.transport", message: "Unable to connect" })
  })
})
