import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { SessionRecovery } from "../../src/session/recovery"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>, statusCode?: number): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
      statusCode,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, 0))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("adds jitter to exponential delays", () => {
    const error = apiError()
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
    expect(SessionRetry.delay(1, error, 1)).toBe(2500)
    expect(SessionRetry.delay(4, error, 1)).toBe(20000)
    expect(SessionRetry.delay(5, error, 1)).toBe(30000)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, 0)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" }, 503)
      const statuses: Array<number | undefined> = []
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            Effect.gen(function* () {
              statuses.push(info.statusCode)
              yield* status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              })
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
      expect(statuses).toStrictEqual([503, 503])
    }),
  )

  it.instance("policy stops after five retries", () =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const error = apiError({ "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            Effect.sync(() => {
              attempts.push(info.attempt)
            }),
        }),
      )

      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES + 1 }), () =>
        Effect.ignore(step(error)),
      )

      expect(attempts).toStrictEqual([1, 2, 3, 4, 5])
    }),
  )
})

describe("session.retry.retryable", () => {
  const facts = (error: ReturnType<NamedError["toObject"]>, fallback: "available" | "disabled", retryExhausted = false) =>
    SessionRecovery.errorFacts(
      error,
      {
        needsCompaction: false,
        blocked: false,
        executingToolCalls: 0,
        settledExecutedToolCalls: 0,
        fallback:
          fallback === "available"
            ? {
                reason: "available",
                ref: { providerID, modelID: ModelV2.ID.make("fallback") },
                model: undefined as never,
              }
            : { reason: "disabled" },
        retryExhausted,
      },
      SessionRetry.retryable(error, retryProvider) !== undefined,
    )

  test("prefers fallback for model-attempt errors when available", () => {
    const fallback = {
      reason: "available" as const,
      ref: { providerID, modelID: ModelV2.ID.make("fallback") },
      model: undefined as never,
    }
    const errors = [
      wrap("FailedToOpenSocket"),
      wrap("fetch failed"),
      ...[400, 401, 403, 404, 408, 422, 429, 500, 502, 503, 504].map((statusCode) =>
        Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
          new SessionV1.APIError({ message: `HTTP ${statusCode}`, statusCode, isRetryable: false }).toObject(),
        ),
      ),
      wrap("provider rejected the request"),
      wrap("unknown model stream failure"),
    ]

    for (const error of errors) expect(SessionRecovery.decide(facts(error, "available")).type).toMatch(/^failover_/)
    expect(SessionRecovery.decide({ ...facts(wrap("fetch failed"), "available"), fallback })).toEqual({
      type: "failover_restart",
      reason: "replay_safe",
      fallback,
    })
  })

  test("keeps retry and terminal classification when fallback is unavailable", () => {
    const retryableError = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Service unavailable", statusCode: 503, isRetryable: false }).toObject(),
    )
    const rateLimitError = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Rate limited", statusCode: 429, isRetryable: false }).toObject(),
    )
    const terminalError = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Bad request", statusCode: 400, isRetryable: false }).toObject(),
    )

    expect(SessionRecovery.decide(facts(wrap("fetch failed"), "disabled")).type).toBe("retry_current")
    expect(SessionRecovery.decide(facts(retryableError, "disabled")).type).toBe("retry_current")
    expect(SessionRecovery.decide(facts(rateLimitError, "disabled")).type).toBe("retry_current")
    expect(SessionRecovery.decide(facts(terminalError, "disabled")).type).toBe("terminal")
    expect(SessionRecovery.decide(facts(wrap("unknown model stream failure"), "disabled")).type).toBe("terminal")
  })

  test("does not fail over abort or context overflow errors", () => {
    const aborted = new SessionV1.AbortedError({ message: "Aborted" }).toObject()
    const overflow = new SessionV1.ContextOverflowError({ message: "overflow" }).toObject()
    expect(SessionRecovery.decide(facts(aborted, "available")).type).toBe("terminal")
    expect(SessionRecovery.decide(facts(overflow, "available")).type).toBe("terminal")
  })

  test("continues from a settled tool result without fallback", () => {
    const error = wrap("fetch failed")
    expect(
      SessionRecovery.decide({
        ...facts(error, "disabled"),
        settledExecutedToolCalls: 1,
      }),
    ).toEqual({ type: "continue_current", reason: "settled_tool_result" })
  })

  test("classifies transport failures for immediate failover only when available", () => {
    const transport = wrap("fetch failed")
    expect(SessionRecovery.decide(facts(transport, "available")).type).toBe("failover_restart")
    expect(SessionRecovery.decide(facts(transport, "disabled")).type).toBe("retry_current")
  })

  test("preserves and classifies Bun FailedToOpenSocket APICallErrors", () => {
    const error = new APICallError({
      message: "Cannot connect to API: Was there a typo in the url or port?",
      url: "http://remote.invalid/v1/chat/completions",
      requestBodyValues: {},
      isRetryable: true,
      cause: {
        code: "FailedToOpenSocket",
        message: "Was there a typo in the url or port?",
      },
    })
    const parsed = MessageV2.fromError(error, { providerID })
    expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
    if (!SessionV1.APIError.isInstance(parsed)) throw new Error("expected APIError")
    expect(parsed.data.metadata).toMatchObject({
      url: "http://remote.invalid/v1/chat/completions",
      code: "FailedToOpenSocket",
      message: "Was there a typo in the url or port?",
    })
    expect(SessionRecovery.decide(facts(parsed, "available")).type).toBe("failover_restart")
  })

  test("classifies the Bun connection message when no cause code is available", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Cannot connect to API: Was there a typo in the url or port?",
        isRetryable: true,
      }).toObject(),
    )
    expect(SessionRecovery.decide(facts(error, "available")).type).toBe("failover_restart")
  })

  test("fails over transient HTTP responses when fallback is available", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )
    expect(SessionRecovery.decide(facts(error, "available")).type).toBe("failover_restart")
    expect(SessionRecovery.decide(facts(error, "disabled")).type).toBe("retry_current")
  })

  test("retries serialized too_many_requests messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("retries serialized overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("retries serialized rate_limit messages", () => {
    const message = JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } })
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test.each([
    "Internal server error",
    "internal error",
    "server-error",
    "Provider returned error",
    "provider-returned-error",
    "terminated",
    "fetch failed",
    "network error",
    "network-error",
    "network_error",
    "connection refused",
    "connect ECONNREFUSED",
    "request ETIMEDOUT",
    "failed to fetch",
    "EAI_AGAIN",
    "response timed out",
    "Please retry your request",
    "try your request again",
    "Please try again in a few minutes",
    "The model is currently at capacity due to high demand",
    "The service is temporarily at capacity",
    "upstream returned status 524",
  ])("retries matching API error text: %s", (message) => {
    expect(SessionRetry.retryable(wrap(message), retryProvider)).toEqual({ message })
  })

  test("retries hyphenated service-unavailable errors", () => {
    expect(SessionRetry.retryable(wrap("service-unavailable"), retryProvider)).toEqual({
      message: "Provider is overloaded",
    })
  })

  test("matches retryable API response bodies", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "upstream connection refused" } }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Request failed" })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
        label: "subscribe",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")).toEqual({
      message:
        "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
        message:
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        label: "open settings",
        link: "https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")?.action?.message).toBe(
      "Usage limit reached. It will reset in 15 minutes. To continue using this model now, enable usage from your available balance",
    )
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
