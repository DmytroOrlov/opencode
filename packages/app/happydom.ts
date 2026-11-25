import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { fileURLToPath } from "node:url"
import { plugin } from "bun"

GlobalRegistrator.register()

// `test:unit` passes `--conditions=solid`, a condition `solid-js@1.9.17` no longer publishes, so its exports fall through
// to the `node` entry: Solid's server build, whose `createEffect` is an empty function. A controller that drives its
// machine from an effect therefore never starts one in this env, so no driver here is reachable. Serve the client
// build the app ships (what `--conditions=browser` resolves) for the root specifier only: `solid-js/store` and
// `solid-js/web` keep their previous build, since swapping those changes `createStore` identity and breaks unrelated
// suites.
const solidClientBuilds: Record<string, string> = {
  "dist/server.js": fileURLToPath(import.meta.resolve("solid-js/dist/solid.js")),
}

plugin({
  name: "solid-client-build",
  setup(build) {
    build.onLoad({ filter: /solid-js[/\\]dist[\\/]server\.js$/ }, async (args) => {
      const client = solidClientBuilds[args.path.replace(/^.*solid-js[/\\]/, "")]
      return client ? { contents: await Bun.file(client).text(), loader: "js" } : undefined
    })
  },
})

const originalGetContext = HTMLCanvasElement.prototype.getContext

// @ts-expect-error - we're overriding with a simplified mock
HTMLCanvasElement.prototype.getContext = function (contextType: string, _options?: unknown) {
  if (contextType === "2d") {
    return {
      canvas: this,
      fillStyle: "#000000",
      strokeStyle: "#000000",
      font: "12px monospace",
      textAlign: "start",
      textBaseline: "alphabetic",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: true,
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      shadowBlur: 0,
      shadowColor: "rgba(0, 0, 0, 0)",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      arcTo: () => {},
      ellipse: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      isPointInPath: () => false,
      isPointInStroke: () => false,
      getTransform: () => ({}),
      getImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
      putImageData: () => {},
      createImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
    } as unknown as CanvasRenderingContext2D
  }

  return originalGetContext.call(this, contextType as "2d", _options)
}
