import { verifyTlsCaMode, type TlsCaMode } from "@opencode/util/tls-ca"
import { selfCommand } from "../../../src/util/process"

const input = process.argv[2]

if (input === "unattested") {
  try {
    selfCommand()
    console.log(`SELF_COMMAND_EVIDENCE ${JSON.stringify({ ok: true })}`)
  } catch (error) {
    console.log(
      `SELF_COMMAND_EVIDENCE ${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}`,
    )
  }
} else {
  const mode = verifyTlsCaMode(input as TlsCaMode)
  console.log(`SELF_COMMAND_EVIDENCE ${JSON.stringify({ mode, command: selfCommand(), entrypoint: process.argv[1] })}`)
}
