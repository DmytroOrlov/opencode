import { afterEach, describe, expect, test } from "bun:test"
import { disposeInstance, registerDisposer } from "@/effect/instance-registry"

describe("instance disposer registry", () => {
  const registrations: Array<() => void> = []
  afterEach(() => {
    for (const unregister of registrations.splice(0)) unregister()
  })

  test("settles synchronous throws and rejected promises while invoking every disposer once", async () => {
    const calls: string[] = []
    const syncThrow = (directory: string) => {
      calls.push(`sync:${directory}`)
      throw new Error("sync cleanup")
    }
    const reject = async (directory: string) => {
      calls.push(`reject:${directory}`)
      throw new Error("async cleanup")
    }
    const succeed = async (directory: string) => {
      calls.push(`success:${directory}`)
    }
    registrations.push(registerDisposer(syncThrow), registerDisposer(reject), registerDisposer(succeed))

    const outcomes = await disposeInstance("/project")

    expect(calls).toEqual(["sync:/project", "reject:/project", "success:/project"])
    const ownOutcomes = outcomes.filter((outcome) => [syncThrow, reject, succeed].includes(outcome.disposer))
    expect(ownOutcomes).toHaveLength(3)
    expect(ownOutcomes.filter((outcome) => outcome.status === "failure")).toHaveLength(2)
    expect(ownOutcomes.filter((outcome) => outcome.status === "success")).toHaveLength(1)
  })
})
