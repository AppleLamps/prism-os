// The window layout from lab/ui-exploration/input/fixtures.ts, plus the lifted
// double click distance. At the authored values the double click distance
// equals the slop, which is what input's circuit reads for both.

import type {WindowsConfig} from './windows.ts'

// Window 0 starts at the top of the workspace, so its title bar sits under the
// same pointer position whether or not it is maximized. Window 1 overlaps
// window 0 and starts in front of it.
export const testWindowsConfig: WindowsConfig = {
  workspace: {left: 0, top: 0, width: 1280, height: 800},
  windows: [
    {width: 420, height: 300, initialLeft: 80, initialTop: 0},
    {width: 360, height: 260, initialLeft: 380, initialTop: 180},
    {width: 300, height: 220, initialLeft: 760, initialTop: 420},
    {width: 340, height: 240, initialLeft: 200, initialTop: 470},
  ],
  titleHeight: 28,
  buttonWidth: 28,
  slop: 4,
  doubleClickInterval: 500,
  doubleClickDistance: 4,
}

export type BehaviorSetting = {slop: number, doubleClickInterval: number, doubleClickDistance: number}

export const authoredBehavior: BehaviorSetting = {slop: 4, doubleClickInterval: 500, doubleClickDistance: 4}

export function withBehavior(config: WindowsConfig, behavior: BehaviorSetting): WindowsConfig {
  return {...config, ...behavior}
}
