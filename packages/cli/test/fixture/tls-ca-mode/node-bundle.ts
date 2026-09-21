import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

async function buildNodeFixture(prefix: string, source: string, naming: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dirname, source)],
      target: "node",
      format: "esm",
      outdir: directory,
      naming,
      throw: false,
    })
    if (!result.success || !result.outputs[0]) {
      for (const log of result.logs) console.error(log)
      throw new Error("Failed to build the Node source fixture")
    }
    return {
      file: result.outputs[0].path,
      dispose: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export function buildNodeBootstrapObservation() {
  return buildNodeFixture("opencode-node-tls-bootstrap-", "bootstrap-observation.ts", "bootstrap-observation.mjs")
}

export function buildNodeSelfCommandObservation() {
  return buildNodeFixture("opencode-node-self-command-", "self-command-probe.ts", "self-command-observation.mjs")
}
