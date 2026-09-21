// Test-only provider module loaded through the dynamic file:// SDK path in
// resolveSDK. The factory records the exact options the backend forwards to a
// provider SDK constructor so tests can assert OpenCode-only control options
// (e.g. mlxTelemetry) are stripped while real connection options survive.
export function createCaptureProvider(options: Record<string, any>) {
  ;(globalThis as any).__capturedProviderSDKOptions = options
  return {
    specificationVersion: "v3",
    languageModel: (_modelID: string) => ({
      specificationVersion: "v3",
      provider: options?.name ?? "capture",
      modelId: _modelID,
      defaultMaxOutputTokens: 100,
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("capture provider does not generate")
      },
      doStream: async () => {
        throw new Error("capture provider does not stream")
      },
    }),
  }
}
