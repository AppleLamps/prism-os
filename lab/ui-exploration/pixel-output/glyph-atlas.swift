// Renders a 1-bit glyph atlas with CoreText, for headless runs where there is no
// canvas. The browser demo builds its atlas from its own canvas instead.
//
//   swift lab/ui-exploration/pixel-output/glyph-atlas.swift Verdana 11 < characters.json > glyph-atlas.json
//
// stdin: a JSON array of one-character strings. stdout: JSON with the cell size,
// the baseline row, and for each character its rows as strings of 0 and 1
// (top row first). A pixel is ink when the antialiased coverage is at least 50%.
import CoreGraphics
import CoreText
import Foundation

let arguments = CommandLine.arguments
let fontName = arguments.count > 1 ? arguments[1] : "Verdana"
let fontSize = CGFloat(arguments.count > 2 ? Double(arguments[2])! : 11)
let cellWidth = 12
let cellHeight = 14
let baselineFromTop = 11

let input = FileHandle.standardInput.readDataToEndOfFile()
let characters = try! JSONSerialization.jsonObject(with: input) as! [String]
let font = CTFontCreateWithName(fontName as CFString, fontSize, nil)
var glyphs: [String: [String]] = [:]
for character in characters {
  let context = CGContext(
    data: nil, width: cellWidth, height: cellHeight, bitsPerComponent: 8, bytesPerRow: cellWidth,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  context.setFillColor(gray: 0, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: cellWidth, height: cellHeight))
  let attributes: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: character, attributes: attributes))
  // CoreGraphics puts y = 0 at the bottom of the bitmap.
  context.textPosition = CGPoint(x: 0, y: CGFloat(cellHeight - baselineFromTop))
  CTLineDraw(line, context)
  let pixels = context.data!.bindMemory(to: UInt8.self, capacity: cellWidth * cellHeight)
  var rows: [String] = []
  for row in 0..<cellHeight {
    var text = ""
    for column in 0..<cellWidth {
      text += pixels[row * cellWidth + column] >= 128 ? "1" : "0"
    }
    rows.append(text)
  }
  glyphs[character] = rows
}
let output: [String: Any] = [
  "font": fontName, "fontSize": Double(fontSize), "cellWidth": cellWidth, "cellHeight": cellHeight,
  "baselineFromTop": baselineFromTop, "glyphs": glyphs,
]
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
