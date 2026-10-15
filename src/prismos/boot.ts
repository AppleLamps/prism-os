import {mountWindowManager} from '../handwiredos/window-manager.ts'
import {arrangePrismWindows} from './arrangement.ts'
import {startWallpaper} from './wallpaper.ts'

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const wallpaper = document.querySelector<HTMLCanvasElement>('.desk-wallpaper')
  if (wallpaper !== null) startWallpaper(wallpaper)
  mountWindowManager(document, window, {arrange: arrangePrismWindows})
}
