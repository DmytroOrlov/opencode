import { runTlsCaBootstrap } from "../../../src/bootstrap"
import { getVerifiedTlsCaMode } from "@opencode/util/tls-ca"

await runTlsCaBootstrap(async () => {
  if (
    process.env.OPENCODE_TLS_CA_BOOTSTRAPPED !== undefined ||
    process.env.BUN_OPTIONS !== undefined ||
    process.env.NODE_OPTIONS !== undefined
  ) {
    console.error("bootstrap environment was not clean after verification")
    process.exitCode = 2
    return
  }

  console.log("verified environment is clean")
  console.log(`verified mode: ${getVerifiedTlsCaMode()}`)
})
