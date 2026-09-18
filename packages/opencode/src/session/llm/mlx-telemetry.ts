// Bridges the stock mlx-dspark `/events` SSE feed into ephemeral OpenCode
// session.telemetry snapshots. Attribution is only valid because
// `mlxTelemetry: true` declares the mlx endpoint dedicated to this OpenCode
// use: the first NEW live mlx req observed after a pending AssistantMessage
// registration is that generation's request.
import { isRecord } from "@/util/record"
import { Effect, Exit } from "effect"

export type TelemetryPhase = "prefill" | "decode"

export type TelemetrySnapshot = {
  sessionID: string
  assistantMessageID: string
  phase: TelemetryPhase
  processed?: number
  total?: number
  tokensPerSecond?: number
  done?: boolean
}

export type AttachInput = {
  options: Record<string, any>
  // Effective provider endpoint exactly as resolved for dispatch
  // (Provider.getEndpoint). Telemetry must follow the same server the model
  // is actually served from; this module never re-derives URL precedence.
  endpoint?: string
  apiKey?: string
  sessionID: string
  assistantMessageID: string
  publish: (snapshot: TelemetrySnapshot) => void
  onError?: (context: string, error: unknown) => void
  abort?: AbortSignal
}

export type TelemetryAttempt = {
  readonly finalize: () => void
  readonly discard?: () => void
}

export type TelemetryHolder = {
  current?: TelemetryAttempt
  // Set once the provider path has supplied a usable authoritative DECODE
  // RATE (finite positive tok/s) for this attempt. Only that wins decode
  // arbitration: the generic client fallback must stop publishing once this
  // flips. Prefill progress and rate-less phase transitions do NOT flip it.
  providerDecodeAccepted?: boolean
}

// Narrow decode-ownership test: a provider snapshot permanently suppresses the
// generic decode fallback ONLY when it carries a usable authoritative decode
// rate. Real prefill progress (processed/total) and the i==0 phase transition
// are authoritative phase information but carry no rate — i==0 is deliberately
// excluded from the mlx rate denominator because its `ms` contains prefill —
// so neither may disable the fallback the short generation still needs. An
// all-empty prefill snapshot is the registration's ephemeral presentation
// reset and is obviously not acceptance either.
export const hasAuthoritativeDecodeRate = (snapshot: TelemetrySnapshot) =>
  snapshot.phase === "decode" &&
  typeof snapshot.tokensPerSecond === "number" &&
  Number.isFinite(snapshot.tokensPerSecond) &&
  snapshot.tokensPerSecond > 0

// Setup that fails after attach() must release its registration so a dead
// request can never poison attribution for the next AssistantMessage. A
// successful pass hands the attempt's lifetime to the stream-scope finalizer.
export const guardAttempt =
  (holder: TelemetryHolder, fallback?: { discard?: () => void }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.sync(() => {
              try {
                if (holder.current?.discard) holder.current.discard()
                else holder.current?.finalize()
              } catch {}
              try {
                fallback?.discard?.()
              } catch {}
            })
          : Effect.void,
      ),
    )

// Composite stream-teardown finalizer. Provider telemetry MUST finalize
// first: that flushes any pending throttled sample, whose usable decode rate
// marks the holder decode-accepted synchronously, so the fallback's own
// finalize sees the suppression and emits no competing terminal snapshot.
// A provider that only ever held prefill or a rate-less phase transition does
// NOT get accepted, and the fallback freezes its useful measurement instead.
// The ordering is explicit here on purpose — never rely on Effect finalizer
// registration (LIFO) order across two separately registered finalizers.
export const finalizeAttempt = (holder: TelemetryHolder, fallback: { finalize: () => void } | undefined) => () => {
  try {
    holder.current?.finalize()
  } catch {}
  try {
    fallback?.finalize()
  } catch {}
}

const READY_WAIT_MS = 500
const RECONNECT_DELAY_MS = 1000
const DECODE_WINDOW = 16
const DECODE_THROTTLE_MS = 250
const SET_LIMIT = 256
const FRAME_BOUNDARY = /\r?\n\r?\n/

type Attempt = {
  sessionID: string
  assistantMessageID: string
  publish: (snapshot: TelemetrySnapshot) => void
  onError: (context: string, error: unknown) => void
  closed: boolean
  // True once attach() has returned its handle: the provider may dispatch
  // this generation, so an unbound close must fail-close the epoch.
  armed: boolean
  boundReq: string | undefined
  phase: TelemetryPhase | undefined
  prefillPercent: number | undefined
  prefillDone: boolean
  rounds: { committed: number; ms: number }[]
  lastDecodeAt: number
  pendingDecode: TelemetrySnapshot | undefined
  decodeTimer: ReturnType<typeof setTimeout> | undefined
  last: TelemetrySnapshot | undefined
}

// The watcher owns endpoint/connection state only; snapshot delivery is owned
// by each attempt so a module-global watcher never captures a stale caller.
// A poisoned (fail-closed) epoch never binds an unknown req again: readiness
// timed out or a safety set overflowed, so replay/dead state can no longer
// prove ownership. It is retired once its last attempt closes.
type Watcher = {
  url: string
  apiKey: string | undefined
  onError: (context: string, error: unknown) => void
  stopped: boolean
  poisoned: boolean
  ready: boolean
  abort: AbortController
  readyWaiters: ((ready: boolean) => void)[]
  replayed: Set<string>
  unbound: Set<string>
  dead: Set<string>
  attempts: Attempt[]
  bindings: Map<string, Attempt>
}

const watchers = new Map<string, Watcher>()

const log = (onError: ((context: string, error: unknown) => void) | undefined, context: string, error: unknown) => {
  try {
    onError?.(context, error)
  } catch {}
}

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

export const discardAttempt = (holder: TelemetryHolder, fallback: { discard?: () => void } | undefined) => () => {
  try {
    holder.current?.discard?.()
  } catch {}
  try {
    fallback?.discard?.()
  } catch {}
}

export async function attach(input: AttachInput): Promise<TelemetryAttempt | undefined> {
  try {
    if (input.options.mlxTelemetry !== true) return undefined
    // The caller supplies the dispatch-resolved `endpoint`; the options.baseURL
    // fallback is only for direct attach callers and never re-derives the
    // provider/model precedence that Provider.getEndpoint already applied.
    const base =
      input.endpoint ??
      (typeof input.options.baseURL === "string" && input.options.baseURL !== "" ? input.options.baseURL : undefined)
    const url = typeof base === "string" ? eventsURL(base) : undefined
    if (!url) return undefined
    const apiKey = typeof input.options.apiKey === "string" ? input.options.apiKey : input.apiKey
    let watcher = watchers.get(url)
    if (watcher && (watcher.apiKey !== apiKey || watcher.stopped)) {
      stop(watcher)
      watchers.delete(url)
      watcher = undefined
    }
    if (!watcher) {
      watcher = createWatcher(url, apiKey, input)
      watchers.set(url, watcher)
      void run(watcher)
    }
    const target = watcher
    // Register BEFORE awaiting readiness so the provider can never dispatch a
    // generation that attribution accounting does not know about, and so a
    // timed-out generation still has a handle for its stream finalizer.
    const attempt = register(target, input)
    const discard = () => {
      input.abort?.removeEventListener("abort", discard)
      close(target, attempt)
      maybeRetire(target)
    }
    if (input.abort) {
      if (input.abort.aborted) {
        discard()
        return undefined
      }
      input.abort.addEventListener("abort", discard, { once: true })
    }
    const ready = await waitReady(target, input.abort)
    if (ready === "abort") {
      discard()
      return undefined
    }
    if (target.stopped) {
      discard()
      return undefined
    }
    // A readiness timeout poisons this watcher epoch: the timed-out
    // generation's req may already be queued server-side, so no unknown req
    // is ever safe to bind here again. Generation proceeds without telemetry;
    // stats arriving later must not restore unsafe attribution on this
    // connection.
    if (ready !== "ready") target.poisoned = true
    attempt.armed = true
    return {
      finalize: () => {
        input.abort?.removeEventListener("abort", discard)
        finalize(target, attempt)
        maybeRetire(target)
      },
      discard,
    }
  } catch (error) {
    log(input.onError, "attach", error)
    return undefined
  }
}

export function stopAll() {
  for (const watcher of watchers.values()) stop(watcher)
  watchers.clear()
}

function createWatcher(url: string, apiKey: string | undefined, input: AttachInput): Watcher {
  return {
    url,
    apiKey,
    onError: input.onError ?? (() => {}),
    stopped: false,
    poisoned: false,
    ready: false,
    abort: new AbortController(),
    readyWaiters: [],
    replayed: new Set(),
    unbound: new Set(),
    dead: new Set(),
    attempts: [],
    bindings: new Map(),
  }
}

function stop(watcher: Watcher) {
  watcher.stopped = true
  watcher.ready = false
  watcher.abort.abort()
  for (const waiter of watcher.readyWaiters.splice(0)) waiter(false)
}

// A fail-closed epoch with no open attempts carries no more useful replay or
// tombstone state; retire it so the next request establishes a fresh stats
// barrier and fresh bounded safety sets.
function maybeRetire(watcher: Watcher) {
  if (!watcher.poisoned) return
  if (watcher.attempts.some((attempt) => !attempt.closed)) return
  if (watchers.get(watcher.url) === watcher) watchers.delete(watcher.url)
  stop(watcher)
}

async function run(watcher: Watcher) {
  while (!watcher.stopped) {
    // Reconnect resets the replay/live barrier: nothing may be treated as
    // live again until the server re-sends its `stats` event.
    watcher.ready = false
    watcher.abort = new AbortController()
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" }
      if (watcher.apiKey) {
        headers.authorization = `Bearer ${watcher.apiKey}`
        headers["x-api-key"] = watcher.apiKey
      }
      const response = await fetch(watcher.url, { headers, signal: watcher.abort.signal })
      if (!response.ok || !response.body) throw new Error(`mlx /events connection failed: ${response.status}`)
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
    } catch (error) {
      if (watcher.stopped) return
      log(watcher.onError, "connection", error)
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
  let payload: unknown
  try {
    payload = JSON.parse(data.join("\n"))
  } catch (error) {
    log(watcher.onError, "parse", error)
    return
  }
  if (isRecord(payload)) handleEvent(watcher, name, payload)
}

function handleEvent(watcher: Watcher, name: string | undefined, payload: Record<string, unknown>) {
  if (name === "stats" || payload.type === "stats") {
    watcher.ready = true
    for (const waiter of watcher.readyWaiters.splice(0)) waiter(true)
    return
  }
  const req = typeof payload.req === "string" ? payload.req : undefined
  if (!watcher.ready) {
    if (req) remember(watcher, watcher.replayed, req)
    return
  }
  if (!req) return
  if (payload.type === "prefill") {
    handlePrefill(watcher, req, payload)
    return
  }
  if (typeof payload.i === "number") handleRound(watcher, req, payload)
}

function handlePrefill(watcher: Watcher, req: string, data: Record<string, unknown>) {
  const attempt = bind(watcher, req)
  if (!attempt) return
  // mlx prefill done is prefill-terminal, NOT a decode start signal.
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
  publish(attempt, {
    sessionID: attempt.sessionID,
    assistantMessageID: attempt.assistantMessageID,
    phase: "prefill",
    processed,
    total,
  })
}

function handleRound(watcher: Watcher, req: string, data: Record<string, unknown>) {
  const attempt = bind(watcher, req)
  if (!attempt) return
  const phaseChange = attempt.phase !== "decode"
  // Round i == 0 carries prefill time: it establishes decode but never feeds tok/s.
  attempt.phase = "decode"
  const committed = finite(data.committed)
  const ms = finite(data.ms)
  if (data.i !== 0 && committed !== undefined && committed > 0 && ms !== undefined && ms > 0) {
    attempt.rounds.push({ committed, ms })
    if (attempt.rounds.length > DECODE_WINDOW) attempt.rounds.shift()
  }
  const rate = decodeRate(attempt)
  const snapshot: TelemetrySnapshot = {
    sessionID: attempt.sessionID,
    assistantMessageID: attempt.assistantMessageID,
    phase: "decode",
    ...(rate === undefined ? {} : { tokensPerSecond: rate }),
  }
  if (phaseChange) {
    attempt.lastDecodeAt = Date.now()
    publish(attempt, snapshot)
    return
  }
  if (rate === undefined) return
  const elapsed = Date.now() - attempt.lastDecodeAt
  if (elapsed >= DECODE_THROTTLE_MS) {
    // This snapshot supersedes any throttled sample: dropping the overdue
    // pending sample and its timer is what stops a stale rate from
    // publishing (or finalizing) after the newer one.
    if (attempt.decodeTimer) clearTimeout(attempt.decodeTimer)
    attempt.decodeTimer = undefined
    attempt.pendingDecode = undefined
    attempt.lastDecodeAt = Date.now()
    publish(attempt, snapshot)
    return
  }
  attempt.pendingDecode = snapshot
  if (attempt.decodeTimer) return
  attempt.decodeTimer = setTimeout(() => {
    attempt.decodeTimer = undefined
    const pending = attempt.pendingDecode
    attempt.pendingDecode = undefined
    if (!pending || attempt.closed) return
    attempt.lastDecodeAt = Date.now()
    publish(attempt, pending)
  }, DECODE_THROTTLE_MS - elapsed)
  attempt.decodeTimer.unref?.()
}

function decodeRate(attempt: Attempt) {
  if (attempt.rounds.length === 0) return undefined
  const committed = attempt.rounds.reduce((total, round) => total + round.committed, 0)
  const ms = attempt.rounds.reduce((total, round) => total + round.ms, 0)
  if (ms <= 0) return undefined
  return (committed / ms) * 1000
}

// First NEW live req after registration binds to the only pending attempt.
// Ambiguity (multiple unbound attempts) suppresses binding entirely: an
// unattributable req is remembered as unbound and never guessed at later.
// Replayed and dead (finalized/superseded) reqs are rejected the same way.
// A poisoned epoch rejects every unknown req: its replay/dead evidence is no
// longer trustworthy. Already-bound attempts keep their existing binding.
function bind(watcher: Watcher, req: string): Attempt | undefined {
  const existing = watcher.bindings.get(req)
  if (existing) return existing.closed ? undefined : existing
  if (watcher.poisoned) return undefined
  if (watcher.replayed.has(req) || watcher.unbound.has(req) || watcher.dead.has(req)) return undefined
  const pending = watcher.attempts.filter((attempt) => !attempt.closed && attempt.boundReq === undefined)
  if (pending.length !== 1) {
    remember(watcher, watcher.unbound, req)
    return undefined
  }
  pending[0].boundReq = req
  watcher.bindings.set(req, pending[0])
  return pending[0]
}

function register(watcher: Watcher, input: AttachInput): Attempt {
  // A retry under the same AssistantMessage supersedes the previous attempt:
  // its bound req becomes a dead letter so stale events cannot publish.
  for (const existing of watcher.attempts) {
    if (existing.assistantMessageID === input.assistantMessageID) close(watcher, existing)
  }
  watcher.attempts = watcher.attempts.filter((attempt) => !attempt.closed)
  const attempt: Attempt = {
    sessionID: input.sessionID,
    assistantMessageID: input.assistantMessageID,
    publish: input.publish,
    onError: input.onError ?? (() => {}),
    closed: false,
    armed: false,
    boundReq: undefined,
    phase: undefined,
    prefillPercent: undefined,
    prefillDone: false,
    rounds: [],
    lastDecodeAt: 0,
    pendingDecode: undefined,
    decodeTimer: undefined,
    last: undefined,
  }
  watcher.attempts.push(attempt)
  // Ephemeral state-clear marker so a retry never leaves the previous
  // attempt's terminal rate on screen. Deliberately emitted without going
  // through publish(): it must not become this attempt's trustworthy
  // finalize snapshot.
  emit(attempt, {
    sessionID: input.sessionID,
    assistantMessageID: input.assistantMessageID,
    phase: "prefill",
    done: false,
  })
  return attempt
}

function finalize(watcher: Watcher, attempt: Attempt) {
  if (attempt.closed) return
  // The throttled pending sample is the newest trustworthy snapshot.
  const terminal = attempt.pendingDecode ?? attempt.last
  close(watcher, attempt)
  if (terminal) emit(attempt, { ...terminal, done: true })
}

function close(watcher: Watcher, attempt: Attempt) {
  if (attempt.closed) return
  attempt.closed = true
  if (attempt.decodeTimer) clearTimeout(attempt.decodeTimer)
  attempt.decodeTimer = undefined
  attempt.pendingDecode = undefined
  if (attempt.boundReq) {
    remember(watcher, watcher.dead, attempt.boundReq)
    watcher.bindings.delete(attempt.boundReq)
    return
  }
  // An armed attempt that never saw its req may still have a request in
  // flight: closing it must fail-close the epoch so that delayed first
  // event cannot bind to a LATER attempt. Closes before attach returned
  // (armed === false: readiness abort, stopped watcher) are safe because
  // no dispatch was possible.
  if (attempt.armed) watcher.poisoned = true
}

function publish(attempt: Attempt, snapshot: TelemetrySnapshot) {
  if (attempt.closed) return
  attempt.last = snapshot
  emit(attempt, snapshot)
}

function emit(attempt: Attempt, snapshot: TelemetrySnapshot) {
  try {
    attempt.publish(snapshot)
  } catch (error) {
    log(attempt.onError, "publish", error)
  }
}

function waitReady(watcher: Watcher, abort: AbortSignal | undefined): Promise<"ready" | "timeout" | "abort"> {
  if (abort?.aborted) return Promise.resolve("abort")
  if (watcher.ready) return Promise.resolve("ready")
  return new Promise((resolve) => {
    const finish = (outcome: "ready" | "timeout" | "abort") => {
      clearTimeout(timer)
      abort?.removeEventListener("abort", onAbort)
      const index = watcher.readyWaiters.indexOf(waiter)
      if (index >= 0) watcher.readyWaiters.splice(index, 1)
      resolve(outcome)
    }
    const waiter = (ready: boolean) => finish(ready ? "ready" : "timeout")
    const timer = setTimeout(() => finish("timeout"), READY_WAIT_MS)
    timer.unref?.()
    const onAbort = () => finish("abort")
    abort?.addEventListener("abort", onAbort, { once: true })
    watcher.readyWaiters.push(waiter)
  })
}

// Safety sets never evict a tombstone to make room: dropping protection would
// make a dead/unbound req bindable again. Overflow instead fail-closes the
// whole watcher epoch, which is retired once its attempts finish.
function remember(watcher: Watcher, set: Set<string>, value: string) {
  if (set.has(value)) return
  if (set.size >= SET_LIMIT) {
    watcher.poisoned = true
    return
  }
  set.add(value)
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export * as MLXTelemetry from "./mlx-telemetry"
