import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const fixture = path.join(import.meta.dirname, "fixture/tls-ca-attestation.ts")

const forbiddenEnvironment = new Set([
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "OPENCODE_TLS_CA_MODE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
])

function cleanEnvironment(ambientMode?: "bundled" | "system") {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || forbiddenEnvironment.has(key)) continue
    environment[key] = value
  }
  if (ambientMode) environment.OPENCODE_TLS_CA_MODE = ambientMode
  return environment
}

async function run(
  api: "promise" | "effect",
  attestation: "unattested" | "attested",
  mode: "bundled" | "system" | undefined,
  ambientMode?: "bundled" | "system",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-sdk-tls-ca-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        ...(mode ? [mode === "bundled" ? "--use-bundled-ca" : "--use-system-ca"] : []),
        fixture,
        api,
        attestation,
        directory,
        ...(mode ? [mode] : []),
      ],
      {
        cwd: directory,
        env: cleanEnvironment(ambientMode),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const line = stdout
      .split("\n")
      .find((entry) => entry.startsWith("TLS_CA_ATTESTATION "))
    return {
      directory,
      exitCode,
      stdout,
      stderr,
      evidence: line ? JSON.parse(line.slice("TLS_CA_ATTESTATION ".length)) : undefined,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

type Evidence = {
  readonly pid: number
  readonly bun: string | null
  readonly node: string
  readonly api: string
  readonly attestation: string
  readonly ambientMode: string | null
  readonly attestationBeforeVerification: string | null
  readonly optionalAfterCreate: string | null
  readonly optionalAfterRequest: string | null
  readonly strictAfterRequest: string
  readonly version: string
  readonly tlsCaMode: string | null
  readonly tlsCaModeOwnProperty: boolean
  readonly defaultCaCountBefore: number
  readonly defaultCaCountAfter: number
  readonly defaultCaUnchanged: boolean
  readonly raw: { readonly status: number; readonly body: string; readonly hasTlsCaModeField: boolean } | null
}

const cases = [
  { api: "promise", attestation: "unattested", mode: undefined, ambientMode: "system" },
  { api: "effect", attestation: "unattested", mode: undefined, ambientMode: "bundled" },
  { api: "promise", attestation: "attested", mode: "bundled", ambientMode: undefined },
  { api: "effect", attestation: "attested", mode: "system", ambientMode: undefined },
] as const

for (const scenario of cases) {
  test(`${scenario.api} ${scenario.attestation} public host reports honest ${scenario.mode ?? "absent"} attestation`, async () => {
    const result = await run(scenario.api, scenario.attestation, scenario.mode, scenario.ambientMode)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.evidence).toBeDefined()
    const evidence = result.evidence as Evidence

    expect(evidence.api).toBe(scenario.api)
    expect(evidence.attestation).toBe(scenario.attestation)
    expect(evidence.ambientMode).toBe(scenario.ambientMode ?? null)
    expect(evidence.attestationBeforeVerification).toBeNull()
    expect(evidence.version).toBe("sdk-tls-attestation-test")
    expect(evidence.defaultCaUnchanged).toBe(true)
    expect(evidence.defaultCaCountAfter).toBe(evidence.defaultCaCountBefore)
    expect(evidence.pid).toBeGreaterThan(0)
    expect(evidence.node.length).toBeGreaterThan(0)

    if (scenario.attestation === "unattested") {
      expect(evidence.bun).toBeTruthy()
      expect(evidence.tlsCaMode).toBeNull()
      expect(evidence.optionalAfterCreate).toBeNull()
      expect(evidence.optionalAfterRequest).toBeNull()
      expect(evidence.strictAfterRequest).toBe("throws")
      expect(evidence.raw).not.toBeNull()
      expect(evidence.raw?.status).toBe(200)
      expect(evidence.raw?.hasTlsCaModeField).toBe(false)
      expect(evidence.raw?.body).not.toContain("tlsCaMode")
    } else {
      expect(evidence.tlsCaMode).toBe(scenario.mode)
      expect(evidence.optionalAfterCreate).toBe(scenario.mode)
      expect(evidence.optionalAfterRequest).toBe(scenario.mode)
      expect(evidence.strictAfterRequest).toBe(scenario.mode)
      expect(evidence.raw).toBeNull()
    }
  }, 30_000)
}
