import { Effect } from "effect"
import { Headers } from "effect/http"
import type { LLMRequest } from "../schema/index.js"
import { Auth } from "../route/index.js"

export type Observation =
  | { readonly phase: "prefill"; readonly processed: number; readonly total: number }
  | { readonly phase: "decode"; readonly tokensPerSecond: number }

export interface Observer {
  readonly finalize: () => void
  readonly discard: () => void
}

type Attempt = {
  readonly observe: (observation: Observation) => void
  closed: boolean
  armed: boolean
  boundRequest: string | undefined
  phase: "prefill" | "decode" | undefined
  prefillPercent: number | undefined
  prefillDone: boolean
  rounds: { committed: number; ms: number }[]
  lastDecodeAt: number
  pendingDecode: Observation | undefined
  decodeTimer: ReturnType<typeof setTimeout> | undefined
  lastDecode: Observation | undefined
}

type Watcher = {
  readonly url: string
  readonly headers: Record<string, string>
  readonly fetch: typeof globalThis.fetch
  stopped: boolean
  poisoned: boolean
  ready: boolean
  readyWaiters: ((ready: boolean) => void)[]
  idleTimer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController
  readonly replayed: Set<string>
  readonly unbound: Set<string>
  readonly dead: Set<string>
  readonly attempts: Attempt[]
  readonly bindings: Map<string, Attempt>
}

const watchers = new WeakMap<Auth.Definition, Map<string, Watcher>>()
const READY_WAIT_MS = 500
const RECONNECT_DELAY_MS = 1000
const IDLE_RETIRE_MS = 5000
const DECODE_WINDOW = 16
const DECODE_THROTTLE_MS = 250
const SET_LIMIT = 256
const FRAME_BOUNDARY = /\r?\n\r?\n/

export function eventsURL(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL)
    const path = url.pathname.replace(/\/+$/, "")
    const root = path.endsWith("/v1") ? path.slice(0, -"/v1".length) : path
    return `${url.protocol}//${url.host}${root}/events`
  } catch {
    return undefined
  }
}

/** Binds observations from one shared MLX event feed to a Core-owned physical attempt. */
export const attachMlxObserver = (input: {
  readonly endpoint?: string
  readonly auth: Auth.Definition
  readonly request: LLMRequest
  readonly observe: (observation: Observation) => void
  readonly signal?: AbortSignal
  readonly fetch?: typeof globalThis.fetch
}): Effect.Effect<Observer | undefined, Auth.AuthError> =>
  Effect.gen(function* () {
    const url = input.endpoint ? eventsURL(input.endpoint) : undefined
    if (!url) return undefined
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "GET",
      url,
      body: "",
      headers: Headers.fromInput({
        accept: "text/event-stream",
        ...input.request.model.route.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    if (input.signal?.aborted) return undefined
    const byURL = watchers.get(input.auth) ?? new Map<string, Watcher>()
    if (!watchers.has(input.auth)) watchers.set(input.auth, byURL)
    const existing = byURL.get(url)
    const effectiveHeaders = { ...headers }
    const reusable =
      existing !== undefined &&
      !existing.stopped &&
      !existing.poisoned &&
      sameHeaders(existing.headers, effectiveHeaders)
    const previousHasOpenAttempts = existing?.attempts.some((item) => !item.closed) ?? false
    const watcher = reusable
      ? existing
      : createWatcher({
          url,
          headers: effectiveHeaders,
          fetch: input.fetch ?? fetch,
          poisoned: previousHasOpenAttempts,
        })
    if (!reusable) {
      if (existing) stop(existing)
      byURL.set(url, watcher)
      // A replaced epoch with open attempts is poisoned, but still starts a
      // feed so its bounded resources and lifecycle follow the normal path.
      void run(watcher)
    }
    if (watcher.idleTimer) clearTimeout(watcher.idleTimer)
    watcher.idleTimer = undefined
    const attempt = register(watcher, input.observe)
    const abort = () => {
      close(watcher, attempt)
      retireIfIdle(input.auth, watcher)
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted || watcher.stopped) {
      input.signal?.removeEventListener("abort", abort)
      abort()
      return undefined
    }
    if (watcher.poisoned) {
      attempt.armed = true
      return {
        finalize: () => {
          input.signal?.removeEventListener("abort", abort)
          finalize(watcher, attempt)
          retireIfIdle(input.auth, watcher)
        },
        discard: () => {
          input.signal?.removeEventListener("abort", abort)
          close(watcher, attempt)
          retireIfIdle(input.auth, watcher)
        },
      }
    }
    const ready = yield* Effect.promise(() => waitReady(watcher, input.signal))
    if (ready === "abort" || ready === "stopped" || attempt.closed || watcher.stopped) {
      input.signal?.removeEventListener("abort", abort)
      close(watcher, attempt)
      retireIfIdle(input.auth, watcher)
      return undefined
    }
    if (ready === "timeout") watcher.poisoned = true
    attempt.armed = true
    return {
      finalize: () => {
        input.signal?.removeEventListener("abort", abort)
        finalize(watcher, attempt)
        retireIfIdle(input.auth, watcher, true)
      },
      discard: () => {
        input.signal?.removeEventListener("abort", abort)
        close(watcher, attempt)
        retireIfIdle(input.auth, watcher)
      },
    }
  })

function createWatcher(input: {
  url: string
  headers: Record<string, string>
  fetch: typeof globalThis.fetch
  poisoned: boolean
}): Watcher {
  return {
    url: input.url,
    headers: input.headers,
    fetch: input.fetch,
    stopped: false,
    poisoned: input.poisoned,
    ready: false,
    readyWaiters: [],
    idleTimer: undefined,
    controller: new AbortController(),
    replayed: new Set(),
    unbound: new Set(),
    dead: new Set(),
    attempts: [],
    bindings: new Map(),
  }
}

function register(watcher: Watcher, observe: (observation: Observation) => void): Attempt {
  const attempt: Attempt = {
    observe,
    closed: false,
    armed: false,
    boundRequest: undefined,
    phase: undefined,
    prefillPercent: undefined,
    prefillDone: false,
    rounds: [],
    lastDecodeAt: 0,
    pendingDecode: undefined,
    decodeTimer: undefined,
    lastDecode: undefined,
  }
  watcher.attempts.push(attempt)
  return attempt
}

async function run(watcher: Watcher) {
  while (!watcher.stopped) {
    watcher.ready = false
    watcher.controller = new AbortController()
    try {
      const response = await watcher.fetch(watcher.url, {
        headers: watcher.headers,
        signal: watcher.controller.signal,
        redirect: "error",
      })
      if (!response.ok || !response.body) throw new Error("MLX telemetry stream unavailable")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = FRAME_BOUNDARY.exec(buffer)
        while (boundary) {
          handleFrame(watcher, buffer.slice(0, boundary.index))
          buffer = buffer.slice(boundary.index + boundary[0].length)
          boundary = FRAME_BOUNDARY.exec(buffer)
        }
        if (buffer.length > 64 * 1024) buffer = ""
      }
    } catch {
      if (watcher.stopped) return
    }
    watcher.ready = false
    if (watcher.stopped) return
    await sleep(RECONNECT_DELAY_MS)
  }
}

function handleFrame(watcher: Watcher, frame: string) {
  let name: string | undefined
  const data: string[] = []
  for (const line of frame.split("\n")) {
    const trimmed = line.replace(/\r$/, "")
    if (trimmed.startsWith(":")) continue
    if (trimmed.startsWith("event:")) name = trimmed.slice(6).trim()
    else if (trimmed.startsWith("data:")) data.push(trimmed.slice(5).trimStart())
  }
  if (data.length === 0) return
  try {
    const payload: unknown = JSON.parse(data.join("\n"))
    if (!isRecord(payload)) return
    if (name === "stats" || payload.type === "stats") {
      watcher.ready = true
      for (const waiter of watcher.readyWaiters.splice(0)) waiter(true)
      return
    }
    const req = typeof payload.req === "string" ? payload.req : undefined
    if (!req) return
    if (!watcher.ready) {
      remember(watcher, watcher.replayed, req)
      return
    }
    if (payload.type === "prefill") {
      prefill(watcher, req, payload)
      return
    }
    if (typeof payload.i === "number") round(watcher, req, payload)
  } catch {
    // Malformed provider telemetry is ignored.
  }
}

function prefill(watcher: Watcher, req: string, data: Record<string, unknown>) {
  const attempt = bind(watcher, req)
  if (!attempt) return
  if (data.done === true) {
    attempt.prefillDone = true
    return
  }
  if (attempt.phase === "decode" || attempt.prefillDone) return
  const processed = finite(data.processed)
  const total = finite(data.total)
  if (processed === undefined || total === undefined || total <= 0) return
  const percent = Math.min(100, Math.max(0, Math.floor((processed / total) * 100)))
  if (percent === attempt.prefillPercent) return
  attempt.prefillPercent = percent
  attempt.phase = "prefill"
  emit(attempt, { phase: "prefill", processed, total })
}

function round(watcher: Watcher, req: string, data: Record<string, unknown>) {
  const attempt = bind(watcher, req)
  if (!attempt) return
  const changed = attempt.phase !== "decode"
  attempt.phase = "decode"
  const committed = finite(data.committed)
  const ms = finite(data.ms)
  if (data.i !== 0 && committed !== undefined && committed > 0 && ms !== undefined && ms > 0) {
    attempt.rounds.push({ committed, ms })
    if (attempt.rounds.length > DECODE_WINDOW) attempt.rounds.shift()
  }
  const tokensPerSecond = decodeRate(attempt)
  if (tokensPerSecond === undefined) return
  const observation = { phase: "decode" as const, tokensPerSecond }
  const elapsed = Date.now() - attempt.lastDecodeAt
  if (changed || elapsed >= DECODE_THROTTLE_MS) {
    if (attempt.decodeTimer) clearTimeout(attempt.decodeTimer)
    attempt.decodeTimer = undefined
    attempt.pendingDecode = undefined
    attempt.lastDecodeAt = Date.now()
    attempt.lastDecode = observation
    emit(attempt, observation)
    return
  }
  attempt.pendingDecode = observation
  if (attempt.decodeTimer) return
  attempt.decodeTimer = setTimeout(() => {
    attempt.decodeTimer = undefined
    const pending = attempt.pendingDecode
    attempt.pendingDecode = undefined
    if (!pending || attempt.closed) return
    attempt.lastDecodeAt = Date.now()
    attempt.lastDecode = pending
    emit(attempt, pending)
  }, DECODE_THROTTLE_MS - elapsed)
  attempt.decodeTimer.unref?.()
}

function decodeRate(attempt: Attempt) {
  if (attempt.rounds.length === 0) return undefined
  const committed = attempt.rounds.reduce((total, item) => total + item.committed, 0)
  const ms = attempt.rounds.reduce((total, item) => total + item.ms, 0)
  return ms > 0 ? (committed / ms) * 1000 : undefined
}

function bind(watcher: Watcher, req: string) {
  const existing = watcher.bindings.get(req)
  if (existing) return existing.closed ? undefined : existing
  if (watcher.poisoned) return undefined
  if (watcher.replayed.has(req) || watcher.unbound.has(req) || watcher.dead.has(req)) return undefined
  const pending = watcher.attempts.filter((attempt) => !attempt.closed && attempt.boundRequest === undefined)
  if (pending.length !== 1) {
    remember(watcher, watcher.unbound, req)
    return undefined
  }
  const attempt = pending[0]
  attempt.boundRequest = req
  watcher.bindings.set(req, attempt)
  return attempt
}

function finalize(watcher: Watcher, attempt: Attempt) {
  if (attempt.closed) return
  const terminal = attempt.pendingDecode ?? attempt.lastDecode
  close(watcher, attempt)
  if (terminal) emit(attempt, terminal)
}

function close(watcher: Watcher, attempt: Attempt) {
  if (attempt.closed) return
  attempt.closed = true
  if (attempt.decodeTimer) clearTimeout(attempt.decodeTimer)
  attempt.decodeTimer = undefined
  attempt.pendingDecode = undefined
  if (attempt.boundRequest) {
    remember(watcher, watcher.dead, attempt.boundRequest)
    watcher.bindings.delete(attempt.boundRequest)
  } else if (attempt.armed) watcher.poisoned = true
  watcher.attempts.splice(watcher.attempts.indexOf(attempt), 1)
}

function emit(attempt: Attempt, observation: Observation) {
  try {
    attempt.observe(observation)
  } catch {
    // The Core attempt also guards its callback; keep the provider adapter isolated.
  }
}

function retireIfIdle(auth: Auth.Definition, watcher: Watcher, keepReady = false) {
  if (watcher.attempts.some((attempt) => !attempt.closed)) return
  const byURL = watchers.get(auth)
  if (!keepReady || watcher.poisoned || watcher.stopped || byURL?.get(watcher.url) !== watcher) {
    stop(watcher)
    if (byURL?.get(watcher.url) === watcher) byURL.delete(watcher.url)
    return
  }
  if (watcher.idleTimer) return
  watcher.idleTimer = setTimeout(() => {
    watcher.idleTimer = undefined
    if (watcher.attempts.some((attempt) => !attempt.closed)) return
    stop(watcher)
    if (byURL.get(watcher.url) === watcher) byURL.delete(watcher.url)
  }, IDLE_RETIRE_MS)
  watcher.idleTimer.unref?.()
}

function remember(watcher: Watcher, set: Set<string>, value: string) {
  if (set.has(value)) return
  if (set.size >= SET_LIMIT) {
    watcher.poisoned = true
    watcher.stopped = true
    watcher.controller.abort()
    return
  }
  set.add(value)
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function stop(watcher: Watcher) {
  watcher.stopped = true
  watcher.ready = false
  if (watcher.idleTimer) clearTimeout(watcher.idleTimer)
  watcher.idleTimer = undefined
  watcher.controller.abort()
  for (const waiter of watcher.readyWaiters.splice(0)) waiter(false)
}

function sameHeaders(left: Record<string, string>, right: Record<string, string>) {
  const a = new globalThis.Headers(left)
  const b = new globalThis.Headers(right)
  for (const [name, value] of a) if (b.get(name) !== value) return false
  for (const [name] of b) if (!a.has(name)) return false
  return true
}

function waitReady(watcher: Watcher, abort: AbortSignal | undefined): Promise<"ready" | "timeout" | "abort" | "stopped"> {
  if (abort?.aborted) return Promise.resolve("abort")
  if (watcher.ready) return Promise.resolve("ready")
  if (watcher.stopped) return Promise.resolve("stopped")
  return new Promise((resolve) => {
    const finish = (outcome: "ready" | "timeout" | "abort" | "stopped") => {
      clearTimeout(timer)
      abort?.removeEventListener("abort", onAbort)
      const index = watcher.readyWaiters.indexOf(waiter)
      if (index >= 0) watcher.readyWaiters.splice(index, 1)
      resolve(outcome)
    }
    const waiter = (ready: boolean) => finish(ready ? "ready" : "stopped")
    const timer = setTimeout(() => finish("timeout"), READY_WAIT_MS)
    timer.unref?.()
    const onAbort = () => finish("abort")
    abort?.addEventListener("abort", onAbort, { once: true })
    watcher.readyWaiters.push(waiter)
  })
}
