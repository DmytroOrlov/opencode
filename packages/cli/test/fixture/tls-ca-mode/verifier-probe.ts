import tls from "node:tls"
import {
  getVerifiedTlsCaMode,
  getVerifiedTlsCaModeIfAvailable,
  verifyTlsCaMode,
  type TlsCaMode,
} from "@opencode/util/tls-ca"

type Scenario = {
  readonly mode: TlsCaMode
  readonly bundled?: string[]
  readonly system?: string[]
  readonly extra?: string[]
  readonly default?: string[]
  readonly missingAccessor?: boolean
}

const scenarios: Record<string, Scenario> = {
  "empty-bundled": { mode: "bundled", bundled: [], system: [], extra: [], default: [] },
  "empty-default": { mode: "bundled", bundled: ["BUNDLED"], system: [], extra: [], default: [] },
  "bundled-system-root": {
    mode: "bundled",
    bundled: ["BUNDLED"],
    system: ["SYSTEM"],
    extra: [],
    default: ["BUNDLED", "SYSTEM"],
  },
  "bundled-extra": {
    mode: "bundled",
    bundled: ["BUNDLED"],
    system: [],
    extra: ["EXTRA"],
    default: ["BUNDLED"],
  },
  "ambient-certificate": {
    mode: "bundled",
    bundled: ["BUNDLED"],
    system: [],
    extra: [],
    default: ["BUNDLED"],
  },
  "system-missing": {
    mode: "system",
    bundled: ["BUNDLED"],
    system: ["SYSTEM"],
    extra: [],
    default: ["BUNDLED"],
  },
  "system-unexpected": {
    mode: "system",
    bundled: ["BUNDLED"],
    system: ["SYSTEM"],
    extra: [],
    default: ["BUNDLED", "SYSTEM", "UNEXPECTED"],
  },
  "success-bundled": {
    mode: "bundled",
    bundled: ["BUNDLED"],
    system: ["SYSTEM"],
    extra: [],
    default: ["BUNDLED"],
  },
  "success-system": {
    mode: "system",
    bundled: ["BUNDLED"],
    system: ["SYSTEM"],
    extra: ["EXTRA"],
    default: ["BUNDLED", "SYSTEM", "EXTRA"],
  },
  disabled: { mode: "bundled" },
  missing: { mode: "bundled", missingAccessor: true },
}

const name = process.argv[2]
const scenario = scenarios[name]
if (!scenario) throw new Error(`Unknown verifier scenario: ${name}`)

if (scenario.missingAccessor) {
  Object.defineProperty(tls, "getCACertificates", { value: undefined, configurable: true })
} else {
  Object.defineProperty(tls, "getCACertificates", {
    configurable: true,
    value: (type: "default" | "bundled" | "system" | "extra") => scenario[type] ?? [],
  })
}

function strictStillThrows() {
  try {
    getVerifiedTlsCaMode()
    return false
  } catch {
    return true
  }
}

try {
  const selected = verifyTlsCaMode(scenario.mode)
  console.log(
    `VERIFIER_EVIDENCE ${JSON.stringify({
      scenario: name,
      ok: true,
      selected,
      optional: getVerifiedTlsCaModeIfAvailable(),
      strict: getVerifiedTlsCaMode(),
    })}`,
  )
} catch (error) {
  console.log(
    `VERIFIER_EVIDENCE ${JSON.stringify({
      scenario: name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      optional: getVerifiedTlsCaModeIfAvailable() ?? null,
      strictThrows: strictStillThrows(),
    })}`,
  )
}
