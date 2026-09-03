import {photoCaptions} from './data.ts'

// Regeneration requires macOS. The checked-in measurements keep studies
// deterministic elsewhere; the interactive demo measures its actual font.
const words = new Set<string>([' '])
for (const [name, short, long] of photoCaptions) {
  for (const word of `${name}. ${short} ${long}`.split(' ')) words.add(word)
}
const process = Bun.spawn(['swift', '-module-cache-path', '/tmp/indirect-font-cache', `${import.meta.dir}/measure-font.swift`], {
  stdin: new Blob([JSON.stringify([...words])]), stdout: 'pipe', stderr: 'inherit',
})
const output = await new Response(process.stdout).text()
if (await process.exited !== 0) throw new Error('font measurement failed')
await Bun.write(`${import.meta.dir}/font-metrics.json`, `${output}\n`)
console.log(`Measured ${words.size} words using Arial 14 on macOS`)
