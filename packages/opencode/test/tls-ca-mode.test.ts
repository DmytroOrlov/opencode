import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test"
import {
  type TlsCaMode,
  parseTlsCaMode,
  isBunVirtualEntrypoint,
  makeTlsBunOptions,
  sourceExecArgv,
  assertTlsCaEnvironment,
  sanitizeTlsCaEnvironment,
  tlsCaSpawnUnsetEnvironment,
  assertTlsCaVerified,
} from "../src/tls-ca-mode"

describe("parseTlsCaMode", () => {
  const accepted: Array<{ label: string; argv: string[]; mode: TlsCaMode; expected: string[] }> = [
    { label: "default is bundled", argv: [], mode: "bundled", expected: [] },
    { label: "unrelated args default to bundled", argv: ["--version"], mode: "bundled", expected: ["--version"] },
    { label: "web subcommand defaults to bundled", argv: ["web"], mode: "bundled", expected: ["web"] },
    { label: "subcommand defaults to bundled", argv: ["serve"], mode: "bundled", expected: ["serve"] },
    { label: "equals syntax system", argv: ["--tls-ca-mode=system"], mode: "system", expected: [] },
    { label: "equals syntax bundled", argv: ["--tls-ca-mode=bundled"], mode: "bundled", expected: [] },
    { label: "split syntax system", argv: ["--tls-ca-mode", "system"], mode: "system", expected: [] },
    { label: "split syntax bundled", argv: ["--tls-ca-mode", "bundled"], mode: "bundled", expected: [] },
    { label: "preserves unrelated args system", argv: ["--tls-ca-mode=system", "--version", "serve"], mode: "system", expected: ["--version", "serve"] },
    { label: "preserves unrelated args bundled", argv: ["--tls-ca-mode=bundled", "--version", "serve"], mode: "bundled", expected: ["--version", "serve"] },
    { label: "preserves unrelated args with split form", argv: ["--version", "--tls-ca-mode", "system", "serve"], mode: "system", expected: ["--version", "serve"] },
    { label: "duplicate identical values", argv: ["--tls-ca-mode=system", "--tls-ca-mode=system"], mode: "system", expected: [] },
    { label: "mixed form duplicate", argv: ["--tls-ca-mode", "bundled", "--tls-ca-mode=bundled"], mode: "bundled", expected: [] },
    { label: "args after -- are preserved verbatim", argv: ["--tls-ca-mode=bundled", "--", "--tls-ca-mode=system"], mode: "bundled", expected: ["--", "--tls-ca-mode=system"] },
  ]

  for (const { label, argv, mode, expected } of accepted) {
    test(label, () => {
      const result = parseTlsCaMode(argv)
      expect(result.mode).toBe(mode)
      expect(result.argv).toEqual(expected)
    })
  }

  const rejected: Array<{ label: string; argv: string[]; error: RegExp }> = [
    { label: "conflicting values", argv: ["--tls-ca-mode=system", "--tls-ca-mode=bundled"], error: /conflicting/i },
    { label: "split form missing value", argv: ["--tls-ca-mode"], error: /missing/i },
    { label: "split form value is flag", argv: ["--tls-ca-mode", "--other"], error: /missing/i },
    { label: "unknown value equals", argv: ["--tls-ca-mode=unknown"], error: /unknown/i },
    { label: "unknown value split", argv: ["--tls-ca-mode", "unknown"], error: /unknown/i },
    { label: "camelCase equals system", argv: ["--tlsCaMode=system"], error: /--tls-ca-mode/ },
    { label: "camelCase equals bundled", argv: ["--tlsCaMode=bundled"], error: /--tls-ca-mode/ },
    { label: "camelCase split system", argv: ["--tlsCaMode", "system"], error: /--tls-ca-mode/ },
    { label: "camelCase split bundled", argv: ["--tlsCaMode", "bundled"], error: /--tls-ca-mode/ },
  ]

  for (const { label, argv, error } of rejected) {
    test(label, () => {
      expect(() => parseTlsCaMode(argv)).toThrow(error)
    })
  }

  test("stops parsing at -- separator", () => {
    expect(parseTlsCaMode(["--", "--tls-ca-mode=bundled"]).mode).toBe("bundled")
    expect(parseTlsCaMode(["--", "--tls-ca-mode=system"]).mode).toBe("bundled")
    expect(parseTlsCaMode(["--tls-ca-mode=system", "--", "--tls-ca-mode=bundled"]).mode).toBe("system")
  })
})

describe("assertTlsCaVerified", () => {
  const modPath = require.resolve("../src/tls-ca-mode")

  afterEach(() => {
    delete require.cache[modPath]
  })

  test("throws before verification", () => {
    const mod = require("../src/tls-ca-mode") as typeof import("../src/tls-ca-mode")
    expect(() => mod.assertTlsCaVerified()).toThrow(/must be started through the TLS CA bootstrap/i)
  })

  test("does not throw after verification", () => {
    const mod = require("../src/tls-ca-mode") as typeof import("../src/tls-ca-mode")
    const savedExecArgv = process.execArgv
    Object.defineProperty(process, "execArgv", { value: ["--use-system-ca"], configurable: true })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----"]
      if (kind === "system") return []
      if (kind === "extra") return []
      if (kind === "default") return ["-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----"]
      return []
    })
    try {
      mod.verifyTlsCaMode("system")
      expect(() => mod.assertTlsCaVerified()).not.toThrow()
    } finally {
      tls.getCACertificates = orig
      Object.defineProperty(process, "execArgv", { value: savedExecArgv, configurable: true })
    }
  })
})

describe("makeTlsBunOptions", () => {
  const modes: Array<{ mode: TlsCaMode; expected: string }> = [
    { mode: "system", expected: "--use-system-ca" },
    { mode: "bundled", expected: "--use-bundled-ca" },
  ]

  for (const { mode, expected } of modes) {
    test(`${mode} mode returns exact flag`, () => {
      expect(makeTlsBunOptions(mode)).toBe(expected)
    })
  }
})

describe("isBunVirtualEntrypoint", () => {
  test("POSIX $bunfs path is detected", () => {
    expect(isBunVirtualEntrypoint("/$bunfs/root/entry.js")).toBe(true)
  })

  test("source script path is not detected as compiled", () => {
    expect(isBunVirtualEntrypoint("src/bootstrap.ts")).toBe(false)
    expect(isBunVirtualEntrypoint("/abs/path/to/src/bootstrap.ts")).toBe(false)
  })

  test("undefined path is not detected", () => {
    expect(isBunVirtualEntrypoint(undefined)).toBe(false)
  })
})

describe("sourceExecArgv", () => {
  test("system mode appends use-system-ca and preserves --conditions=browser", () => {
    const result = sourceExecArgv("system", ["--conditions=browser", "--smol"])
    expect(result).toEqual(["--conditions=browser", "--use-system-ca"])
  })

  test("bundled mode appends use-bundled-ca and preserves --conditions=browser", () => {
    const result = sourceExecArgv("bundled", ["--conditions=browser"])
    expect(result).toEqual(["--conditions=browser", "--use-bundled-ca"])
  })

  test("removes conflicting CA flags", () => {
    expect(sourceExecArgv("system", ["--use-bundled-ca", "--conditions=browser"])).toEqual(["--conditions=browser", "--use-system-ca"])
    expect(sourceExecArgv("bundled", ["--use-system-ca", "--conditions=browser", "--use-openssl-ca"])).toEqual(["--conditions=browser", "--use-bundled-ca"])
  })

  test("arbitrary runtime hooks not preserved", () => {
    const result = sourceExecArgv("bundled", [
      "--preload",
      "./does-not-exist.ts",
      "--import",
      "./hook.ts",
      "--conditions=browser",
      "--smol",
    ])
    expect(result).toEqual(["--conditions=browser", "--use-bundled-ca"])
  })

  const removedInspector: Array<{ label: string; arg: string }> = [
    { label: "bare --inspect", arg: "--inspect" },
    { label: "--inspect=ws://host:port", arg: "--inspect=ws://localhost:6499/" },
    { label: "bare --inspect-wait", arg: "--inspect-wait" },
    { label: "--inspect-wait=ws://host:port", arg: "--inspect-wait=ws://localhost:6499/" },
    { label: "bare --inspect-brk", arg: "--inspect-brk" },
    { label: "--inspect-brk=ws://host:port", arg: "--inspect-brk=ws://localhost:6499/" },
  ]

  for (const { label, arg } of removedInspector) {
    test(`removes ${label}`, () => {
      const result = sourceExecArgv("bundled", [arg, "--conditions=browser"])
      expect(result).toEqual(["--conditions=browser", "--use-bundled-ca"])
    })
  }

  test("removes inspector flags alongside --conditions=browser", () => {
    expect(
      sourceExecArgv("system", [
        "--inspect=ws://localhost:6499/",
        "--conditions=browser",
      ]),
    ).toEqual([
      "--conditions=browser",
      "--use-system-ca",
    ])
  })

  const rejectedInspector: Array<{ label: string; arg: string }> = [
    { label: "--inspector (not a Bun flag)", arg: "--inspector" },
    { label: "--inspect-foo (not a Bun flag)", arg: "--inspect-foo" },
    { label: "--inspect-anything (not a Bun flag)", arg: "--inspect-anything" },
  ]

  for (const { label, arg } of rejectedInspector) {
    test(`removes ${label}`, () => {
      const result = sourceExecArgv("bundled", [arg, "--conditions=browser"])
      expect(result).toEqual(["--conditions=browser", "--use-bundled-ca"])
    })
  }

  test("preserves multiple --conditions=browser entries", () => {
    const result = sourceExecArgv("bundled", [
      "--conditions=browser",
      "--conditions=browser",
    ])
    expect(result).toEqual(["--conditions=browser", "--conditions=browser", "--use-bundled-ca"])
  })

  test("drops prefix matches like --conditions=node", () => {
    const result = sourceExecArgv("bundled", [
      "--conditions=browser",
      "--conditions=node",
      "--smol",
    ])
    expect(result).toEqual(["--conditions=browser", "--use-bundled-ca"])
  })
})

describe("sanitizeTlsCaEnvironment", () => {
  const allKeys = ["NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "PATH", "HOME", "APP_CONFIG", "BUN_WORKER_ID", "BUN_OPTIONS"]

  test("bundled mode removes all five TLS variables", () => {
    const env = Object.fromEntries(allKeys.map((k) => [k, "1"])) as NodeJS.ProcessEnv
    const result = sanitizeTlsCaEnvironment("bundled", env)
    for (const key of ["NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      expect(Object.hasOwn(result, key)).toBe(false)
    }
  })

  test("bundled mode preserves unrelated variables exactly", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/user", APP_CONFIG: "foo", BUN_WORKER_ID: "0" }
    const result = sanitizeTlsCaEnvironment("bundled", env)
    expect(result.PATH).toBe("/usr/bin")
    expect(result.HOME).toBe("/home/user")
    expect(result.APP_CONFIG).toBe("foo")
    expect(result.BUN_WORKER_ID).toBe("0")
  })

  test("system mode preserves TLS variables except NODE_TLS_REJECT_UNAUTHORIZED=0", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_USE_SYSTEM_CA: "1",
      NODE_EXTRA_CA_CERTS: "/path/to/cert.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SSL_CERT_FILE: "/path/to/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
    }
    const result = sanitizeTlsCaEnvironment("system", env)
    expect(result.NODE_USE_SYSTEM_CA).toBe("1")
    expect(result.NODE_EXTRA_CA_CERTS).toBe("/path/to/cert.pem")
    expect(Object.hasOwn(result, "NODE_TLS_REJECT_UNAUTHORIZED")).toBe(false)
    expect(result.SSL_CERT_FILE).toBe("/path/to/cert.pem")
    expect(result.SSL_CERT_DIR).toBe("/etc/ssl/certs")
  })

  test("original input object is not mutated", () => {
    const env: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: "/path/to/cert.pem", PATH: "/usr/bin" }
    const originalNodeExtra = env.NODE_EXTRA_CA_CERTS
    sanitizeTlsCaEnvironment("bundled", env)
    expect(env.NODE_EXTRA_CA_CERTS).toBe(originalNodeExtra)
  })

  test("system mode preserves NODE_TLS_REJECT_UNAUTHORIZED when not 0", () => {
    const env: NodeJS.ProcessEnv = { NODE_TLS_REJECT_UNAUTHORIZED: "1", NODE_USE_SYSTEM_CA: "1" }
    const result = sanitizeTlsCaEnvironment("system", env)
    expect(result.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
  })
})

describe("tlsCaSpawnUnsetEnvironment", () => {
  test("bundled mode returns object with all five keys set to undefined", () => {
    const result = tlsCaSpawnUnsetEnvironment("bundled")
    const expected = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const
    for (const key of expected) {
      expect(Object.hasOwn(result, key)).toBe(true)
      expect(result[key]).toBeUndefined()
    }
    expect(Object.keys(result)).toHaveLength(expected.length)
  })

  test("system mode returns NODE_TLS_REJECT_UNAUTHORIZED set to undefined", () => {
    const result = tlsCaSpawnUnsetEnvironment("system")
    expect(Object.hasOwn(result, "NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true)
    expect(result.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(Object.keys(result)).toHaveLength(1)
  })
})

describe("assertTlsCaEnvironment (child-invariant)", () => {
  const tlsEnvKeys = [
    "NODE_USE_SYSTEM_CA",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const

  let savedEnv: Partial<Record<(typeof tlsEnvKeys)[number], string>>

  beforeEach(() => {
    savedEnv = {}

    for (const key of tlsEnvKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of tlsEnvKeys) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const bundledRejections: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ["NODE_USE_SYSTEM_CA", { NODE_USE_SYSTEM_CA: "1" }, /NODE_USE_SYSTEM_CA/],
    ["NODE_EXTRA_CA_CERTS", { NODE_EXTRA_CA_CERTS: "/path/to/cert.pem" }, /NODE_EXTRA_CA_CERTS/],
    ["NODE_TLS_REJECT_UNAUTHORIZED", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, /NODE_TLS_REJECT_UNAUTHORIZED/],
    ["SSL_CERT_FILE", { SSL_CERT_FILE: "/path/to/cert.pem" }, /SSL_CERT_FILE/],
    ["SSL_CERT_DIR", { SSL_CERT_DIR: "/etc/ssl/certs" }, /SSL_CERT_DIR/],
  ]

  for (const [name, env, error] of bundledRejections) {
    test(`bundled mode rejects ${name}`, () => {
      expect(() => assertTlsCaEnvironment("bundled", env)).toThrow(error)
    })
  }

  test("system mode does not reject CA environment variables", () => {
    expect(() => assertTlsCaEnvironment("system", { NODE_USE_SYSTEM_CA: "1" })).not.toThrow()
    expect(() => assertTlsCaEnvironment("system", { NODE_EXTRA_CA_CERTS: "/path/to/cert.pem" })).not.toThrow()
    expect(() => assertTlsCaEnvironment("system", { SSL_CERT_FILE: "/path/to/cert.pem" })).not.toThrow()
  })

  test("system mode rejects NODE_TLS_REJECT_UNAUTHORIZED=0", () => {
    expect(() => assertTlsCaEnvironment("system", { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/)
  })
})

describe("verifyTlsCaMode (injected)", () => {
  const modPath = require.resolve("../src/tls-ca-mode")
  let mod: typeof import("../src/tls-ca-mode")

  const savedExecArgv = process.execArgv

  function freshMod() {
    delete require.cache[modPath]
    mod = require("../src/tls-ca-mode") as typeof import("../src/tls-ca-mode")
    return mod
  }

  afterEach(() => {
    delete require.cache[modPath]
    Object.defineProperty(process, "execArgv", { value: savedExecArgv, configurable: true })
  })

  function withExecArgv(args: string[]) {
    Object.defineProperty(process, "execArgv", { value: args, configurable: true })
  }

  test("bundled verification accepts an exact bundled effective set", () => {
    const { verifyTlsCaMode, getTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "default") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "system") return []
      if (kind === "extra") return []
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      const mode = verifyTlsCaMode("bundled")
      expect(mode).toBe("bundled")
      expect(getTlsCaMode()).toBe("bundled")
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("bundled verification rejects an extra certificate", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "default") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "system") return []
      if (kind === "extra") return ["-----BEGIN CERTIFICATE-----\nEXTRA\n-----END CERTIFICATE-----"]
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow(/extra/i)
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("bundled verification rejects an effective set with system-only certs", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "default") return [
        "-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----",
        "-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----",
      ]
      if (kind === "system") return ["-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----"]
      if (kind === "extra") return []
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow(/default/i)
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("system verification accepts the exact bundled+system+extra union", () => {
    const { verifyTlsCaMode, getTlsCaMode } = freshMod()
    withExecArgv(["--use-system-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nBUNDLED\n-----END CERTIFICATE-----"]
      if (kind === "system") return ["-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----"]
      if (kind === "extra") return ["-----BEGIN CERTIFICATE-----\nEXTRA\n-----END CERTIFICATE-----"]
      if (kind === "default") return [
        "-----BEGIN CERTIFICATE-----\nBUNDLED\n-----END CERTIFICATE-----",
        "-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----",
        "-----BEGIN CERTIFICATE-----\nEXTRA\n-----END CERTIFICATE-----",
      ]
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      const mode = verifyTlsCaMode("system")
      expect(mode).toBe("system")
      expect(getTlsCaMode()).toBe("system")
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("effective-set mismatch throws", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-system-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nBUNDLED\n-----END CERTIFICATE-----"]
      if (kind === "system") return ["-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----"]
      if (kind === "extra") return []
      if (kind === "default") return ["-----BEGIN CERTIFICATE-----\nWRONG\n-----END CERTIFICATE-----"]
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("system")).toThrow()
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("conflicting execArgv throws", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca", "--use-system-ca"])
    expect(() => verifyTlsCaMode("bundled")).toThrow(/conflicting/i)
  })

  test("active mode is not published after failed verification", () => {
    const { verifyTlsCaMode, getTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = undefined
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow()
      expect(() => getTlsCaMode()).toThrow(/not.*verified/i)
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("bundled verification rejects an empty bundled set", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return []
      if (kind === "default") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "system") return []
      if (kind === "extra") return []
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow(/Bundled CA set is empty/)
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("bundled verification rejects an empty default set", () => {
    const { verifyTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return ["-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----"]
      if (kind === "default") return []
      if (kind === "system") return []
      if (kind === "extra") return []
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow(/Default CA set is empty in bundled mode/)
    } finally {
      tls.getCACertificates = orig
    }
  })

  test("empty-set failure does not publish verified mode", () => {
    const { verifyTlsCaMode, getTlsCaMode } = freshMod()
    withExecArgv(["--use-bundled-ca"])
    const mockGetCA = mock().mockImplementation((kind: string) => {
      if (kind === "bundled") return []
      if (kind === "default") return []
      if (kind === "system") return []
      if (kind === "extra") return []
      return []
    })
    const tls = require("node:tls") as { getCACertificates?: (k: string) => string[] }
    const orig = tls.getCACertificates
    tls.getCACertificates = mockGetCA
    try {
      expect(() => verifyTlsCaMode("bundled")).toThrow(/Bundled CA set is empty/)
      expect(() => getTlsCaMode()).toThrow(/not.*verified/i)
    } finally {
      tls.getCACertificates = orig
    }
  })
})

describe("guarded index.ts structural assertion", () => {
  test("index.ts contains no static production imports other than ./tls-ca-mode", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    const importLines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("import "))
      .filter((l) => !l.includes("from \"./tls-ca-mode\""))
    expect(importLines).toHaveLength(0)
  })
})
