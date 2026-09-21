import { writeFileSync } from "node:fs"

const [file, ...keys] = process.argv.slice(2)
if (file === undefined) throw new Error("Missing observation file")

writeFileSync(
  file,
  JSON.stringify(
    Object.fromEntries(
      keys.map((key) => [key, Object.hasOwn(process.env, key) ? (process.env[key] ?? null) : null]),
    ),
  ),
)
