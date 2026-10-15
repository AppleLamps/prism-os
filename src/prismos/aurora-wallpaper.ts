// Animated aurora behind Prism OS's weight arcs. Runs on its own canvas so the
// Handwired wiring picture can redraw only when the viewport rests.
import {wiringRectangle} from '../handwiredos/wiring.ts'

const systemBarFallback = 36

export function startAuroraWallpaper(canvas: HTMLCanvasElement, systemBarHeight = systemBarFallback) {
  let width = 0
  let height = 0
  let pixelRatio = 1
  let running = true

  const draw = (timeMs: number) => {
    if (!running) return
    const context = canvas.getContext('2d')
    if (context === null || width <= 0 || height <= 0) return

    const t = timeMs * 0.00015
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, width, height)

    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, `hsl(${220 + Math.sin(t) * 12}, 42%, 8%)`)
    gradient.addColorStop(0.45, `hsl(${265 + Math.cos(t * 1.3) * 18}, 55%, 14%)`)
    gradient.addColorStop(1, `hsl(${190 + Math.sin(t * 0.7) * 10}, 48%, 10%)`)
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)

    const bands = [
      {phase: 0, hue: 168, y: 0.22},
      {phase: 1.8, hue: 285, y: 0.48},
      {phase: 3.1, hue: 320, y: 0.72},
    ]
    for (const band of bands) {
      const centerY = height * band.y + Math.sin(t + band.phase) * height * 0.06
      const radius = Math.max(width, height) * (0.55 + Math.sin(t * 0.9 + band.phase) * 0.08)
      const glow = context.createRadialGradient(width * 0.35, centerY, 0, width * 0.5, centerY, radius)
      glow.addColorStop(0, `hsla(${band.hue}, 88%, 62%, 0.34)`)
      glow.addColorStop(0.55, `hsla(${band.hue + 24}, 70%, 45%, 0.12)`)
      glow.addColorStop(1, 'hsla(240, 40%, 12%, 0)')
      context.fillStyle = glow
      context.fillRect(0, 0, width, height)
    }

    context.globalAlpha = 0.08
    context.strokeStyle = '#e2e8f0'
    context.lineWidth = 1
    const grid = 48
    for (let x = 0; x <= width; x += grid) {
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, height)
      context.stroke()
    }
    for (let y = 0; y <= height; y += grid) {
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
    }
    context.globalAlpha = 1
  }

  const layout = (viewportWidth: number, viewportHeight: number) => {
    const rect = wiringRectangle(viewportWidth, viewportHeight, systemBarHeight)
    canvas.style.left = `${rect.left}px`
    canvas.style.top = `${rect.top}px`
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
    width = rect.width
    height = rect.height
    pixelRatio = Math.min(2, Math.sqrt(4_000_000 / Math.max(width * height, 1)))
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
  }

  const frame = (time: number) => {
    draw(time)
    if (running) requestAnimationFrame(frame)
  }

  const onResize = () => {
    layout(document.documentElement.clientWidth, document.documentElement.clientHeight)
  }

  layout(document.documentElement.clientWidth, document.documentElement.clientHeight)
  requestAnimationFrame(frame)
  window.addEventListener('resize', onResize)

  return {
    stop() {
      running = false
      window.removeEventListener('resize', onResize)
    },
    setSystemBarHeight(value: number) {
      systemBarHeight = value
      onResize()
    },
  }
}
