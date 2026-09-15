// A deterministic 400-frame session over the initial layout at 1280×800, used
// for timings and as a named check that every feature takes effect:
// - frame 5: drag Files by its title bar over Notes, released at frame 31
// - frame 60: click Notes' title bar, raising Notes over Files
// - frame 90: drag Photos by its title bar over Notes, released at frame 111
// - frame 140: maximize Photos; frame 170: click photo 5 in the grid
// - frames 185, 200, 215, 230: ArrowRight, ArrowRight, ArrowLeft, Escape
// - frame 250: restore Photos; frame 280: minimize Photos
// - frame 310: resize Notes by its grip, released at frame 331
// - frame 360: reopen Photos from its dock item
import type {QueuedEvent} from './events.ts'

export const sessionViewport = {width: 1280, height: 800}
export const sessionFrameCount = 400
export const sessionFrameTime = (frame: number) => 1000 + frame * 16.6875

export function sessionEvents(frame: number): QueuedEvent[] {
  const click = (x: number, y: number): QueuedEvent[] => [{kind: 'down', x, y}, {kind: 'up', x, y}]
  if (frame === 5) return [{kind: 'down', x: 100, y: 70}]
  if (frame > 5 && frame <= 30) return [{kind: 'move', x: 100 + (frame - 5) * 12, y: 70 + (frame - 5) * 4}]
  if (frame === 31) return [{kind: 'up', x: 400, y: 170}]
  if (frame === 60) return click(600, 120)
  if (frame === 90) return [{kind: 'down', x: 1000, y: 210}]
  if (frame > 90 && frame <= 110) return [{kind: 'move', x: 1000 - (frame - 90) * 15, y: 210 + (frame - 90) * 5}]
  if (frame === 111) return [{kind: 'up', x: 700, y: 310}]
  if (frame === 140) return click(863, 312)
  if (frame === 170) return click(485, 402)
  if (frame === 185 || frame === 200) return [{kind: 'key', key: 'ArrowRight'}]
  if (frame === 215) return [{kind: 'key', key: 'ArrowLeft'}]
  if (frame === 230) return [{kind: 'key', key: 'Escape'}]
  if (frame === 250) return click(1221, 70)
  if (frame === 280) return click(835, 312)
  if (frame === 310) return [{kind: 'down', x: 898, y: 458}]
  if (frame > 310 && frame <= 330) return [{kind: 'move', x: 898 + (frame - 310) * 5, y: 458 + (frame - 310) * 3}]
  if (frame === 331) return [{kind: 'up', x: 998, y: 518}]
  if (frame === 360) return click(733, 762)
  return []
}
