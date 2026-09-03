import AppKit
import Foundation

let data = FileHandle.standardInput.readDataToEndOfFile()
let strings = try JSONDecoder().decode([String].self, from: data)
let font = NSFont(name: "Arial", size: 14)!
var widths: [String: Double] = [:]
for string in strings {
  widths[string] = Double((string as NSString).size(withAttributes: [.font: font]).width)
}
let result = try JSONSerialization.data(withJSONObject: widths, options: [.sortedKeys, .prettyPrinted])
FileHandle.standardOutput.write(result)
