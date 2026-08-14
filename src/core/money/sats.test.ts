import {expect, test} from 'bun:test'
import {satsToBtcAmount} from './sats.js'

test('a whole BTC loses the decimal point along with the zeroes', () => {
  expect(satsToBtcAmount(100_000_000)).toBe('1')
})

test('a small amount stays decimal instead of turning exponential', () => {
  expect(satsToBtcAmount(1000)).toBe('0.00001')
  expect(satsToBtcAmount(10)).toBe('0.0000001')
})

test('a single satoshi keeps all eight places', () => {
  expect(satsToBtcAmount(1)).toBe('0.00000001')
})
