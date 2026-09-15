// Settings panel demo. Run with: bun lab/ui-exploration/notation/demo.html
// All logic lives in settings-panel.ts (the circuit) and settings-dom.ts (the host).
import {mountSettings} from './settings-dom.ts'

if (typeof document !== 'undefined' && typeof window !== 'undefined') mountSettings(document, window)
