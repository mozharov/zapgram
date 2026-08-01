import {describe, expect, test} from 'bun:test'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {mintInvoice} from './bolt11.js'

describe('mintInvoice', () => {
  for (const sats of [1, 21, 950, 1000, 100_000]) {
    for (const description of ['', 'ZapGram test', 'юникод ✅']) {
      test(`mints a decodable ${sats} sat invoice with ${JSON.stringify(description)}`, () => {
        const minted = mintInvoice({sats, description})
        const decoded = decodeInvoice(minted.bolt11)

        expect(decoded.satoshi).toBe(sats)
        expect(decoded.description).toBe(description)
        expect(decoded.paymentHash).toBe(minted.paymentHash)
      })
    }
  }

  test('matches the pasted-invoice routing pattern', () => {
    expect(mintInvoice({sats: 21}).bolt11).toMatch(/(lnbc[a-z0-9]+)/)
  })
})
