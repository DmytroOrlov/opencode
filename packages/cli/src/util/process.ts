import path from "node:path"
import { getVerifiedTlsCaMode, replaceTlsCaFlags } from "@opencode/util/tls-ca"

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand() {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  return [process.execPath, ...replaceTlsCaFlags(getVerifiedTlsCaMode(), process.execArgv), entrypoint]
}
