import {readFile} from 'node:fs/promises'
import {
  dockOutputField,
  photoSourceField,
  sourceField,
  windowCount,
  windowOutputField,
  createWindowManagerMachine,
} from './window-manager.ts'
import {
  controlField,
  itemCount as photoCount,
  photoField,
  thumbnailField,
} from './photo-gallery.ts'

const root = new URL('.', import.meta.url)
const machine = createWindowManagerMachine()
const program = machine.tensorProgram
const html = await readFile(new URL('index.html', root), 'utf8')
let css = await readFile(new URL('window-manager.css', root), 'utf8')

for (let photo = 0; photo < photoCount; photo++) {
  const suffix = String(photo).padStart(2, '0')
  const bytes = await Bun.file(new URL(`photo-gallery-${suffix}.webp`, root)).arrayBuffer()
  const dataUrl = `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`
  css = css.replace(
    `url("./photo-gallery-${suffix}.webp")`,
    `url("${dataUrl}")`,
  )
}

const stats = program.layers.reduce(
  (totals, layer) => {
    totals.weights += layer.weights.length
    totals.biases += layer.bias.length
    totals.indices +=
      layer.inputIndices.length
      + layer.gateRows.length
      + layer.booleanRows.length
      + layer.rowOffsets.length
      + layer.columns.length
    return totals
  },
  {weights: 0, biases: 0, indices: 0},
)

const data = {
  program,
  output: machine.output,
  source: machine.source,
  sourceField,
  photoSourceField,
  windowOutputField,
  dockOutputField,
  photoField,
  thumbnailField,
  controlField,
  windowCount,
  photoCount,
  stats,
}

const runtime = `(() => {
  'use strict'

  // The circuit compiler is absent from this file. These are its final tensors.
  const DATA = ${serialize(data)}
  const {
    program,
    output,
    source,
    sourceField,
    photoSourceField,
    windowOutputField,
    dockOutputField,
    photoField,
    thumbnailField,
    controlField,
    windowCount,
    photoCount,
    stats,
  } = DATA
  const photoNames = [
    'Misty Lake',
    'Desert Light',
    'Pacific Edge',
    'Midnight City',
    'Forest Path',
    'Alpine Dawn',
    'Amalfi Morning',
    'North Falls',
    'Lavender Hour',
    'Concrete Curve',
    'Blue Lagoon',
    'Autumn Road',
  ]

  function invariant(condition, message) {
    if (condition !== true) throw new Error(message)
  }

  function evaluateBoolean(value) {
    const base = 8388609
    const shifted = Math.fround(Math.fround(value) + base)
    return Math.fround(shifted - base)
  }

  function evaluate() {
    const packedValues = new Float32Array(program.valueCount)
    let maximumProjectionSize = 0
    let maximumInputSize = 0
    for (const layer of program.layers) {
      maximumProjectionSize = Math.max(maximumProjectionSize, layer.bias.length)
      maximumInputSize = Math.max(maximumInputSize, layer.inputSize)
    }
    const input = new Float32Array(maximumInputSize)
    const projection = new Float32Array(maximumProjectionSize)
    packedValues.set(source)
    let availableValues = source.length

    for (const layer of program.layers) {
      for (let column = 0; column < layer.inputSize; column++) {
        input[column] = packedValues[layer.inputIndices[column]]
      }
      for (let row = 0; row < layer.bias.length; row++) {
        let value = layer.bias[row]
        for (
          let index = layer.rowOffsets[row];
          index < layer.rowOffsets[row + 1];
          index++
        ) {
          const product = Math.fround(
            layer.weights[index] * input[layer.columns[index]],
          )
          value = Math.fround(value + product)
        }
        projection[row] = value
      }
      for (let gate = 0; gate < layer.gateRows.length; gate++) {
        const outputRow = layer.gateRows[gate]
        projection[outputRow] = Math.fround(
          projection[outputRow]
            * Math.max(0, projection[layer.outputSize + gate]),
        )
      }
      for (const outputRow of layer.booleanRows) {
        projection[outputRow] = evaluateBoolean(projection[outputRow])
      }
      packedValues.set(
        projection.subarray(0, layer.outputSize),
        availableValues,
      )
      availableValues += layer.outputSize
    }

    const values = new Float32Array(program.width)
    for (let packedIndex = 0; packedIndex < program.wireOrder.length; packedIndex++) {
      values[program.wireOrder[packedIndex]] = packedValues[packedIndex]
    }
    return values
  }

  function receivePointer(activeField, xField, yField, x, y) {
    source[activeField] = 1
    source[xField] = x
    source[yField] = y
  }

  function receivePhotoEvent(field, x, y) {
    source[photoSourceField.clickActive] = 0
    source[photoSourceField.previousActive] = 0
    source[photoSourceField.nextActive] = 0
    source[photoSourceField.closeActive] = 0
    source[field] = 1
    source[photoSourceField.clickX] =
      x === undefined ? source[photoSourceField.clickX] : x
    source[photoSourceField.clickY] =
      y === undefined ? source[photoSourceField.clickY] : y
  }

  const desktop = document.querySelector('#desktop')
  const windows = Array.from(document.querySelectorAll('.window'))
  const dockItems = Array.from(document.querySelectorAll('.dock-item'))
  const photosViewport = document.querySelector('.photos-content')
  const monitorValues = document.querySelector('#monitor-values')
  const monitorOperations = document.querySelector('#monitor-operations')
  const monitorLayers = document.querySelector('#monitor-layers')
  const monitorWeights = document.querySelector('#monitor-weights')
  const monitorMemory = document.querySelector('#monitor-memory')
  const monitorFrame = document.querySelector('#monitor-frame')
  const monitorRaf = document.querySelector('#monitor-raf')
  invariant(desktop !== null, 'desktop is missing')
  invariant(windows.length === windowCount, 'window node count mismatch')
  invariant(dockItems.length === windowCount, 'dock item count mismatch')
  invariant(photosViewport !== null, 'Photos viewport is missing')

  desktop.style.setProperty('--title-height', source[sourceField.titleHeight] + 'px')
  desktop.style.setProperty('--button-size', source[sourceField.buttonSize] + 'px')
  desktop.style.setProperty('--button-gap', source[sourceField.buttonGap] + 'px')
  desktop.style.setProperty('--resize-grip', source[sourceField.resizeGrip] + 'px')
  desktop.style.setProperty('--dock-height', source[sourceField.dockHeight] + 'px')
  desktop.style.setProperty(
    '--system-bar-height',
    source[sourceField.systemBarHeight] + 'px',
  )

  let affineCount = 0
  let regluCount = 0
  let booleanCount = 0
  let denseWeightCount = 0
  let maximumLayerWidth = 0
  let weightBytes = 0
  let biasBytes = 0
  let bookkeepingBytes = program.roots.byteLength + program.wireOrder.byteLength
  for (const layer of program.layers) {
    const layerWidth = layer.outputSize + layer.gateRows.length
    regluCount += layer.gateRows.length
    booleanCount += layer.booleanRows.length
    affineCount += layer.outputSize
      - layer.gateRows.length
      - layer.booleanRows.length
    denseWeightCount += layerWidth * layer.inputSize
    maximumLayerWidth = Math.max(maximumLayerWidth, layerWidth)
    weightBytes += layer.weights.byteLength
    biasBytes += layer.bias.byteLength
    bookkeepingBytes +=
      layer.inputIndices.byteLength
      + layer.gateRows.byteLength
      + layer.booleanRows.byteLength
      + layer.rowOffsets.byteLength
      + layer.columns.byteLength
  }
  const count = value => value.toLocaleString('en-US')
  const kilobytes = bytes => (bytes / 1000).toFixed(1) + ' KB'
  monitorValues.textContent =
    count(program.sourceSize) + ' inputs · '
    + count(program.roots.length) + ' outputs · '
    + count(program.valueCount - program.sourceSize) + ' activations'
  monitorOperations.textContent =
    count(affineCount) + ' affine · '
    + count(regluCount) + ' ReGLU · '
    + count(booleanCount) + ' boolean'
  monitorLayers.textContent =
    count(program.layers.length) + ' · max width ' + count(maximumLayerWidth)
  monitorWeights.textContent =
    count(denseWeightCount) + ' dense · ' + count(stats.weights) + ' sparse'
  monitorMemory.textContent =
    kilobytes(weightBytes) + ' weights · '
    + kilobytes(biasBytes) + ' biases · '
    + kilobytes(bookkeepingBytes) + ' bookkeeping'
  monitorFrame.textContent = '—'
  monitorRaf.textContent = 'no'

  const backdrop = photosViewport.querySelector('.photos-backdrop')
  const previousControl = photosViewport.querySelector('.photos-previous')
  const nextControl = photosViewport.querySelector('.photos-next')
  const photoElements = Array(photoCount).fill(null)
  const thumbnailElements = Array(photoCount).fill(null)

  function projectGeometry(element, values, wires, start, fields) {
    const left = values[wires[start + fields.left]]
    const top = values[wires[start + fields.top]]
    element.style.width = values[wires[start + fields.width]] + 'px'
    element.style.height = values[wires[start + fields.height]] + 'px'
    element.style.transform =
      'translate3d(' + left + 'px,' + top + 'px,0)'
  }

  function createPhotoElement(item, thumbnail) {
    const element = document.createElement('div')
    element.className =
      (thumbnail ? 'photos-thumbnail' : 'photos-photo') + ' image-' + item
    if (!thumbnail) {
      const title = document.createElement('span')
      title.textContent = photoNames[item]
      element.appendChild(title)
    }
    photosViewport.appendChild(element)
    return element
  }

  function projectPhotoItem(elements, item, values, wires, fields, thumbnail) {
    const start = item * fields.size
    const width = values[wires[start + fields.width]]
    const height = values[wires[start + fields.height]]
    const opacity = values[wires[start + fields.opacity]]
    const visible = width > 0 && height > 0 && opacity > 0
    let element = elements[item]
    if (!visible) {
      if (element !== null) {
        element.remove()
        elements[item] = null
      }
      return
    }
    if (element === null) {
      element = createPhotoElement(item, thumbnail)
      elements[item] = element
    }
    projectGeometry(element, values, wires, start, fields)
    element.style.opacity = String(opacity)
    element.style.setProperty(
      '--focused',
      String(values[wires[start + fields.focused]]),
    )
  }

  function renderPhotos(values) {
    backdrop.style.opacity = String(values[output.photos.backdropOpacity])
    for (let item = 0; item < photoCount; item++) {
      projectPhotoItem(
        photoElements,
        item,
        values,
        output.photos.photos,
        photoField,
        false,
      )
      projectPhotoItem(
        thumbnailElements,
        item,
        values,
        output.photos.thumbnails,
        thumbnailField,
        true,
      )
    }
    projectGeometry(
      previousControl,
      values,
      output.photos.previousControl,
      0,
      controlField,
    )
    projectGeometry(
      nextControl,
      values,
      output.photos.nextControl,
      0,
      controlField,
    )
    previousControl.style.opacity = String(
      values[output.photos.previousControl[controlField.opacity]],
    )
    nextControl.style.opacity = String(
      values[output.photos.nextControl[controlField.opacity]],
    )
  }

  let scheduledFrame = null
  function scheduleRender() {
    if (scheduledFrame !== null) return
    scheduledFrame = requestAnimationFrame(render)
  }

  function render(frameTime) {
    const startTime = performance.now()
    scheduledFrame = null
    source[sourceField.viewportWidth] = document.documentElement.clientWidth
    source[sourceField.viewportHeight] = document.documentElement.clientHeight
    source[sourceField.frameTime] = frameTime
    const values = evaluate()
    for (let field = 0; field < source.length; field++) {
      source[field] = values[output.nextSource[field]]
    }

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const element = windows[windowIndex]
      const start = windowIndex * windowOutputField.size
      const translateX =
        values[output.windows[start + windowOutputField.translateX]]
      const translateY =
        values[output.windows[start + windowOutputField.translateY]]
      const scale = values[output.windows[start + windowOutputField.scale]]
      element.style.width =
        values[output.windows[start + windowOutputField.width]] + 'px'
      element.style.height =
        values[output.windows[start + windowOutputField.height]] + 'px'
      element.style.transform =
        'translate3d(' + translateX + 'px,' + translateY + 'px,0) scale('
        + scale + ')'
      element.style.opacity = String(
        values[output.windows[start + windowOutputField.opacity]],
      )
      element.style.zIndex = String(
        10 + values[output.windows[start + windowOutputField.stack]],
      )
      element.style.setProperty(
        '--focused',
        String(values[output.windows[start + windowOutputField.focused]]),
      )
      element.style.setProperty(
        '--maximized',
        String(values[output.windows[start + windowOutputField.maximized]]),
      )
    }

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const element = dockItems[windowIndex]
      const start = windowIndex * dockOutputField.size
      element.style.left =
        values[output.dockItems[start + dockOutputField.left]] + 'px'
      element.style.top =
        values[output.dockItems[start + dockOutputField.top]] + 'px'
      element.style.width =
        values[output.dockItems[start + dockOutputField.width]] + 'px'
      element.style.height =
        values[output.dockItems[start + dockOutputField.height]] + 'px'
      element.style.setProperty(
        '--inactive',
        String(values[output.dockItems[start + dockOutputField.inactive]]),
      )
      element.style.setProperty(
        '--focused',
        String(values[output.dockItems[start + dockOutputField.focused]]),
      )
      element.style.setProperty(
        '--open',
        String(values[output.dockItems[start + dockOutputField.open]]),
      )
    }

    renderPhotos(values)
    const nextFrame = values[output.animationActive] > 0
    if (nextFrame) scheduleRender()
    monitorRaf.textContent = nextFrame ? 'yes' : 'no'
    monitorFrame.textContent = (performance.now() - startTime).toFixed(2) + ' ms'
  }

  addEventListener('pointerdown', event => {
    receivePointer(
      sourceField.downActive,
      sourceField.downX,
      sourceField.downY,
      event.clientX,
      event.clientY,
    )
    scheduleRender()
  })
  addEventListener('pointermove', event => {
    receivePointer(
      sourceField.moveActive,
      sourceField.moveX,
      sourceField.moveY,
      event.clientX,
      event.clientY,
    )
    scheduleRender()
  })
  addEventListener('pointerup', event => {
    receivePointer(
      sourceField.upActive,
      sourceField.upX,
      sourceField.upY,
      event.clientX,
      event.clientY,
    )
    scheduleRender()
  })
  addEventListener('pointercancel', event => {
    receivePointer(
      sourceField.upActive,
      sourceField.upX,
      sourceField.upY,
      event.clientX,
      event.clientY,
    )
    scheduleRender()
  })
  photosViewport.addEventListener('click', event => {
    receivePhotoEvent(
      photoSourceField.clickActive,
      event.offsetX,
      event.offsetY,
    )
    scheduleRender()
  })
  addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      receivePhotoEvent(photoSourceField.previousActive)
    } else if (event.key === 'ArrowRight') {
      receivePhotoEvent(photoSourceField.nextActive)
    } else if (event.key === 'Escape') {
      receivePhotoEvent(photoSourceField.closeActive)
    } else {
      return
    }
    event.preventDefault()
    scheduleRender()
  })
  addEventListener('resize', scheduleRender)
  render(performance.now())
})()`

const standalone = html
  .replace(
    '<title>IndirectOS</title>',
    `<title>IndirectOS · ${stats.weights.toLocaleString('en-US')} weights</title>`,
  )
  .replace(
    '  <link rel="stylesheet" href="./window-manager.css">',
    `  <style>\n${css}\n  </style>`,
  )
  .replace(
    '  <script type="module" src="./window-manager.ts"></script>',
    `  <script>\n${runtime}\n  </script>`,
  )
  .replace(
    '<!DOCTYPE html>',
    `<!DOCTYPE html>
<!-- Generated by generate-indirect-os-weights.ts.
     The compiler is gone: this file contains the final ${stats.weights} FP32 weights. -->`,
  )

invariant(!standalone.includes('src="./'), 'standalone HTML still has an external script')
invariant(!standalone.includes('href="./'), 'standalone HTML still has an external stylesheet')
invariant(!standalone.includes('url("./'), 'standalone HTML still has an external image')
invariant(
  standalone.includes(`new Float32Array([`),
  'standalone HTML does not contain numeric tensors',
)

const destination = new URL('indirect-os-weights.html', root)
await Bun.write(destination, standalone)
console.log(
  `Wrote indirect-os-weights.html: ${stats.weights.toLocaleString('en-US')} weights, `
  + `${program.layers.length} layers, ${(standalone.length / 1_000_000).toFixed(2)} MB`,
)

function serialize(value: unknown, indentation = 0): string {
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'generated numeric data must be finite')
    return Object.is(value, -0) ? '-0' : String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (ArrayBuffer.isView(value)) {
    const typed = value as
      | Float32Array
      | Uint8Array
      | Uint16Array
      | Uint32Array
    return `new ${typed.constructor.name}(${serializeArray(typed, indentation)})`
  }
  if (Array.isArray(value)) return serializeArray(value, indentation)
  invariant(value !== null && typeof value === 'object', 'cannot serialize generated data')
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const innerIndentation = indentation + 2
  const fields = entries.map(([key, field]) =>
    `${' '.repeat(innerIndentation)}${JSON.stringify(key)}: `
    + serialize(field, innerIndentation))
  return `{\n${fields.join(',\n')}\n${' '.repeat(indentation)}}`
}

function serializeArray(
  values: ArrayLike<unknown>,
  indentation: number,
) {
  if (values.length === 0) return '[]'
  const innerIndentation = indentation + 2
  const serialized = Array.from(values, value => serialize(value, innerIndentation))
  const lines: string[] = []
  for (let start = 0; start < serialized.length; start += 24) {
    lines.push(
      `${' '.repeat(innerIndentation)}${serialized.slice(start, start + 24).join(',')}`,
    )
  }
  return `[\n${lines.join(',\n')}\n${' '.repeat(indentation)}]`
}

function invariant(condition: unknown, message: string): asserts condition {
  if (condition !== true) throw new Error(message)
}
