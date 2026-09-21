import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  TLS_CA_CERTIFICATE_ENVIRONMENT,
  parseTlsCaMode,
  replaceTlsCaFlags,
  sanitizeTlsCaEnvironment,
  type TlsCaMode,
} from "@opencode/util/tls-ca"
import { bunRecoveryFlags, bunRuntimeFlags } from "../src/util/process"
import {
  bootstrapObservation,
  cleanEnvironment,
  fixtureDirectory,
  hostilePreload,
  hostilePreloadCjs,
  markerPids,
  nodeExecutable,
  runProcess,
  structuredLine,
} from "./fixture/tls-ca-mode/harness"
import { buildNodeBootstrapObservation } from "./fixture/tls-ca-mode/node-bundle"

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
      BUN_BE_BUN: "1",
      PATH: "/usr/bin",
    })

    expect(Object.hasOwn(result, "BUN_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "NODE_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "BUN_BE_BUN")).toBe(false)
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
      SSL_CERT_DIR: "/tmp/certs",
      BUN_BE_BUN: "1",
    })

    expect(result.NODE_USE_SYSTEM_CA).toBe("1")
    expect(result.NODE_EXTRA_CA_CERTS).toBe("/tmp/extra.pem")
    expect(result.SSL_CERT_FILE).toBe("/tmp/certs.pem")
    expect(result.SSL_CERT_DIR).toBe("/tmp/certs")
    expect(result.OPENCODE_TLS_CA_MODE).toBe("system")
    expect(Object.hasOwn(result, "NODE_TLS_REJECT_UNAUTHORIZED")).toBe(false)
    expect(Object.hasOwn(result, "BUN_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "NODE_OPTIONS")).toBe(false)
    expect(Object.hasOwn(result, "BUN_BE_BUN")).toBe(false)
  })

  test("bundled deletes empty certificate override keys without mutating its input", () => {
    const input = {
      NODE_EXTRA_CA_CERTS: "",
      NODE_USE_SYSTEM_CA: "",
      SSL_CERT_FILE: "",
      SSL_CERT_DIR: "",
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      BUN_OPTIONS: "",
      NODE_OPTIONS: "",
      BUN_BE_BUN: "",
      OPENCODE_TLS_CA_MODE: "system",
      PATH: "/usr/bin",
      TLS_CA_UNRELATED: "keep",
    }
    const snapshot = { ...input }
    const result = sanitizeTlsCaEnvironment("bundled", input)

    expect(input).toEqual(snapshot)
    expect(result).not.toBe(input)
    for (const key of TLS_CA_CERTIFICATE_ENVIRONMENT) expect(Object.hasOwn(result, key)).toBe(false)
    expect(result.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
    expect(result.OPENCODE_TLS_CA_MODE).toBe("bundled")
    expect(result.PATH).toBe("/usr/bin")
    expect(result.TLS_CA_UNRELATED).toBe("keep")
  })

  test("system preserves permitted certificate inputs and does not mutate its input", () => {
    const input = {
      NODE_EXTRA_CA_CERTS: "",
      NODE_USE_SYSTEM_CA: "",
      SSL_CERT_FILE: "",
      SSL_CERT_DIR: "/tmp/certs",
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      BUN_BE_BUN: "1",
      TLS_CA_UNRELATED: "keep",
    }
    const snapshot = { ...input }
    const result = sanitizeTlsCaEnvironment("system", input)

    expect(input).toEqual(snapshot)
    expect(result).not.toBe(input)
    expect(result.NODE_EXTRA_CA_CERTS).toBe("")
    expect(result.NODE_USE_SYSTEM_CA).toBe("")
    expect(result.SSL_CERT_FILE).toBe("")
    expect(result.SSL_CERT_DIR).toBe("/tmp/certs")
    expect(result.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
    expect(result.TLS_CA_UNRELATED).toBe("keep")
    expect(Object.hasOwn(result, "BUN_BE_BUN")).toBe(false)
  })
})

describe("Bun source runtime flags", () => {
  test("recovery retains only the browser condition and the selected CA flag", () => {
    expect(
      bunRecoveryFlags(
        [
          "--conditions=browser",
          "--conditions",
          "browser",
          "--conditions=devel",
          "--smol",
          "--inspect=127.0.0.1:0",
          "--preload",
          hostilePreload,
          "--use-system-ca",
        ],
        "system",
      ),
    ).toEqual(["--conditions=browser", "--conditions", "browser", "--use-system-ca"])
  })

  test("clean-launch classification accepts only approved Bun options", () => {
    expect(
      bunRuntimeFlags([
        "--conditions=browser",
        "--conditions",
        "browser",
        "--conditions=devel",
        "--smol",
        "--user-agent=opencode/local/1/cli",
        "--no-warnings",
        "--",
        "--use-system-ca",
        "--inspect=127.0.0.1:0",
        "--preload",
        hostilePreload,
      ]),
    ).toEqual([
      "--conditions=browser",
      "--conditions",
      "browser",
      "--smol",
      "--user-agent=opencode/local/1/cli",
      "--no-warnings",
      "--",
      "--use-system-ca",
    ])
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

  test.each(["system", "bundled", "openssl"] as const)(
    "a no-selector launch verifies bundled regardless of ambient %s",
    async (ambient) => {
      const result = await run(undefined, { OPENCODE_TLS_CA_MODE: ambient })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("verified mode: bundled")
      expect(result.stderr).toBe("")
    },
    30_000,
  )

  test.each([
    ["bundled", "system"],
    ["bundled", "openssl"],
    ["system", "bundled"],
    ["system", "openssl"],
  ] as const)("explicit %s selection ignores conflicting ambient %s", async (mode, ambient) => {
    const result = await run(mode, { OPENCODE_TLS_CA_MODE: ambient })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`verified mode: ${mode}`)
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

describe("Node source fresh selection", () => {
  let nodeBundle: Awaited<ReturnType<typeof buildNodeBootstrapObservation>>

  beforeAll(async () => {
    nodeBundle = await buildNodeBootstrapObservation()
  }, 30_000)

  afterAll(async () => {
    await nodeBundle?.dispose()
  })

  async function run(mode?: TlsCaMode, env?: Record<string, string | undefined>) {
    const result = await runProcess(
      [nodeExecutable(), nodeBundle.file, ...(mode ? [`--tls-ca-mode=${mode}`] : [])],
      { env: cleanEnvironment(env) },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    return structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
  }

  test.each(["system", "bundled", "openssl"] as const)(
    "a no-selector launch verifies bundled regardless of ambient %s",
    async (ambient) => {
      expect(await run(undefined, { OPENCODE_TLS_CA_MODE: ambient })).toMatchObject({ mode: "bundled" })
    },
    30_000,
  )

  test.each([
    ["bundled", "system"],
    ["bundled", "openssl"],
    ["system", "bundled"],
    ["system", "openssl"],
  ] as const)("explicit %s selection ignores conflicting ambient %s", async (mode, ambient) => {
    expect(await run(mode, { OPENCODE_TLS_CA_MODE: ambient })).toMatchObject({ mode })
  }, 30_000)
})

describe("CLI process boundary", () => {
  const cli = path.join(import.meta.dirname, "../src/index.ts")
  const cwd = path.join(import.meta.dirname, "..")

  test.each([
    ["unknown value", ["--tls-ca-mode=openssl", "--version"], /Unknown TLS CA mode: openssl/],
    ["conflicting selectors", ["--tls-ca-mode=bundled", "--tls-ca-mode=system", "--version"], /Conflicting TLS CA mode/],
    ["missing value", ["--tls-ca-mode"], /Missing value for --tls-ca-mode/],
    ["legacy camelCase equals", ["--tlsCaMode=system", "--version"], /Unsupported flag: --tlsCaMode=system/],
    ["legacy camelCase separate", ["--tlsCaMode", "system", "--version"], /Unsupported flag: --tlsCaMode/],
  ] as const)("rejects %s before command output", async (_name, args, error) => {
    const result = await runProcess([process.execPath, "--conditions=browser", cli, ...args], {
      cwd,
      env: cleanEnvironment(),
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(error)
  }, 30_000)

  test("a valid selector reaches the protected command graph", async () => {
    const result = await runProcess(
      [process.execPath, "--conditions=browser", cli, "--tls-ca-mode=bundled", "--version"],
      { cwd, env: cleanEnvironment() },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/opencode v/)
    expect(result.stderr).toBe("")
  }, 30_000)

  test("runCli rejects an unverified process without command output", async () => {
    const result = await runProcess([process.execPath, path.join(fixtureDirectory, "direct-cli.ts")], {
      cwd,
      env: cleanEnvironment(),
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("TLS CA mode has not been verified")
  }, 30_000)
})

describe("effective trust-set verifier", () => {
  const verifier = path.join(fixtureDirectory, "verifier-probe.ts")

  const scenarios: ReadonlyArray<{
    readonly name: string
    readonly error: RegExp
    readonly env?: Record<string, string>
  }> = [
    { name: "missing", error: /Effective TLS CA verification is unavailable/ },
    { name: "empty-bundled", error: /Bundled CA set is empty/ },
    { name: "empty-default", error: /Effective default CA set is empty/ },
    { name: "bundled-system-root", error: /does not equal bundled CA set/ },
    { name: "bundled-extra", error: /ambient certificate overrides/ },
    {
      name: "ambient-certificate",
      error: /ambient certificate overrides/,
      env: { NODE_EXTRA_CA_CERTS: "/tmp/unused-extra.pem" },
    },
    { name: "system-missing", error: /does not equal bundled, system, and extra CA union/ },
    { name: "system-unexpected", error: /does not equal bundled, system, and extra CA union/ },
    { name: "disabled", error: /NODE_TLS_REJECT_UNAUTHORIZED=0/, env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
  ]

  for (const scenario of scenarios) {
    test(`${scenario.name} fails without publishing a mode`, async () => {
      const result = await runProcess([process.execPath, verifier, scenario.name], {
        env: cleanEnvironment(scenario.env),
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const evidence = structuredLine(result.stdout, "VERIFIER_EVIDENCE")
      expect(evidence.ok).toBe(false)
      expect(String(evidence.message)).toMatch(scenario.error)
      expect(evidence.optional).toBeNull()
      expect(evidence.strictThrows).toBe(true)
    }, 30_000)
  }

  test("an exact union succeeds and publishes the selected mode", async () => {
    const result = await runProcess([process.execPath, verifier, "success-system"], {
      env: cleanEnvironment(),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "VERIFIER_EVIDENCE")
    expect(evidence).toMatchObject({ ok: true, selected: "system", optional: "system", strict: "system" })
  }, 30_000)

  test("a clean bundled set succeeds and publishes bundled", async () => {
    const result = await runProcess([process.execPath, verifier, "success-bundled"], {
      env: cleanEnvironment(),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(structuredLine(result.stdout, "VERIFIER_EVIDENCE")).toMatchObject({
      ok: true,
      selected: "bundled",
      optional: "bundled",
      strict: "bundled",
    })
  }, 30_000)
})

describe("source runtime option isolation", () => {
  let nodeBundle: Awaited<ReturnType<typeof buildNodeBootstrapObservation>>

  beforeAll(async () => {
    nodeBundle = await buildNodeBootstrapObservation()
  }, 30_000)

  afterAll(async () => {
    await nodeBundle?.dispose()
  })

  test("Bun clean launch uses the verified fast path and clears live environment overrides", async () => {
    const result = await runProcess(
      [
        process.execPath,
        "--conditions=browser",
        "--no-warnings",
        bootstrapObservation,
        "--tls-ca-mode=bundled",
        "clean-bun",
      ],
      {
        env: cleanEnvironment({
          NODE_EXTRA_CA_CERTS: "",
          NODE_USE_SYSTEM_CA: "",
          SSL_CERT_FILE: "",
          SSL_CERT_DIR: "",
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          TLS_CA_TEST_UNRELATED: "keep",
        }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence).toMatchObject({
      pid: result.pid,
      mode: "bundled",
      argv: ["clean-bun"],
      execArgv: ["--conditions=browser", "--no-warnings"],
      environment: {
        OPENCODE_TLS_CA_MODE: "bundled",
        OPENCODE_TLS_CA_BOOTSTRAPPED: null,
        BUN_OPTIONS: null,
        NODE_OPTIONS: null,
        BUN_BE_BUN: null,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        NODE_EXTRA_CA_CERTS: null,
        NODE_USE_SYSTEM_CA: null,
        SSL_CERT_FILE: null,
        SSL_CERT_DIR: null,
        TLS_CA_TEST_UNRELATED: "keep",
      },
      certificateKeysPresent: {
        NODE_EXTRA_CA_CERTS: false,
        NODE_USE_SYSTEM_CA: false,
        SSL_CERT_FILE: false,
        SSL_CERT_DIR: false,
      },
      preloadSentinel: null,
    })
  }, 30_000)

  test("Node clean launch keeps approved runtime flags and loads the required FFI builtin", async () => {
    const result = await runProcess(
      [
        nodeExecutable(),
        "--experimental-ffi",
        "--conditions=browser",
        "--no-warnings",
        "--disable-warning=ExperimentalWarning",
        nodeBundle.file,
        "--tls-ca-mode=bundled",
        "clean-node",
      ],
      { env: cleanEnvironment({ TLS_CA_TEST_UNRELATED: "keep" }) },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence).toMatchObject({
      pid: result.pid,
      mode: "bundled",
      argv: ["clean-node"],
      execArgv: [
        "--experimental-ffi",
        "--conditions=browser",
        "--no-warnings",
        "--disable-warning=ExperimentalWarning",
      ],
      environment: {
        OPENCODE_TLS_CA_MODE: "bundled",
        OPENCODE_TLS_CA_BOOTSTRAPPED: null,
        NODE_OPTIONS: null,
        BUN_OPTIONS: null,
        TLS_CA_TEST_UNRELATED: "keep",
      },
      ffiError: null,
    })
    expect(evidence.bun).toBeNull()
    expect(evidence.runtime).toMatch(/^node\//)
    expect(evidence.ffi).toContain("DynamicLibrary")
  }, 30_000)

  test("real recovery removes disabled verification while retaining enabled verification", async () => {
    const disabled = await runProcess(
      [process.execPath, bootstrapObservation, "--tls-ca-mode=bundled", "disabled-recovered"],
      { env: cleanEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }) },
    )

    expect(disabled.exitCode).toBe(0)
    expect(disabled.stderr).toBe("")
    const recovered = structuredLine(disabled.stdout, "BOOTSTRAP_EVIDENCE")
    expect(recovered.pid).not.toBe(disabled.pid)
    expect(recovered).toMatchObject({
      mode: "bundled",
      argv: ["disabled-recovered"],
      environment: {
        NODE_TLS_REJECT_UNAUTHORIZED: null,
        OPENCODE_TLS_CA_BOOTSTRAPPED: null,
        BUN_OPTIONS: null,
        NODE_OPTIONS: null,
      },
    })
  }, 30_000)

  test("a nonempty ambient BUN_OPTIONS is dirty even with an approved-looking value", async () => {
    const result = await runProcess(
      [
        process.execPath,
        bootstrapObservation,
        "--tls-ca-mode=bundled",
        "ambient-bun",
      ],
      { env: cleanEnvironment({ BUN_OPTIONS: "--smol", TLS_CA_TEST_UNRELATED: "keep" }) },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence.pid).not.toBe(result.pid)
    expect(evidence).toMatchObject({
      mode: "bundled",
      argv: ["ambient-bun"],
      execArgv: ["--use-bundled-ca"],
      environment: {
        BUN_OPTIONS: null,
        NODE_OPTIONS: null,
        OPENCODE_TLS_CA_MODE: "bundled",
        TLS_CA_TEST_UNRELATED: "keep",
      },
    })
  }, 30_000)

  test("Bun recovery drops an explicitly supplied preload and its process-local effect", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-bun-preload-"))
    const preloadMarker = path.join(directory, "preload-pids.txt")
    try {
      const result = await runProcess(
        [
          process.execPath,
          "--preload",
          hostilePreload,
          bootstrapObservation,
          "--tls-ca-mode=bundled",
          "preload-bun",
        ],
        {
          env: cleanEnvironment({
            TLS_CA_PRELOAD_MARKER: preloadMarker,
            TLS_CA_TEST_UNRELATED: "keep",
          }),
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const pids = await markerPids(preloadMarker)
      expect(pids).toEqual([result.pid])
      const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
      expect(evidence.pid).not.toBe(result.pid)
      expect(evidence).toMatchObject({
        mode: "bundled",
        argv: ["preload-bun"],
        execArgv: ["--use-bundled-ca"],
        preloadSentinel: null,
        environment: {
          BUN_OPTIONS: null,
          NODE_OPTIONS: null,
          OPENCODE_TLS_CA_BOOTSTRAPPED: null,
          TLS_CA_PRELOAD_MARKER: preloadMarker,
          TLS_CA_TEST_UNRELATED: "keep",
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("a nonempty ambient NODE_OPTIONS is dirty even when every flag is approved", async () => {
    const result = await runProcess(
      [nodeExecutable(), nodeBundle.file, "--tls-ca-mode=bundled", "ambient-node"],
      { env: cleanEnvironment({ NODE_OPTIONS: "--no-warnings", TLS_CA_TEST_UNRELATED: "keep" }) },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence.pid).not.toBe(result.pid)
    expect(evidence).toMatchObject({
      mode: "bundled",
      argv: ["ambient-node"],
      execArgv: ["--use-bundled-ca"],
      environment: {
        NODE_OPTIONS: null,
        BUN_OPTIONS: null,
        OPENCODE_TLS_CA_MODE: "bundled",
        TLS_CA_TEST_UNRELATED: "keep",
      },
    })
  }, 30_000)

  test("Node recovery drops an explicitly supplied require while retaining required runtime options", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-node-preload-"))
    const preloadMarker = path.join(directory, "preload-pids.txt")
    const certificateDirectory = path.join(directory, "certificates")
    await Bun.write(path.join(certificateDirectory, ".keep"), "")
    const root = path.join(fixtureDirectory, "root.pem")
    try {
      const result = await runProcess(
        [
          nodeExecutable(),
          "--experimental-ffi",
          "--conditions=browser",
          "--no-warnings",
          "--disable-warning=ExperimentalWarning",
          "--require",
          hostilePreloadCjs,
          nodeBundle.file,
          "--tls-ca-mode=system",
          "require-node",
        ],
        {
          env: cleanEnvironment({
            TLS_CA_PRELOAD_MARKER: preloadMarker,
            NODE_EXTRA_CA_CERTS: root,
            SSL_CERT_DIR: certificateDirectory,
            TLS_CA_TEST_UNRELATED: "keep",
          }),
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const pids = await markerPids(preloadMarker)
      expect(pids).toEqual([result.pid])
      const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
      expect(evidence.pid).not.toBe(result.pid)
      expect(evidence).toMatchObject({
        mode: "system",
        argv: ["require-node"],
        execArgv: [
          "--experimental-ffi",
          "--conditions=browser",
          "--no-warnings",
          "--disable-warning=ExperimentalWarning",
          "--use-system-ca",
        ],
        ffiError: null,
        preloadSentinel: null,
        environment: {
          NODE_EXTRA_CA_CERTS: root,
          SSL_CERT_DIR: certificateDirectory,
          NODE_OPTIONS: null,
          BUN_OPTIONS: null,
          OPENCODE_TLS_CA_BOOTSTRAPPED: null,
          OPENCODE_TLS_CA_MODE: "system",
          TLS_CA_PRELOAD_MARKER: preloadMarker,
          TLS_CA_TEST_UNRELATED: "keep",
        },
      })
      expect(evidence.ffi).toContain("DynamicLibrary")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("a marked dirty launch rejects without importing or executing the protected callback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-marked-dirty-"))
    const guardMarker = path.join(directory, "guard.txt")
    const preloadMarker = path.join(directory, "preload-pids.txt")
    try {
      const result = await runProcess(
        [
          process.execPath,
          "--use-system-ca",
          "--inspect=127.0.0.1:0",
          "--preload",
          hostilePreload,
          path.join(fixtureDirectory, "guarded-bootstrap.ts"),
          "--tls-ca-mode=system",
        ],
        {
          env: cleanEnvironment({
            OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
            OPENCODE_TLS_CA_MODE: "system",
            TLS_CA_GUARD_MARKER: guardMarker,
            TLS_CA_PRELOAD_MARKER: preloadMarker,
          }),
        },
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("Disallowed runtime options in TLS CA recovery")
      expect(await markerPids(guardMarker)).toEqual([])
      expect(await markerPids(preloadMarker)).toEqual([result.pid])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("ordinary recovery does not replay an unmarked inspector", async () => {
    const result = await runProcess(
      [
        process.execPath,
        "--use-system-ca",
        "--inspect=127.0.0.1:0",
        "--conditions=browser",
        bootstrapObservation,
        "--tls-ca-mode=system",
        "unmarked-inspector",
      ],
      { env: cleanEnvironment() },
    )

    expect(result.exitCode).toBe(0)
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence.pid).not.toBe(result.pid)
    expect(evidence).toMatchObject({
      mode: "system",
      argv: ["unmarked-inspector"],
      execArgv: ["--conditions=browser", "--use-system-ca"],
      preloadSentinel: null,
      environment: {
        OPENCODE_TLS_CA_MODE: "system",
        OPENCODE_TLS_CA_BOOTSTRAPPED: null,
        BUN_OPTIONS: null,
        NODE_OPTIONS: null,
      },
    })
  }, 30_000)

  test("a single marked inspector remains on the verified fast path and cleans the live environment", async () => {
    const result = await runProcess(
      [
        process.execPath,
        "--use-system-ca",
        "--inspect=127.0.0.1:0",
        "--conditions=browser",
        bootstrapObservation,
        "--tls-ca-mode=system",
        "marked-inspector",
      ],
      {
        env: cleanEnvironment({
          OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
          OPENCODE_TLS_CA_MODE: "system",
          TLS_CA_TEST_UNRELATED: "keep",
        }),
      },
    )

    expect(result.exitCode).toBe(0)
    const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
    expect(evidence).toMatchObject({
      pid: result.pid,
      mode: "system",
      argv: ["marked-inspector"],
      execArgv: ["--use-system-ca", "--inspect=127.0.0.1:0", "--conditions=browser"],
      environment: {
        OPENCODE_TLS_CA_MODE: "system",
        OPENCODE_TLS_CA_BOOTSTRAPPED: null,
        BUN_OPTIONS: null,
        NODE_OPTIONS: null,
        TLS_CA_TEST_UNRELATED: "keep",
      },
      preloadSentinel: null,
    })
    expect(`${result.stdout}\n${result.stderr}`.match(/Listening:/g)).toHaveLength(1)
  }, 30_000)

  test("a marked verification failure rejects without executing the protected callback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-marked-verify-"))
    const guardMarker = path.join(directory, "guard.txt")
    try {
      const result = await runProcess(
        [
          process.execPath,
          "--use-system-ca",
          path.join(fixtureDirectory, "guarded-bootstrap.ts"),
          "--tls-ca-mode=system",
        ],
        {
          env: cleanEnvironment({
            OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
            OPENCODE_TLS_CA_MODE: "system",
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            TLS_CA_GUARD_MARKER: guardMarker,
          }),
        },
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("TLS certificate verification is disabled by NODE_TLS_REJECT_UNAUTHORIZED=0")
      expect(await markerPids(guardMarker)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
