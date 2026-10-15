// Prism OS's wallpaper: layered glass dunes under a soft sky, in blues, teals and warm
// sand, drawn on its own canvas behind the program's weight arcs. It covers the whole
// desktop, so the system bar and the windows' glass blur it like a real wallpaper.
//
// The dunes drift slowly, so the canvas is redrawn at most every frameIntervalMs instead of
// at the display's rate. Under prefers-reduced-motion it's drawn once, and again only when
// the viewport or the color scheme changes. The palette follows the page's scheme: a day
// sky in the light scheme and a night sky in the dark one. The command center's settings
// can override both, see settings.ts: options.isDark decides the scheme, and
// options.isStill holds the dunes still like prefers-reduced-motion does. After a setting
// changes, the caller calls refresh().

const frameIntervalMs = 66
// How far a dune samples its curve, in px. Two sines sampled this often draw as a smooth line.
const sampleStep = 12

type Dune = {
  // The crest's middle as a fraction of the height, its swell in px at 1,000 px of height,
  // its wavelength as a fraction of the width, and how fast it drifts.
  y: number
  swell: number
  wavelength: number
  drift: number
  phase: number
  top: string
  bottom: string
  rim: string
}

type Palette = {
  sky: readonly [string, string, string]
  sun: string
  dunes: readonly Dune[]
}

const day: Palette = {
  sky: ['hsl(211 88% 34%)', 'hsl(203 90% 52%)', 'hsl(192 78% 74%)'],
  sun: 'hsl(42 100% 88% / 0.75)',
  dunes: [
    {y: 0.5, swell: 70, wavelength: 1.3, drift: 0.9, phase: 0.4, top: 'hsl(198 90% 64% / 0.75)', bottom: 'hsl(205 85% 46% / 0.9)', rim: 'hsl(190 100% 92% / 0.55)'},
    {y: 0.62, swell: 60, wavelength: 0.95, drift: -0.7, phase: 2.1, top: 'hsl(184 72% 58% / 0.8)', bottom: 'hsl(194 80% 38% / 0.95)', rim: 'hsl(180 100% 90% / 0.5)'},
    {y: 0.74, swell: 46, wavelength: 1.15, drift: 0.55, phase: 4.2, top: 'hsl(34 92% 80% / 0.92)', bottom: 'hsl(22 78% 62% / 0.95)', rim: 'hsl(40 100% 96% / 0.7)'},
    {y: 0.86, swell: 38, wavelength: 0.8, drift: -0.45, phase: 1.3, top: 'hsl(210 78% 40% / 0.95)', bottom: 'hsl(216 82% 22%)', rim: 'hsl(205 100% 85% / 0.45)'},
  ],
}

const night: Palette = {
  sky: ['hsl(222 62% 7%)', 'hsl(214 64% 15%)', 'hsl(204 58% 26%)'],
  sun: 'hsl(205 90% 70% / 0.22)',
  dunes: [
    {y: 0.5, swell: 70, wavelength: 1.3, drift: 0.9, phase: 0.4, top: 'hsl(206 70% 30% / 0.8)', bottom: 'hsl(214 70% 14% / 0.95)', rim: 'hsl(200 100% 75% / 0.35)'},
    {y: 0.62, swell: 60, wavelength: 0.95, drift: -0.7, phase: 2.1, top: 'hsl(190 64% 26% / 0.85)', bottom: 'hsl(200 70% 11% / 0.95)', rim: 'hsl(184 100% 70% / 0.3)'},
    {y: 0.74, swell: 46, wavelength: 1.15, drift: 0.55, phase: 4.2, top: 'hsl(198 55% 34% / 0.85)', bottom: 'hsl(206 60% 16% / 0.95)', rim: 'hsl(36 100% 80% / 0.4)'},
    {y: 0.86, swell: 38, wavelength: 0.8, drift: -0.45, phase: 1.3, top: 'hsl(214 60% 16% / 0.95)', bottom: 'hsl(222 60% 6%)', rim: 'hsl(205 100% 75% / 0.25)'},
  ],
}

export type WallpaperOptions = {
  isDark?: () => boolean
  isStill?: () => boolean
}

export function startWallpaper(canvas: HTMLCanvasElement, options: WallpaperOptions = {}) {
  const context = canvas.getContext('2d')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = options.isDark ?? (() => darkScheme.matches)
  const isStill = () => reducedMotion.matches || (options.isStill?.() ?? false)
  let width = 0
  let height = 0
  let pixelRatio = 1
  let running = true
  let frameRequest = 0
  let lastDrawMs = Number.NEGATIVE_INFINITY

  const crest = (dune: Dune, x: number, t: number) => {
    const k = (Math.PI * 2) / (dune.wavelength * Math.max(width, 1))
    const swell = dune.swell * (height / 1000)
    return height * dune.y
      + Math.sin(x * k + dune.phase + t * dune.drift) * swell
      + Math.sin(x * k * 2.3 - dune.phase * 1.7 - t * dune.drift * 0.6) * swell * 0.35
  }

  const draw = (timeMs: number) => {
    if (context === null || width <= 0 || height <= 0) return
    lastDrawMs = timeMs
    const palette = isDark() ? night : day
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
      context.moveTo(0, crest(dune, 0, t))
      for (let x = sampleStep; x < width + sampleStep; x += sampleStep) context.lineTo(x, crest(dune, x, t))
      context.lineTo(width + sampleStep, height)
      context.lineTo(0, height)
      context.closePath()
      context.fillStyle = fill
      context.fill()

      // The rim: a bright hairline along the crest, the glass edge that catches the light.
      context.beginPath()
      context.moveTo(0, crest(dune, 0, t))
      for (let x = sampleStep; x < width + sampleStep; x += sampleStep) context.lineTo(x, crest(dune, x, t))
      context.strokeStyle = dune.rim
      context.lineWidth = 1.25
      context.stroke()
    }
  }

  const frame = (timeMs: number) => {
    frameRequest = 0
    if (!running) return
    if (timeMs - lastDrawMs >= frameIntervalMs) draw(timeMs)
    if (!isStill()) frameRequest = requestAnimationFrame(frame)
  }

  const start = () => {
    if (running && frameRequest === 0) frameRequest = requestAnimationFrame(frame)
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
  darkScheme.addEventListener('change', redraw)

  return {
    refresh: redraw,
    stop() {
      running = false
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest)
      frameRequest = 0
      window.removeEventListener('resize', layout)
      reducedMotion.removeEventListener('change', start)
      darkScheme.removeEventListener('change', redraw)
    },
  }
}
