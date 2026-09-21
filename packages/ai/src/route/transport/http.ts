import { Clock, Duration, Effect, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { Auth } from "../auth.js"
import { render as renderEndpoint } from "../endpoint.js"
import { Framing } from "../framing.js"
import type { HttpMiddleware, Transport, TransportPrepareInput } from "./index.js"
import * as ProviderShared from "../../protocols/shared.js"
import {
  AIError,
  DEFAULT_HTTP_TIMEOUT_MS,
  mergeJsonRecords,
  TransportError,
  type HttpContext,
  type HttpTimeout,
  type LLMRequest,
} from "../../schema/index.js"
import { RequestExecutor } from "../executor.js"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: Framing.Definition<Frame>
  readonly middleware?: HttpMiddleware
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: Framing.Definition<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const parts = yield* jsonRequestParts({ ...prepareInput })
      const request = ProviderShared.jsonPost({
        url: parts.url,
        body: parts.bodyText,
        headers: parts.headers,
      })
      return {
        request,
        framing: input.framing,
        middleware: prepareInput.middleware,
      }
    }),
  execute: (prepared, request, runtime) =>
    Effect.gen(function* () {
      const timeout = (operation: "request" | "read", message: string, http?: HttpContext) =>
        new AIError({
          reason: new TransportError({
            message,
            transport: "http",
            operation,
            code: "Timeout",
            url: prepared.request.url,
            http,
          }),
        })
      const started = yield* Clock.currentTimeMillis
      // Unlike the header and chunk limits, the whole-request budget has no default.
      const total = request.http?.timeout ? Duration.millis(request.http.timeout) : Duration.infinity
      const response = yield* runtime.http.execute(prepared.request, prepared.middleware).pipe(
        Effect.timeoutOrElse({
          duration: Duration.min(timeoutDuration(request.http?.headerTimeout), total),
          orElse: () => timeout("request", "Timed out waiting for response headers"),
        }),
      )
      const http = RequestExecutor.responseHttp(response)
      const remaining = Duration.subtract(total, Duration.millis((yield* Clock.currentTimeMillis) - started))
      const source = RequestExecutor.responseStream(response)
      const chunkTimeout = request.http?.chunkTimeout
      const defaultChunkTimeout = chunkTimeout === false ? undefined : chunkTimeout ?? DEFAULT_HTTP_TIMEOUT_MS
      const adaptive =
        request.http?.splashAdaptiveSseTimeout === true &&
        defaultChunkTimeout !== undefined &&
        sameLoopbackOrigin(request.http.splashAdaptiveEndpoint, prepared.request.url)
      return {
        frames: prepared.framing.frame(
          (adaptive
            ? adaptiveReadTimeout(source, defaultChunkTimeout, (duration) =>
                timeout("read", "Timed out waiting for response data", http),
              )
            : source.pipe(
                Stream.timeoutOrElse({
                  duration: timeoutDuration(chunkTimeout),
                  orElse: () => Stream.fail(timeout("read", "Timed out waiting for response data", http)),
                }),
              )
          ).pipe(
            Stream.interruptWhen(
              Effect.sleep(remaining).pipe(
                Effect.andThen(Effect.fail(timeout("read", "Timed out waiting for the response to complete", http))),
              ),
            ),
          ),
        ),
        http,
        body: prepared.framing.body,
      }
    }),
})

const adaptiveReadTimeout = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  providerTimeout: number,
  onTimeout: (duration: number) => AIError,
) =>
  Stream.transformPull(source, (pull) =>
    Effect.sync(() => {
      const samples: number[] = []
      let current = providerTimeout
      return Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const chunk = yield* pull.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(current),
            orElse: () => Effect.fail(onTimeout(current)),
          }),
        )
        const elapsed = (yield* Clock.currentTimeMillis) - started
        if (elapsed >= 100 && chunk.some((bytes) => bytes.byteLength > 0)) {
          samples.push(elapsed)
          if (samples.length > 5) samples.shift()
          if (samples.length === 5) current = adaptiveTimeout(samples)
        }
        return chunk
      })
    }),
  )

export const sameLoopbackOrigin = (configured: string | undefined, actual: string) => {
  if (configured === undefined) return false
  try {
    const expected = new URL(configured)
    const request = new URL(actual)
    return (
      (expected.protocol === "http:" || expected.protocol === "https:") &&
      expected.origin === request.origin &&
      loopback(expected.hostname) &&
      loopback(request.hostname)
    )
  } catch {
    return false
  }
}

const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  (hostname.startsWith("127.") &&
    hostname.split(".").length === 4 &&
    hostname.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255))

export const adaptiveTimeout = (samples: readonly number[]) => {
  const ordered = [...samples].sort((left, right) => left - right)
  const basis = ordered.at(-2) ?? 0
  return Math.min(300_000, Math.max(30_000, basis * 10))
}

const timeoutDuration = (value: HttpTimeout | undefined) =>
  value === false ? Duration.infinity : Duration.millis(value ?? DEFAULT_HTTP_TIMEOUT_MS)

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
