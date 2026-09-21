import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  parseTlsCaMode,
  replaceTlsCaFlags,
  sanitizeTlsCaEnvironment,
  type TlsCaMode,
} from "@opencode/util/tls-ca"

describe("TLS CA mode arguments", () => {
  test("defaults to bundled and preserves ordinary arguments", () => {
    expect(parseTlsCaMode(["--version", "serve"])).toEqual({ mode: "bundled", argv: ["--version", "serve"] })
    expect(parseTlsCaMode([], "system")).toEqual({ mode: "system", argv: [] })
  })

  const accepted: Array<{ args: string[]; mode: TlsCaMode; argv: string[] }> = [
    { args: ["--tls-ca-mode", "system", "serve"], mode: "system", argv: ["serve"] },
    { args: ["--tls-ca-mode=bundled", "--help"], mode: "bundled", argv: ["--help"] },
    { args: ["--tls-ca-mode=system", "--tls-ca-mode", "system"], mode: "system", argv: [] },
    {
      args: ["--tls-ca-mode=bundled", "--", "--tls-ca-mode=system"],
      mode: "bundled",
      argv: ["--", "--tls-ca-mode=system"],
    },
  ]

  test.each(accepted)("parses $args", ({ args, mode, argv }) => {
    expect(parseTlsCaMode(args)).toEqual({ mode, argv })
  })

  test.each([
    ["conflicting modes", ["--tls-ca-mode=bundled", "--tls-ca-mode=system"], /conflicting/i],
    ["missing value", ["--tls-ca-mode"], /missing/i],
    ["unknown value", ["--tls-ca-mode=openssl"], /unknown/i],
    ["legacy camel case", ["--tlsCaMode=system"], /--tls-ca-mode/],
  ] as const)("rejects %s", (_name, args, error) => {
    expect(() => parseTlsCaMode(args)).toThrow(error)
  })

  test("replaces the CA selector without dropping Node runtime options", () => {
    expect(
      replaceTlsCaFlags("bundled", ["--experimental-ffi", "--use-system-ca", "--disable-warning=ExperimentalWarning"]),
    ).toEqual(["--experimental-ffi", "--disable-warning=ExperimentalWarning", "--use-bundled-ca"])
  })
})

describe("TLS CA child environment", () => {
  test("removes ambient runtime options and hostile bundled CA overrides", () => {
    const result = sanitizeTlsCaEnvironment("bundled", {
      BUN_OPTIONS: "--smol --inspect=127.0.0.1:0 --use-system-ca",
      NODE_OPTIONS: "--trace-warnings --require ./ambient-loader.js --use-openssl-ca",
      NODE_USE_SYSTEM_CA: "1",
      NODE_EXTRA_CA_CERTS: "/tmp/extra.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_FILE: "/tmp/certs.pem",
      SSL_CERT_DIR: "/tmp/certs",
      PATH: "/usr/bin",
    })

    expect(Object.hasOwn(result, "BUN_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "NODE_OPTIONS")).toBe(false)
    expect(result.OPENCODE_TLS_CA_MODE).toBe("bundled")
    expect(result.PATH).toBe("/usr/bin")
    for (const key of ["NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR"])
      expect(Object.hasOwn(result, key)).toBe(false)
  })

  test("keeps explicit system trust additions but removes runtime options and disabled verification", () => {
    const result = sanitizeTlsCaEnvironment("system", {
      BUN_OPTIONS: "--inspect=127.0.0.1:0",
      NODE_OPTIONS: "--trace-warnings --require ./ambient-loader.js",
      NODE_USE_SYSTEM_CA: "1",
      NODE_EXTRA_CA_CERTS: "/tmp/extra.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_FILE: "/tmp/certs.pem",
    })

    expect(result.NODE_USE_SYSTEM_CA).toBe("1")
    expect(result.NODE_EXTRA_CA_CERTS).toBe("/tmp/extra.pem")
    expect(result.SSL_CERT_FILE).toBe("/tmp/certs.pem")
    expect(result.OPENCODE_TLS_CA_MODE).toBe("system")
    expect(Object.hasOwn(result, "NODE_TLS_REJECT_UNAUTHORIZED")).toBe(false)
    expect(Object.hasOwn(result, "BUN_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "NODE_OPTIONS")).toBe(false)
  })
})

describe("real CLI bootstrap", () => {
  const probe = path.join(import.meta.dirname, "fixture/tls-ca-mode/bootstrap-env-probe.ts")

  async function run(mode?: TlsCaMode, env?: Record<string, string | undefined>) {
    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", probe, ...(mode ? [`--tls-ca-mode=${mode}`] : [])],
      {
        env: { ...process.env, BUN_OPTIONS: undefined, NODE_OPTIONS: undefined, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  test.each([undefined, "bundled", "system"] as const)("verifies %s mode before callback", async (mode) => {
    const result = await run(mode)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("verified environment is clean")
    expect(result.stdout).toContain(`verified mode: ${mode ?? "bundled"}`)
    expect(result.stderr).toBe("")
  }, 30_000)

  test("inherits a verified CA mode through the child environment", async () => {
    const result = await run(undefined, { OPENCODE_TLS_CA_MODE: "system" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("verified mode: system")
    expect(result.stderr).toBe("")
  }, 30_000)

  test("reexec sanitizes hostile Bun and Node CA overrides before loading the command graph", async () => {
    const result = await run("bundled", {
      BUN_OPTIONS: "--smol --use-system-ca",
      NODE_OPTIONS: "--trace-warnings --use-system-ca",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("verified environment is clean")
    expect(result.stdout).toContain("verified mode: bundled")
    expect(result.stderr).not.toMatch(/TLS CA|verification is disabled|conflicting/i)
  }, 30_000)
})
