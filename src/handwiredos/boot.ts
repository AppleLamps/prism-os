// HandwiredOS's page script, see assets/index.html. window-manager.ts only exports the
// mount, so other pages can import it with their own options, e.g. Prism OS's boot.ts.
import {mountWindowManager} from './window-manager.ts'

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountWindowManager(document, window)
}
