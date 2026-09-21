import tls from "node:tls"
import { Effect } from "effect"
import {
  getVerifiedTlsCaMode,
  getVerifiedTlsCaModeIfAvailable,
  verifyTlsCaMode,
  type TlsCaMode,
} from "@opencode/util/tls-ca"

const [api, attestation, directory, requestedMode] = process.argv.slice(2)

if ((api !== "promise" && api !== "effect") || (attestation !== "unattested" && attestation !== "attested") || !directory)
  throw new Error("Usage: tls-ca-attestation.ts <promise|effect> <unattested|attested> <directory> [bundled|system]")

if (attestation === "attested" && requestedMode !== "bundled" && requestedMode !== "system")
  throw new Error("An attested run requires an explicit bundled or system mode")

const mode = requestedMode as TlsCaMode | undefined

function fail(message: string): never {
  throw new Error(message)
}

function defaultCaFingerprint() {
  return tls
    .getCACertificates("default")
    .map((certificate) => certificate.replace(/\r/g, "").trim())
    .sort()
}

const forbiddenEnvironment = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

for (const key of forbiddenEnvironment)
  if (Object.hasOwn(process.env, key) && process.env[key] !== undefined)
    fail(`Fresh process retained ${key}`)

const attestationBeforeVerification = getVerifiedTlsCaModeIfAvailable()
if (attestationBeforeVerification !== undefined)
  fail("TLS CA mode was already attested before this process selected a policy")

const defaultCaBefore = defaultCaFingerprint()

if (attestation === "attested") {
  const selected = verifyTlsCaMode(mode!)
  if (selected !== mode) fail(`Verifier selected ${selected}, expected ${mode}`)
}

if (getVerifiedTlsCaModeIfAvailable() !== (attestation === "attested" ? mode : undefined))
  fail("Optional attestation metadata did not match the selected policy")

const options = {
  app: { version: "sdk-tls-attestation-test" },
  database: { path: ":memory:" },
  config: {
    directory,
    project: false,
    content: "{}",
  },
  models: { fetch: false },
  fs: { filewatcher: false },
}

async function promiseInfo() {
  const { OpenCode } = await import("../../src")
  const host = await OpenCode.create(options)
  try {
    return { info: await host.server.info(), optionalAfterCreate: getVerifiedTlsCaModeIfAvailable() }
  } finally {
    await host.close()
  }
}

async function effectInfo() {
  const { OpenCode } = await import("../../src/effect")
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* OpenCode.create(options)
        const optionalAfterCreate = getVerifiedTlsCaModeIfAvailable()
        return { info: yield* host.server.info(), optionalAfterCreate }
      }),
    ),
  )
}

async function rawInfo() {
  const { EmbeddedHost } = await import("../../src/internal/host")
  const host = await Effect.runPromise(EmbeddedHost.create(options))
  try {
    const response = await host.fetch("http://opencode.local/api/info")
    return { status: response.status, body: await response.text() }
  } finally {
    await host.close()
  }
}

const hosted = api === "promise" ? await promiseInfo() : await effectInfo()
const info = hosted.info
if (info.version !== "sdk-tls-attestation-test") fail(`Unexpected version: ${info.version}`)

const optionalAfterRequest = getVerifiedTlsCaModeIfAvailable()
let strictAfterRequest: TlsCaMode | "throws"
try {
  strictAfterRequest = getVerifiedTlsCaMode()
} catch {
  strictAfterRequest = "throws"
}

const raw = attestation === "unattested" ? await rawInfo() : undefined
if (raw && raw.status !== 200) fail(`Raw embedded info request failed with ${raw.status}`)

const defaultCaAfter = defaultCaFingerprint()

console.log(
  `TLS_CA_ATTESTATION ${JSON.stringify({
    pid: process.pid,
    bun: process.versions.bun ?? null,
    node: process.versions.node,
    api,
    attestation,
    ambientMode: process.env.OPENCODE_TLS_CA_MODE ?? null,
    attestationBeforeVerification: attestationBeforeVerification ?? null,
    optionalAfterCreate: hosted.optionalAfterCreate ?? null,
    optionalAfterRequest: optionalAfterRequest ?? null,
    strictAfterRequest,
    version: info.version,
    tlsCaMode: info.tlsCaMode ?? null,
    tlsCaModeOwnProperty: Object.hasOwn(info, "tlsCaMode"),
    defaultCaCountBefore: defaultCaBefore.length,
    defaultCaCountAfter: defaultCaAfter.length,
    defaultCaUnchanged: JSON.stringify(defaultCaBefore) === JSON.stringify(defaultCaAfter),
    raw: raw ? { status: raw.status, body: raw.body, hasTlsCaModeField: raw.body.includes('"tlsCaMode"') } : null,
  })}`,
)
