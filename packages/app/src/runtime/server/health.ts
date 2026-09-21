import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { authTokenFromCredentials } from "./api"
import {
  createServerHealthState,
  selectServerHealthRecord,
  transitionServerHealth,
  type ServerHealth,
  type ServerHealthEvent,
  type ServerHealthInput,
  type ServerProbe,
  type ServerProbeResult,
} from "./health-machine"
import { endpointCredentials } from "./machine"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client"
import { Accessor, batch, createComputed, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000

const defaultRetryCount = 2

const defaultRetryDelayMs = 100

const cacheMs = 750

// `at` is when the probe started, then when it answered: a probe that hangs is shared only briefly.
const healthCache = new Map<
  string,
  { at: number; fetch: typeof globalThis.fetch; promise: Promise<ServerProbeResult> }
>()

/** The owner identity carried through one probe; cache entries never share across an incarnation. */
export type HealthProbeScope = {
  readonly key: ServerConnection.Key
  readonly incarnation: number
}

type HealthChecker = (
  http: ServerConnection.HttpBase,
  scope: HealthProbeScope,
) => Promise<ServerProbeResult>

type HealthCacheEntry = {
  at: number
  promise: Promise<ServerProbeResult>
  timer: ReturnType<typeof setTimeout>
}

/**
 * One health owner's probe checker. Cache entries are keyed by owner scope and endpoint credentials, expire on their
 * own, and never outlive the caller that created them.
 */
export function createServerHealthChecker(fetcher: typeof globalThis.fetch): {
  check: HealthChecker
  dispose: () => void
} {
  const cache = new Map<string, HealthCacheEntry>()
  let disposed = false

  // Deletes only the entry this callback owns, so a stale timer never removes a newer replacement.
  const remove = (key: string, entry: HealthCacheEntry) => {
    if (cache.get(key) !== entry) return

    clearTimeout(entry.timer)
    cache.delete(key)
  }

  const retain = (key: string, entry: HealthCacheEntry, at: number) => {
    clearTimeout(entry.timer)
    entry.at = at
    entry.timer = setTimeout(() => remove(key, entry), Math.max(0, at - Date.now()))
  }

  const check: HealthChecker = (http, scope) => {
    // A disposed owner starts no more requests; late settlements cannot reinsert anything.
    if (disposed) return Promise.resolve(unreachable)

    const key = JSON.stringify([scope.key, scope.incarnation, endpointCredentials(http)])
    const now = Date.now()
    const hit = cache.get(key)

    // A delayed expiry timer must not authorize an entry whose stored expiry already passed.
    if (hit && hit.at > now) return hit.promise

    if (hit) remove(key, hit)

    let entry: HealthCacheEntry
    const promise = checkServerHealth(http, fetcher).finally(() => {
      if (disposed || cache.get(key) !== entry) return

      const completed = Date.now()
      // An answer after the start window does not renew itself.
      if (entry.at <= completed) return remove(key, entry)

      retain(key, entry, completed + cacheMs)
    })

    entry = {
      at: now + cacheMs,
      promise,
      timer: setTimeout(() => remove(key, entry), cacheMs),
    }
    cache.set(key, entry)

    return promise
  }
  const dispose = () => {
    disposed = true
    cache.forEach((entry) => clearTimeout(entry.timer))
    cache.clear()
  }

  return { check, dispose }
}

/** A signal that aborts after a timeout, and how to stop its timer early when one runs. */
type Timeout = { readonly signal: AbortSignal; readonly clear?: () => void }

function timeoutSignal(timeoutMs: number): Timeout {
  // Some runtimes lack `AbortSignal.timeout` or throw from it; a timer stands in.
  if ("timeout" in AbortSignal) {
    try {
      return { signal: AbortSignal.timeout(timeoutMs) }
    } catch {}
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))

      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// SAFETY: a rejection's reason is unknown by contract; this is the boundary that classifies it, by `instanceof` only.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false

  if (error instanceof ClientError) return error.reason === "Transport"

  if (!(error instanceof Error)) return false

  if (error.name === "AbortError" || error.name === "TimeoutError") return false

  if (error instanceof TypeError) return true

  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

const unreachable = { type: "unreachable" } as const

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerProbeResult> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs

  const headers = server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({ password: server.password })}`,
      }
    : undefined

  const next = (count: number, retry: boolean): Promise<ServerProbeResult> => {
    if (count >= retryCount || !retry) return Promise.resolve(unreachable)

    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => unreachable)
  }

  const attempt = async (count: number): Promise<ServerProbeResult> => {
    const current = await OpenCode.make({
      baseUrl: server.url,
      fetch,
      headers,
    })
      .server.info({ signal })
      .then((status) => ({
        data: {
          type: "healthy" as const,
          version: status.version,
          hostname: status.hostname,
          ...(status.tlsCaMode ? { tlsCaMode: status.tlsCaMode } : {}),
        },
      }))
      .catch((error) => ({ error }))

    if ("data" in current) return current.data

    if (signal?.aborted) return unreachable

    if (isUnauthorizedError(current.error)) return { type: "unauthorized" }

    return next(count, retryable(current.error, signal))
  }

  return attempt(0).finally(() => timeout?.clear?.())
}

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => {
    const key = endpointCredentials(http)
    const hit = healthCache.get(key)
    const now = Date.now()

    if (hit && hit.fetch === fetcher && now - hit.at < cacheMs) return hit.promise

    const promise = checkServerHealth(http, fetcher).finally(() => {
      if (healthCache.get(key)?.promise === promise) healthCache.set(key, { at: Date.now(), fetch: fetcher, promise })
    })

    healthCache.set(key, { at: now, fetch: fetcher, promise })

    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, onProbe?: (probe: ServerProbe) => void) => {
  const platform = usePlatform()
  const checker = createServerHealthChecker(platform.fetch ?? globalThis.fetch)
  onCleanup(checker.dispose)

  return createServerHealth(servers, checker.check, onProbe)
}

export function createServerHealth(
  servers: Accessor<ServerConnection.Any[]>,
  check: HealthChecker,
  onProbe?: (probe: ServerProbe) => void,
) {
  const [machine, setMachine] = createSignal(createServerHealthState())
  const [status, setStatus] = createStore<Record<ServerConnection.Key, ServerHealth | undefined>>({})
  let timer: ReturnType<typeof setInterval> | undefined

  const dispatch = (event: ServerHealthEvent) =>
    batch(() => {
      const prev = untrack(machine)
      const result = transitionServerHealth(prev, event)

      // The selector builds new objects, which the store adopts and later updates in place.
      if (result.state.entries !== prev.entries) setStatus(reconcile(selectServerHealthRecord(result.state)))
      setMachine(result.state)

      result.effects.forEach((effect) => {
        if (effect.type === "probe") {
          const settled = (answer: ServerProbeResult) =>
            dispatch({
              type: "probe.settled",
              key: effect.key,
              incarnation: effect.incarnation,
              attempt: effect.attempt,
              result: answer,
            })

          void Promise.try(() =>
            check(effect.http, {
              key: effect.key,
              incarnation: effect.incarnation,
            }),
          ).then(settled, () => settled(unreachable))

          return
        }

        if (effect.type === "notify.probe") return onProbe?.(effect.probe)

        if (effect.type === "waiters.resolve") return effect.resolvers.forEach((resolve) => resolve())

        clearInterval(timer)
        timer =
          effect.type === "timer.start"
            ? setInterval(() => dispatch({ type: "poll.due" }), effect.intervalMs)
            : undefined
      })
    })

  // Runs during updates, so a server's health is known on the render that lists it. Reading the endpoint here tracks a
  // saved password and a plugin server's stage and endpoint.
  createComputed(() => {
    const list = servers().map(healthInput)

    untrack(() => dispatch({ type: "servers.synced", servers: list }))
  })

  onCleanup(() => dispatch({ type: "disposed" }))

  return {
    status,
    /** Probes every server now instead of at the next poll; resolves when each has answered or left the list. */
    retry: () => new Promise<void>((resolve) => dispatch({ type: "retry.requested", resolve })),
  }
}

function healthInput(conn: ServerConnection.Any): ServerHealthInput {
  const key = ServerConnection.key(conn)

  if (conn.type !== "plugin")
    return { type: "endpoint", key, http: { url: conn.http.url, password: conn.http.password }, managed: false }

  if (conn.status.type === "ready") return { type: "endpoint", key, http: conn.status.http, managed: conn.managed }

  return { type: "staged", key, stage: conn.status.type }
}
