import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {Nip47Error} from '@getalby/sdk'
import {encode, sign} from 'bolt11'
import {classifyNwcInvoiceLookup, nwcInvoiceMissing, unixDate} from './nwc-lookup.js'

const PREIMAGE = 'ab'.repeat(32)
const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex')
const INVOICE = sign(
  encode({
    satoshis: 21,
    tags: [
      {tagName: 'payment_hash', data: PAYMENT_HASH},
      {tagName: 'description', data: 'NWC recovery receipt verification'},
    ],
  }),
  '11'.repeat(32),
).paymentRequest

if (!INVOICE) throw new Error('missing test invoice')

test('NWC recovery accepts a preimage matching both invoice and saved hash', () => {
  expect(
    classifyNwcInvoiceLookup(
      {preimage: PREIMAGE.toUpperCase(), settled_at: 1_700_000_001},
      INVOICE,
      PAYMENT_HASH,
    ),
  ).toEqual({state: 'paid', paidAt: new Date('2023-11-14T22:13:21.000Z')})
})

for (const preimage of ['34'.repeat(32), 'gg'.repeat(32), 'garbage', 'ab'.repeat(31)]) {
  test(`NWC recovery holds an invalid preimage ${preimage}`, () => {
    expect(classifyNwcInvoiceLookup({preimage}, INVOICE, PAYMENT_HASH)).toEqual({
      state: 'unknown',
    })
  })
}

test('NWC recovery holds a receipt when invoice and saved hash disagree', () => {
  expect(classifyNwcInvoiceLookup({preimage: PREIMAGE}, INVOICE, '34'.repeat(32))).toEqual({
    state: 'unknown',
  })
  const otherPreimage = '12'.repeat(32)
  const otherHash = createHash('sha256').update(Buffer.from(otherPreimage, 'hex')).digest('hex')
  expect(classifyNwcInvoiceLookup({preimage: otherPreimage}, INVOICE, otherHash)).toEqual({
    state: 'unknown',
  })
})

for (const preimage of ['', null, undefined]) {
  test(`NWC recovery keeps an empty preimage ${String(preimage)} pending`, () => {
    expect(classifyNwcInvoiceLookup({preimage}, INVOICE, PAYMENT_HASH)).toEqual({
      state: 'pending',
    })
  })
}

test('only a NIP-47 NOT_FOUND is a missing invoice', () => {
  expect(nwcInvoiceMissing(new Nip47Error('not found', 'NOT_FOUND'))).toBe(true)
  expect(nwcInvoiceMissing(new Nip47Error('rate limited', 'RATE_LIMITED'))).toBe(false)
  expect(nwcInvoiceMissing(new NWCTimeoutError())).toBe(false)
  expect(nwcInvoiceMissing(new Error('not found'))).toBe(false)
})

test('unix timestamps become dates and empty values do not', () => {
  expect(unixDate(1_700_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z')
  expect(unixDate(1_700_000_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z')
  expect(unixDate(0)).toBeUndefined()
  expect(unixDate(undefined)).toBeUndefined()
})
