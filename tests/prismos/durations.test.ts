import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {describeDuration, formatTimer, parseDuration} from '../../src/prismos/durations.ts'

test('durations read as people type and say them', () => {
  const cases: [string, number | null][] = [
    ['5 minutes', 300], ['5 minute', 300], ['90 seconds', 90], ['1 hour 30 minutes', 5400], ['an hour and a half', 5400],
    ['half an hour', 1800], ['a minute and a half', 90], ['2.5 min', 150], ['1:30', 90], ['1:02:03', 3723], ['5', 300],
    ['ten minutes', 600], ['twenty five minutes', 1500], ['forty five seconds', 45], ['1h30m', 5400], ['for 10 mins', 600],
    ['45 sec timer', 45], ['5 minutes and 30 seconds', 330], ['two hours, 15 minutes', 8100],
    ['3 days', null], ['25 hours', null], ['0 minutes', null], ['banana', null], ['five five minutes', null], ['', null],
  ]
  for (const [text, seconds] of cases) assert.equal(parseDuration(text), seconds, text)
  assert.equal(parseDuration(5), null)
})

test('timer readouts and spoken lengths', () => {
  assert.equal(formatTimer(299.2), '5:00')
  assert.equal(formatTimer(59), '0:59')
  assert.equal(formatTimer(3600), '1:00:00')
  assert.equal(formatTimer(-3), '0:00')
  assert.equal(describeDuration(5400), '1 hour 30 minutes')
  assert.equal(describeDuration(61), '1 minute 1 second')
})
