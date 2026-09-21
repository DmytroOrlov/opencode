import { describe, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"

;(globalThis as typeof globalThis & { React?: { createElement: (component: (props: unknown) => unknown, props: unknown) => unknown } }).React = {
  createElement: (component, props, ...children: unknown[]) => {
    if (props && children.length > 0) (props as { children?: unknown }).children = children.length === 1 ? children[0] : children
    if (typeof component === "function") return component(props)
    const element = document.createElement(component)
    const ref = (props as { ref?: (element: HTMLElement) => void } | null)?.ref
    if (ref) ref(element)
    return element
  },
}

const fragmentElement = (props: { children?: unknown }) => props?.children ?? null
const fragments = globalThis as typeof globalThis & Record<string, typeof fragmentElement>
fragments.Fragment_8vg9x3sq ??= fragmentElement

const primary = { id: "primary", name: "primary", provider: { id: "provider", name: "provider" } }
const fallback = { id: "fallback", name: "fallback", provider: { id: "provider", name: "provider" } }

let paidSelector: { items?: () => unknown[]; onSelect?: (item: unknown) => unknown } | undefined
let unpaidDialog: { onSelect?: (item: unknown) => unknown } | undefined
let variantSelect: { onSelect?: (value: string) => unknown } | undefined
let modelButton: { onClick?: () => unknown } | undefined
const legacyCapture = globalThis as typeof globalThis & {
  __legacyPaidSelector?: typeof paidSelector
  __legacyUnpaidDialog?: typeof unpaidDialog
}

const noop = () => null

let fallbackPopoverV2: { trigger?: (triggerProps: unknown) => unknown } | undefined
let modelTriggers: { disabled?: boolean; dataAction?: string; dataControlType?: string; modelName?: string }[] = []

mock.module("@/components/dialog-select-model", () => ({
  ModelSelectorPopover: (props: typeof paidSelector) => {
    paidSelector = props ?? undefined
    legacyCapture.__legacyPaidSelector = paidSelector
    return null
  },
  ModelSelectorPopoverV2: (props: typeof fallbackPopoverV2) => {
    fallbackPopoverV2 = props ?? undefined
    props?.trigger?.({})
    return null
  },
  ModelSelectorTriggerV2: (props: { disabled?: boolean; dataAction?: string; dataControlType?: string; modelName?: string }) => {
    modelTriggers.push(props)
    return null
  },
  DialogSelectModel: noop,
}))
mock.module("@/components/dialog-select-model-unpaid", () => ({
  DialogSelectModelUnpaid: (props: typeof unpaidDialog) => {
    unpaidDialog = props ?? undefined
    legacyCapture.__legacyUnpaidDialog = unpaidDialog
    return null
  },
}))
mock.module("@/components/dialog-select-model-unpaid-v2", () => ({ DialogSelectModelUnpaidV2: noop }))
mock.module("@/context/file", () => ({
  selectionFromLines: () => undefined,
  useFile: () => ({
    pathFromTab: (tab: string) => tab,
    tab: (path: string) => path,
    load: async () => {},
    searchFilesAndDirectories: async () => [],
  }),
}))
mock.module("@/context/layout", () => ({
  useLayout: () => ({
    fileTree: { setTab: () => {} },
  }),
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/repo" }) }))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    data: {
      session_diff: {},
      session_working: () => false,
      message: {},
      reference: [],
      mcp_resource: {},
      command: [],
    },
    session: { get: () => undefined },
  }),
}))
mock.module("@/context/comments", () => ({
  useComments: () => ({
    all: () => [],
    setActive: () => {},
    setFocus: () => {},
    focus: () => undefined,
    replace: () => {},
  }),
}))
mock.module("@/context/command", () => ({
  useCommand: () => ({
    register: () => {},
    options: [],
    keybind: () => undefined,
    keybindParts: () => [],
    trigger: () => {},
  }),
}))
mock.module("@/context/permission", () => ({
  usePermission: () => ({ isAutoAcceptingDirectory: () => false, isAutoAccepting: () => false }),
}))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", os: "linux", openAttachmentPickerDialog: async () => {} }),
}))
mock.module("@/context/prompt", () => ({
  DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
  isCommentItem: () => false,
  isPromptEqual: () => true,
  usePrompt: () => ({
    ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
    current: () => [],
    cursor: () => 0,
    dirty: () => false,
    context: { items: () => [], replaceComments: () => {} },
    capture: () => ({ current: () => [] }),
    set: () => {},
  }),
}))
mock.module("@/components/prompt-input/editor-dom", () => ({
  createTextFragment: () => document.createTextNode(""),
  getCursorPosition: () => 0,
  setCursorPosition: () => {},
  setRangeEdge: () => {},
}))
mock.module("@/components/prompt-input/attachments", () => ({ createPromptAttachments: () => ({}) }))
mock.module("@/components/prompt-input/files", () => ({
  ACCEPTED_FILE_TYPES: [],
  pickAttachmentFiles: () => {},
}))
mock.module("@/components/prompt-input/history", () => ({
  canNavigateHistoryAtCursor: () => false,
  navigatePromptHistory: () => undefined,
  normalizePromptHistoryEntry: (entry: unknown) => entry,
  promptLength: () => 0,
}))
mock.module("@/components/prompt-input/history-store", () => ({
  createPersistedPromptInputHistory: () => ({}),
  createPromptInputHistory: () => ({}),
}))
mock.module("@/components/prompt-input/submit", () => ({
  createPromptSubmit: () => ({ abort: async () => {}, handleSubmit: async () => {} }),
}))
mock.module("@/components/prompt-input/slash-popover", () => ({ PromptPopover: noop }))
mock.module("@/components/prompt-input/context-items", () => ({ PromptContextItems: noop }))
mock.module("@/components/prompt-input/image-attachments", () => ({ PromptImageAttachments: noop }))
mock.module("@/components/prompt-input/drag-overlay", () => ({ PromptDragOverlay: noop }))
mock.module("@/components/prompt-input/placeholder", () => ({
  promptDesignPlaceholder: () => "placeholder",
  promptPlaceholder: () => "placeholder",
}))
mock.module("@/components/prompt-input/transient-state", () => ({
  createPromptInputTransientState: () => [
    { mode: "normal", placeholder: 0, popover: null, slashMenu: false, slashMenuQuery: "", historyIndex: -1, applyingHistory: false },
    () => {},
  ],
}))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: { "data-action"?: string; onClick?: () => unknown }) => {
    if (props["data-action"] === "prompt-model") modelButton = props
    return null
  },
}))
mock.module("@opencode-ai/ui/dock-surface", () => ({ DockShellForm: noop, DockTray: noop }))
mock.module("@opencode-ai/ui/icon", () => ({ Icon: noop }))
mock.module("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: noop }))
mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: noop, TooltipKeybind: noop }))
mock.module("@opencode-ai/ui/v2/button-v2", () => ({ ButtonV2: noop }))
mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: noop }))
mock.module("@opencode-ai/ui/v2/icon-button-v2", () => ({ IconButtonV2: noop }))
mock.module("@opencode-ai/ui/v2/keybind-v2", () => ({ KeybindV2: noop }))
mock.module("@opencode-ai/ui/v2/menu-v2", () => ({ MenuV2: noop }))
mock.module("@opencode-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: noop }))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: noop }))
mock.module("@opencode-ai/ui/select", () => ({
  Select: (props: { triggerProps?: { "data-action"?: string }; onSelect?: (value: string) => unknown }) => {
    if (props.triggerProps?.["data-action"] === "prompt-model-variant") variantSelect = props
    return null
  },
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: async (render: () => unknown) => render(),
  }),
}))
mock.module("@opencode-ai/ui/image-preview", () => ({ ImagePreview: noop }))
mock.module("@/pages/session/helpers", () => ({
  createSessionTabs: () => ({ activeFileTab: () => undefined }),
}))
mock.module("@/utils/model-fallback", () => ({}))
let fallbackVariantControl: { disabled?: boolean; onSelect?: (id: string) => unknown } | undefined
mock.module("@opencode-ai/session-ui/v2/prompt-input", () => ({
  PromptInputV2: noop,
  PromptInputV2Select: (props: { disabled?: boolean; onSelect?: (id: string) => unknown }) => {
    fallbackVariantControl = props
    return null
  },
}))

const selection = {
  current: () => primary,
  variant: {
    list: () => ["high", "low"],
    current: () => "high",
  },
}

const controls = (paid: boolean, pair: { primaryModels: () => unknown[]; selectPrimary: (item: unknown) => unknown; selectVariant: (value: string | undefined) => unknown }) => ({
  agents: { available: [], options: [], current: "build", loading: false, visible: true, select: () => {} },
  model: { selection, pair, paid, loading: false },
  session: {
    id: "session",
    tabs: { active: () => undefined, all: () => [], open: async () => {}, setActive: () => {} },
    reviewPanel: { opened: () => false, open: () => {} },
  },
})

describe("legacy PromptInput model-pair seam", () => {
  test("paid primary and variant controls use the supplied pair authority", async () => {
    const primaryModels = () => [primary, fallback]
    let selected: unknown
    let selectedVariant: string | undefined
    const pair = {
      primaryModels,
      selectPrimary: (item: unknown) => {
        selected = item
      },
      selectVariant: (value: string | undefined) => {
        selectedVariant = value
      },
    }
    const { PromptInput } = await import("@/components/prompt-input")

    await createRoot(async (dispose) => {
      const mounted = document.createElement("div")
      document.body.append(mounted)
      const unmount = render(() => createComponent(PromptInput, { controls: controls(true, pair) }), mounted)
      await Promise.resolve()
      const paid = paidSelector ?? legacyCapture.__legacyPaidSelector
      expect(paid?.items).toBe(primaryModels)
      expect(paid?.onSelect).toBe(pair.selectPrimary)
      paid?.onSelect?.(fallback)
      variantSelect?.onSelect?.("low")
      expect(selected).toBe(fallback)
      expect(selectedVariant).toBe("low")
      unmount()
      mounted.remove()
      dispose()
    })
  })

  test("unpaid primary uses the same pair callback and never direct selection.set", async () => {
    let directSet = 0
    let selected: unknown
    const pair = {
      primaryModels: () => [primary, fallback],
      selectPrimary: (item: unknown) => {
        selected = item
      },
      selectVariant: () => {},
    }
    const unpaidSelection = { ...selection, set: () => directSet++ }
    const { PromptInput } = await import("@/components/prompt-input")

    await createRoot(async (dispose) => {
      const mounted = document.createElement("div")
      document.body.append(mounted)
      const unmount = render(
        () => createComponent(PromptInput, { controls: { ...controls(false, pair), model: { ...controls(false, pair).model, selection: unpaidSelection } } }),
        mounted,
      )
      await Promise.resolve()
      modelButton?.onClick?.()
      const unpaid = unpaidDialog ?? legacyCapture.__legacyUnpaidDialog
      unpaid?.onSelect?.(fallback)
      expect(selected).toBe(fallback)
      expect(directSet).toBe(0)
      unmount()
      mounted.remove()
      dispose()
    })
  })
})

type ComposerPair = {
  primaryModels: () => unknown[]
  fallbackModels: () => unknown[]
  fallback: {
    displayed: () => { model: string; variant: string | null } | null
    selected: () => unknown
    variants: () => string[]
  }
  selectPrimary: (item: unknown) => void
  selectFallback: (item: unknown) => void
  selectFallbackVariant: (variant: string) => void
  selectVariant: (variant: string | undefined) => void
  cycleVariant: () => void
  swap: () => void
}

const composerPair = (): ComposerPair => ({
  primaryModels: () => [primary, fallback],
  fallbackModels: () => [fallback, primary],
  fallback: {
    displayed: () => ({ model: "provider/fallback", variant: "low" }),
    selected: () => fallback,
    variants: () => ["high", "low"],
  },
  selectPrimary: () => {},
  selectFallback: () => {},
  selectFallbackVariant: () => {},
  selectVariant: () => {},
  cycleVariant: () => {},
  swap: () => {},
})

const renderComposer = async (pair: ComposerPair) => {
  const { PromptInputV2Composer } = await import("@/components/prompt-input-v2")
  const controller = {
    model: { selection, pair, paid: true, loading: false },
    restoreFocus: () => {},
  }
  const mounted = document.createElement("div")
  document.body.append(mounted)
  const unmount = render(() => createComponent(PromptInputV2Composer, { controller }), mounted)
  await Promise.resolve()
  return {
    fallbackTrigger: () => modelTriggers.find((props) => props.dataAction === "prompt-fallback-model"),
    fallbackVariant: () => fallbackVariantControl,
    cleanup: () => {
      unmount()
      mounted.remove()
    },
  }
}

describe("V2 composer fallback controls", () => {
  test("fallback trigger has no busy-session disabled state", async () => {
    modelTriggers = []
    fallbackVariantControl = undefined
    const composer = await renderComposer(composerPair())

    expect(composer.fallbackTrigger()).toBeDefined()
    expect(composer.fallbackTrigger()?.disabled).toBeFalsy()
    expect(composer.fallbackTrigger()?.modelName).toBe("fallback")
    expect(composer.fallbackVariant()?.disabled).toBe(false)
    composer.cleanup()
  })

  test("disable fallback variant only when its model is unavailable", async () => {
    modelTriggers = []
    fallbackVariantControl = undefined
    const pair = composerPair()
    pair.fallback.displayed = () => null
    const composer = await renderComposer(pair)

    expect(composer.fallbackTrigger()?.disabled).toBeFalsy()
    expect(composer.fallbackVariant()?.disabled).toBe(true)
    composer.cleanup()
  })
})
