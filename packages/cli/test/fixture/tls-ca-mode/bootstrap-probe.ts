import { getVerifiedTlsCaMode } from "@opencode/util/tls-ca"
import { runTlsCaBootstrap } from "../../../src/bootstrap"

const args = process.argv.slice(2)
const separator = args.indexOf("--")
const url = separator >= 0 ? args[separator + 1] : args[args.length - 1]
if (!url || !url.startsWith("https://")) {
  console.error("Usage: bootstrap-probe.ts [flags] [--] <url>")
  process.exit(1)
}

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
  console.log(`TLS_ATTEMPT ${JSON.stringify({ pid: process.pid, runtime, mode, url })}`)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: true, timestamp: Date.now() }),
    })
    const body = await response.text()
    console.log(`TLS_RESPONSE ${JSON.stringify({ pid: process.pid, status: response.status, body })}`)
    if (!response.ok || body !== "ok") process.exitCode = 1
  } catch (error) {
    const details = errorDetails(error)
    console.log(`TLS_ERROR ${JSON.stringify({ pid: process.pid, error: details })}`)
    console.error(`TLS certificate rejection ${JSON.stringify(details)}`)
    process.exitCode = 1
  }
})
