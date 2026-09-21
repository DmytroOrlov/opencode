const disposers = new Set<(directory: string) => Promise<void>>()

export type DisposerOutcome =
  | { readonly index: number; readonly disposer: (directory: string) => Promise<void>; readonly status: "success" }
  | {
      readonly index: number
      readonly disposer: (directory: string) => Promise<void>
      readonly status: "failure"
      readonly error: unknown
    }

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  const snapshot = [...disposers]
  return Promise.all(
    snapshot.map(async (disposer, index): Promise<DisposerOutcome> => {
      try {
        await disposer(directory)
        return { index, disposer, status: "success" }
      } catch (error) {
        return { index, disposer, status: "failure", error }
      }
    }),
  )
}
