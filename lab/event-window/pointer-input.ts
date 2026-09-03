import type {PointerEventKind} from './oracle.ts'

export type RawPointerInput = {kind: PointerEventKind, clientX: number, clientY: number}

export function appendPointerMoves(
  pending: RawPointerInput[],
  samples: readonly {clientX: number, clientY: number}[],
) {
  // Returning to the press point must not erase an earlier drag-threshold crossing.
  for (const sample of samples) {
    pending.push({kind: 'move', clientX: sample.clientX, clientY: sample.clientY})
  }
}
