// A minimal PNG encoder for looking at rendered frames headlessly: 8-bit RGBA,
// no interlacing, zlib compression from node:zlib.
import {deflateSync} from 'node:zlib'

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(12 + data.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index)
  bytes.set(data, 8)
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)))
  return bytes
}

// pixels: width × height × 4 bytes, rows top first.
export function encodePng(width: number, height: number, pixels: Uint8Array | Uint8ClampedArray): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let row = 0; row < height; row++) {
    raw[row * (width * 4 + 1)] = 0
    raw.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1)
  }
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
