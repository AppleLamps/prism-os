// Prism OS's wallpaper: layered glass dunes under a soft sky, drawn on its own canvas
// behind the program's weight arcs. It covers the whole desktop, so the system bar and the
// windows' glass blur it like a real wallpaper.
//
// A scene is four dunes and a sky, as hues and saturations. The lightness of each layer
// comes from the scheme, so every scene has a day and a night version. The dunes drift
// slowly, so the canvas is redrawn at most every frameIntervalMs instead of at the
// display's rate. With motion off or under prefers-reduced-motion, the wallpaper is drawn
// once, and again only when the viewport, the scheme or the scene changes.
import type {SceneName} from './settings.ts'

const frameIntervalMs = 66
// How far a dune samples its curve, in px. Two sines sampled this often draw as a smooth line.
const sampleStep = 12

type Hue = readonly [hue: number, saturation: number]

type Scene = {
  sky: readonly [Hue, Hue, Hue]
  sun: Hue
  // Back to front. A dune can take another hue at night, e.g. sand that would turn brown.
  dunes: readonly [Hue, Hue, Hue, Hue]
  nightDunes?: Partial<Record<0 | 1 | 2 | 3, Hue>>
}

const sceneHues: Readonly<Record<SceneName, Scene>> = {
  dunes: {
    sky: [[211, 88], [203, 90], [192, 78]],
    sun: [42, 100],
    dunes: [[200, 88], [188, 76], [30, 88], [212, 80]],
    nightDunes: {2: [198, 55]},
  },
  lagoon: {
    sky: [[196, 80], [186, 72], [168, 58]],
    sun: [52, 100],
    dunes: [[178, 62], [160, 52], [44, 70], [190, 72]],
    nightDunes: {2: [176, 40]},
  },
  ember: {
    sky: [[12, 78], [24, 88], [38, 92]],
    sun: [46, 100],
    dunes: [[22, 86], [8, 72], [36, 90], [208, 62]],
    nightDunes: {0: [210, 45], 1: [200, 40], 2: [24, 45]},
  },
  graphite: {
    sky: [[214, 14], [212, 12], [208, 10]],
    sun: [40, 30],
    dunes: [[210, 10], [205, 12], [32, 18], [220, 14]],
  },
}

// Lightness of the sky's three stops, and of each dune's top, bottom and rim, by scheme.
const lightness = {
  light: {sky: [34, 52, 74], sun: 88, top: [64, 58, 80, 40], bottom: [46, 38, 62, 22], rim: [92, 90, 96, 85]},
  dark: {sky: [7, 15, 26], sun: 70, top: [30, 26, 34, 16], bottom: [14, 11, 16, 6], rim: [75, 70, 80, 75]},
} as const

type Dune = {y: number, swell: number, wavelength: number, drift: number, phase: number, top: string, bottom: string, rim: string}
type Palette = {sky: readonly [string, string, string], sun: string, dunes: readonly Dune[]}

// The shapes of the four dunes: where the crest lies as a fraction of the height, its swell
// in px at 1,000 px of height, its wavelength as a fraction of the width, and its drift.
const shapes = [
  {y: 0.5, swell: 70, wavelength: 1.3, drift: 0.9, phase: 0.4, alpha: [0.75, 0.9, 0.55]},
  {y: 0.62, swell: 60, wavelength: 0.95, drift: -0.7, phase: 2.1, alpha: [0.8, 0.95, 0.5]},
  {y: 0.74, swell: 46, wavelength: 1.15, drift: 0.55, phase: 4.2, alpha: [0.92, 0.95, 0.7]},
  {y: 0.86, swell: 38, wavelength: 0.8, drift: -0.45, phase: 1.3, alpha: [0.95, 1, 0.45]},
] as const

export function wallpaperPalette(sceneName: SceneName, scheme: 'light' | 'dark'): Palette {
  const scene = sceneHues[sceneName]
  const levels = lightness[scheme]
  const hsl = ([hue, saturation]: Hue, light: number, alpha = 1) => `hsl(${hue} ${saturation}% ${light}% / ${alpha})`
  return {
    sky: [hsl(scene.sky[0], levels.sky[0]), hsl(scene.sky[1], levels.sky[1]), hsl(scene.sky[2], levels.sky[2])],
    sun: hsl(scene.sun, levels.sun, scheme === 'light' ? 0.75 : 0.22),
    dunes: shapes.map((shape, index) => {
      const layer = index as 0 | 1 | 2 | 3
      const hue = scheme === 'dark' ? scene.nightDunes?.[layer] ?? scene.dunes[layer] : scene.dunes[layer]
      const rimHue: Hue = [hue[0] + 6, Math.min(100, hue[1] + 20)]
      return {
        y: shape.y,
        swell: shape.swell,
        wavelength: shape.wavelength,
        drift: shape.drift,
        phase: shape.phase,
        top: hsl(hue, levels.top[layer], shape.alpha[0]),
        bottom: hsl([hue[0] + 6, hue[1]], levels.bottom[layer], shape.alpha[1]),
        rim: hsl(rimHue, levels.rim[layer], scheme === 'light' ? shape.alpha[2] : shape.alpha[2] * 0.6),
      }
    }),
  }
}

export type WallpaperOptions = {scene: SceneName, scheme: 'light' | 'dark', motion: boolean}

export function startWallpaper(canvas: HTMLCanvasElement, initial: WallpaperOptions) {
  const context = canvas.getContext('2d')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let options = initial
  let palette = wallpaperPalette(options.scene, options.scheme)
  let width = 0
  let height = 0
  let pixelRatio = 1
  let frameRequest = 0
  let lastDrawMs = Number.NEGATIVE_INFINITY

  const crest = (dune: Dune, x: number, t: number) => {
    const k = (Math.PI * 2) / (dune.wavelength * Math.max(width, 1))
    const swell = dune.swell * (height / 1000)
    return height * dune.y
      + Math.sin(x * k + dune.phase + t * dune.drift) * swell
      + Math.sin(x * k * 2.3 - dune.phase * 1.7 - t * dune.drift * 0.6) * swell * 0.35
  }

  const traceCrest = (dune: Dune, t: number) => {
    if (context === null) return
    context.moveTo(0, crest(dune, 0, t))
    for (let x = sampleStep; x < width + sampleStep; x += sampleStep) context.lineTo(x, crest(dune, x, t))
  }

  const draw = (timeMs: number) => {
    if (context === null || width <= 0 || height <= 0) return
    lastDrawMs = timeMs
    const t = timeMs * 0.0001

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    const sky = context.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, palette.sky[0])
    sky.addColorStop(0.45, palette.sky[1])
    sky.addColorStop(0.75, palette.sky[2])
    context.fillStyle = sky
    context.fillRect(0, 0, width, height)

    // A soft sun, high on the right, that the dunes catch on their rims.
    const sunX = width * (0.74 + Math.sin(t * 0.8) * 0.03)
    const sunY = height * 0.3
    const sun = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, Math.max(width, height) * 0.45)
    sun.addColorStop(0, palette.sun)
    sun.addColorStop(1, 'hsl(0 0% 100% / 0)')
    context.fillStyle = sun
    context.fillRect(0, 0, width, height)

    for (const dune of palette.dunes) {
      const top = height * dune.y - dune.swell * (height / 1000) * 1.35
      const fill = context.createLinearGradient(0, top, 0, height)
      fill.addColorStop(0, dune.top)
      fill.addColorStop(1, dune.bottom)
      context.beginPath()
      traceCrest(dune, t)
      context.lineTo(width + sampleStep, height)
      context.lineTo(0, height)
      context.closePath()
      context.fillStyle = fill
      context.fill()

      // The rim: a bright hairline along the crest, the glass edge that catches the light.
      context.beginPath()
      traceCrest(dune, t)
      context.strokeStyle = dune.rim
      context.lineWidth = 1.25
      context.stroke()
    }
  }

  const animates = () => options.motion && !reducedMotion.matches

  const frame = (timeMs: number) => {
    frameRequest = 0
    if (timeMs - lastDrawMs >= frameIntervalMs) draw(timeMs)
    if (animates()) frameRequest = requestAnimationFrame(frame)
  }

  const start = () => {
    if (animates() && frameRequest === 0) frameRequest = requestAnimationFrame(frame)
  }

  // Draws now rather than at the next frame, so the page's first paint has the wallpaper.
  const redraw = () => {
    draw(performance.now())
    start()
  }

  const layout = () => {
    width = document.documentElement.clientWidth
    height = document.documentElement.clientHeight
    pixelRatio = Math.min(window.devicePixelRatio, 2, Math.sqrt(6_000_000 / Math.max(width * height, 1)))
    // Resizing clears the canvas, so it's redrawn at once.
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
    redraw()
  }

  layout()
  window.addEventListener('resize', layout)
  reducedMotion.addEventListener('change', start)

  return {
    set(change: Partial<WallpaperOptions>) {
      options = {...options, ...change}
      palette = wallpaperPalette(options.scene, options.scheme)
      redraw()
    },
  }
}
