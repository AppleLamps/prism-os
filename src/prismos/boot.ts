import {mountWindowManager} from '../handwiredos/window-manager.ts'
import {arrangePrismWindows} from './arrangement.ts'
import {startAuroraWallpaper} from './aurora-wallpaper.ts'

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountWindowManager(document, window, {arrange: arrangePrismWindows})
  const auroraCanvas = document.querySelector<HTMLCanvasElement>('.desk-aurora')
  if (auroraCanvas !== null) {
    const desktop = document.querySelector<HTMLElement>('#desktop')
    const heightText = desktop?.style.getPropertyValue('--system-bar-height') ?? '36px'
    const systemBarHeight = heightText.endsWith('px') ? Number.parseFloat(heightText) : 36
    startAuroraWallpaper(auroraCanvas, systemBarHeight)
  }
}
