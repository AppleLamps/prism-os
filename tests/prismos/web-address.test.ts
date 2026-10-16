import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {addressFor, framingFor, pageName, webAddress} from '../../src/prismos/web-address.ts'

test('web addresses read as people type them, over https', () => {
  assert.equal(webAddress('wikipedia.org'), 'https://wikipedia.org/')
  assert.equal(webAddress('en.wikipedia.org/wiki/Prism'), 'https://en.wikipedia.org/wiki/Prism')
  assert.equal(webAddress('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d')
  assert.equal(webAddress('HTTP://Example.COM'), 'https://example.com/')
  assert.equal(webAddress('xkcd.com.'), 'https://xkcd.com/')
  assert.equal(webAddress('example.com:8080/x'), 'https://example.com:8080/x')
  assert.equal(webAddress('localhost:3000'), 'https://localhost:3000/')
  assert.equal(webAddress('http://localhost:3000/'), 'http://localhost:3000/')
})

test('words, file names and other schemes aren\'t web addresses', () => {
  for (const text of ['glass prisms', 'calculator', 'notes.txt', 'Beach.PNG', '17.5', '3.5+2', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', '', '  ', 'a.b']) {
    assert.equal(webAddress(text), null, text)
  }
  assert.equal(webAddress(42), null)
})

test('the address bar searches what isn\'t an address', () => {
  assert.equal(addressFor('xkcd.com'), 'https://xkcd.com/')
  assert.equal(addressFor('how rainbows form'), 'https://www.bing.com/search?q=how%20rainbows%20form')
  assert.equal(addressFor('notes.txt'), 'https://www.bing.com/search?q=notes.txt')
  assert.equal(addressFor('   '), null)
})

test('sites that refuse frames are known, and some have an address made for frames', () => {
  assert.deepEqual(framingFor('https://en.wikipedia.org/wiki/Prism'), {kind: 'frame', url: 'https://en.wikipedia.org/wiki/Prism'})
  assert.deepEqual(framingFor('https://github.com/AppleLamps/prism-os'), {kind: 'refused', site: 'GitHub'})
  assert.deepEqual(framingFor('https://gist.github.com/'), {kind: 'refused', site: 'GitHub'})
  assert.deepEqual(framingFor('https://notgithub.com/'), {kind: 'frame', url: 'https://notgithub.com/'})
  assert.deepEqual(framingFor('https://www.youtube.com/'), {kind: 'refused', site: 'YouTube'})
  const player = {kind: 'frame', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'}
  assert.deepEqual(framingFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), player)
  assert.deepEqual(framingFor('https://youtu.be/dQw4w9WgXcQ'), player)
  assert.deepEqual(framingFor('https://m.youtube.com/shorts/dQw4w9WgXcQ'), player)
  assert.deepEqual(framingFor('https://www.google.com/search?q=prism'), {kind: 'frame', url: 'https://www.google.com/search?q=prism&igu=1'})
  assert.deepEqual(framingFor('https://google.com/'), {kind: 'frame', url: 'https://google.com/webhp?igu=1'})
  assert.deepEqual(framingFor('https://www.google.com/maps'), {kind: 'refused', site: 'Google'})
  assert.deepEqual(framingFor('https://prism-os-orcin.vercel.app/?model=on', 'https://prism-os-orcin.vercel.app'), {kind: 'self'})
  assert.equal(pageName('https://www.gutenberg.org/ebooks/'), 'gutenberg.org')
})
