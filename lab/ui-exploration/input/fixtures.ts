// Shared fixtures for tests, report.ts, and the demo.

import type {Rectangle, WindowsConfig} from './windows.ts'

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
}

// Twelve controls: a toolbar row of four, a 3 x 2 grid, and two wide buttons
// of different widths, so arrow navigation has real choices to make.
export const testControlRectangles: Rectangle[] = [
  {left: 20, top: 20, width: 80, height: 32},
  {left: 110, top: 20, width: 80, height: 32},
  {left: 200, top: 20, width: 120, height: 32},
  {left: 330, top: 20, width: 60, height: 32},
  {left: 20, top: 80, width: 110, height: 60},
  {left: 140, top: 80, width: 110, height: 60},
  {left: 260, top: 80, width: 110, height: 60},
  {left: 20, top: 150, width: 110, height: 60},
  {left: 140, top: 150, width: 110, height: 60},
  {left: 260, top: 150, width: 110, height: 60},
  {left: 20, top: 230, width: 200, height: 40},
  {left: 230, top: 230, width: 140, height: 40},
]
