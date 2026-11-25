import { describe, expect, test, vi } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { OpenCode } from "@opencode/client/promise"
import { createShellOptions, createSoundPreviewController } from "./behavior"
import { createOptimisticSetting } from "./controllers"
import type { SettingWriteFailure } from "./machine"

describe("settings controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", async () => {
    vi.useFakeTimers()

    try {
      const played: string[] = []
      const stopped: string[] = []

      const owned = createRoot((dispose) => ({
        dispose,
        preview: createSoundPreviewController(async (id) => {
          played.push(id ?? "")

          return () => stopped.push(id ?? "")
        }),
      }))

      owned.preview.play("first")
      vi.advanceTimersByTime(99)
      expect(played).toEqual([])

      owned.preview.play("second")
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(played).toEqual(["second"])

      owned.dispose()
      expect(stopped).toEqual(["second"])
    } finally {
      vi.useRealTimers()
    }
  })

  test("the settings write driver distinguishes committed PATCH failures from ordinary rejections", async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T | PromiseLike<T>) => void

      const promise = new Promise<T>((done) => {
        resolve = done
      })

      return { promise, resolve }
    }

    const message = "Configuration update failed"

    const scenarios: Array<{
      name: string
      code?: string
      plain?: boolean
      committed: boolean
    }> = [
      {
        name: "committed but unpublished",
        code: "CONFIG_COMMITTED_BUT_UNPUBLISHED",
        committed: true,
      },
      {
        name: "mandatory postpublication failure",
        code: "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
        committed: true,
      },
      {
        name: "ordinary uncoded HTTP 500",
        committed: false,
      },
      {
        name: "unknown error code",
        code: "CONFIG_COMMITTED_UNKNOWN",
        committed: false,
      },
      {
        name: "unrelated Error",
        plain: true,
        committed: false,
      },
    ]

    for (const scenario of scenarios) {
      const initialReady = deferred<void>()
      const rereadIssued = deferred<void>()
      const refreshedReady = deferred<void>()
      const reread = deferred<{ value: string; meta: string[] }>()
      const reported = deferred<void>()

      const failures: SettingWriteFailure[] = []
      let loads = 0
      let writes = 0

      const owner = createRoot((dispose) => {
        const setting = createOptimisticSetting({
          source: () => "server-a",
          initial: "",
          initialMeta: [] as string[],

          load: () => {
            loads += 1

            if (loads === 1) {
              return Promise.resolve({
                value: "/bin/bash",
                meta: [] as string[],
              })
            }

            rereadIssued.resolve(undefined)
            return reread.promise
          },

          write: () => {
            writes += 1

            if (scenario.plain) {
              return Promise.reject(new Error(message))
            }

            // Exercise the actual generated Promise SDK, rather than
            // manually constructing a write.failed machine event. `preconnect` rides along because the client types
            // this option as the whole global `fetch`, Bun's DNS extension included.
            const client = OpenCode.make({
              baseUrl: "http://localhost:3000",
              fetch: Object.assign(
                async () =>
                  Response.json(
                    {
                      _tag: "UnknownError",
                      message,
                      ...(scenario.code === undefined
                        ? {}
                        : { code: scenario.code }),
                    },
                    { status: 500 },
                  ),
                { preconnect: () => {} },
              ),
            })

            return client.experimental.config.update({
              shell: "/bin/zsh",
            })
          },

          onError: (failure) => {
            failures.push(failure)
            reported.resolve(undefined)
          },
        })

        createEffect(() => {
          if (setting.value() === "/bin/bash") {
            initialReady.resolve(undefined)
          }

          if (setting.value() === "/bin/fish") {
            refreshedReady.resolve(undefined)
          }
        })

        return { setting, dispose }
      })

      try {
        await initialReady.promise
        expect(owner.setting.value()).toBe("/bin/bash")

        owner.setting.select("/bin/zsh")
        await reported.promise

        // This observes the real controller's notify.error effect.
        expect(failures).toEqual([
          {
            kind: "failed",
            message,
            committed: scenario.committed,
          },
        ])

        expect(writes).toBe(1)

        if (scenario.committed) {
          // A committed PATCH must not roll back to the old value.
          await rereadIssued.promise

          expect(owner.setting.value()).toBe("/bin/zsh")
          expect(loads).toBe(2)

          // Only the authoritative re-read settles the display.
          reread.resolve({
            value: "/bin/fish",
            meta: [],
          })

          await refreshedReady.promise

          expect(owner.setting.value()).toBe("/bin/fish")
        } else {
          // An ordinary rejection retains existing rollback behavior.
          expect(owner.setting.value()).toBe("/bin/bash")
          expect(loads).toBe(1)
        }

        expect(writes).toBe(1)
        expect(failures).toHaveLength(1)
      } finally {
        owner.dispose()
      }
    }
  })
})
