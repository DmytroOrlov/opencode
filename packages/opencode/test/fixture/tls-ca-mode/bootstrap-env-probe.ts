import { runTlsCaBootstrap } from "../../../src/bootstrap"
import { getTlsCaMode } from "../../../src/tls-ca-mode"

await runTlsCaBootstrap(async () => {
  if (process.env.BUN_OPTIONS !== undefined) {
    console.error(`BUN_OPTIONS leaked: ${process.env.BUN_OPTIONS}`)
    process.exit(2)
  }

  if (process.env.OPENCODE_TLS_CA_BOOTSTRAPPED !== undefined) {
    console.error(
      `OPENCODE_TLS_CA_BOOTSTRAPPED leaked: ${process.env.OPENCODE_TLS_CA_BOOTSTRAPPED}`,
    )
    process.exit(3)
  }

  console.log("verified environment is clean")
  console.log(`verified mode: ${getTlsCaMode()}`)
})
