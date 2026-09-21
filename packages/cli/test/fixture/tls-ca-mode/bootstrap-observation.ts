import { TLS_CA_CERTIFICATE_ENVIRONMENT, getVerifiedTlsCaMode } from "@opencode/util/tls-ca"
import { runTlsCaBootstrap } from "../../../src/bootstrap"

const httpsProbe = process.argv.slice(2).find((arg) => arg.startsWith("--https-probe="))

function errorDetails(error: unknown, depth = 0): unknown {
  if (depth >= 3 || !(error instanceof Error)) return String(error)
  const value = error as Error & { readonly code?: unknown; readonly cause?: unknown; readonly errors?: unknown }
  return {
    name: value.name,
    message: value.message,
    code: value.code ?? null,
    cause: value.cause === undefined ? null : errorDetails(value.cause, depth + 1),
    errors: Array.isArray(value.errors) ? value.errors.map((entry) => errorDetails(entry, depth + 1)) : null,
  }
}

await runTlsCaBootstrap(async () => {
  const mode = getVerifiedTlsCaMode()
  const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`

  let ffi: ReadonlyArray<string> | null = null
  let ffiError: unknown = null
  if (!process.versions.bun && process.execArgv.includes("--experimental-ffi")) {
    try {
      const specifier = "node:ffi"
      ffi = Object.keys(await import(specifier)).sort()
    } catch (error) {
      ffiError = errorDetails(error)
    }
  }

  const environment = Object.fromEntries(
    [
      "OPENCODE_TLS_CA_MODE",
      "OPENCODE_TLS_CA_BOOTSTRAPPED",
      "BUN_OPTIONS",
      "NODE_OPTIONS",
      "BUN_BE_BUN",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NODE_EXTRA_CA_CERTS",
      "NODE_USE_SYSTEM_CA",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "TLS_CA_TEST_UNRELATED",
      "TLS_CA_PRELOAD_MARKER",
    ].map((key) => [key, Object.hasOwn(process.env, key) ? (process.env[key] ?? null) : null]),
  )

  console.log(
    `BOOTSTRAP_EVIDENCE ${JSON.stringify({
      pid: process.pid,
      runtime,
      bun: process.versions.bun ?? null,
      node: process.versions.node,
      mode,
      argv: process.argv.slice(2),
      execArgv: process.execArgv,
      ffi,
      ffiError,
      preloadSentinel:
        (globalThis as { readonly __tlsCaHostilePreload?: unknown }).__tlsCaHostilePreload ?? null,
      environment,
      certificateKeysPresent: Object.fromEntries(
        TLS_CA_CERTIFICATE_ENVIRONMENT.map((key) => [key, Object.hasOwn(process.env, key)]),
      ),
    })}`,
  )

  if (!httpsProbe) return
  const url = httpsProbe.slice("--https-probe=".length)
  console.log(`TLS_ATTEMPT ${JSON.stringify({ pid: process.pid, runtime, mode, url })}`)
  try {
    const response = await fetch(url)
    const body = await response.text()
    console.log(`TLS_RESPONSE ${JSON.stringify({ pid: process.pid, status: response.status, body })}`)
    if (!response.ok) process.exitCode = 1
  } catch (error) {
    console.log(`TLS_ERROR ${JSON.stringify({ pid: process.pid, error: errorDetails(error) })}`)
    process.exitCode = 1
  }
})
