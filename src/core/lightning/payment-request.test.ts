import {describe, expect, test} from 'bun:test'
import {recognizePaymentRequest} from './payment-request.js'

const BOLT11 = 'lnbc1pabcdef'
const LNURL = 'lnurl1dp68gurn8ghj7cts'
const ADDRESS = 'alice@getalby.com'

describe('recognizePaymentRequest', () => {
  test('recognizes a bolt11 invoice in any case, with a lightning: prefix and edge spaces', () => {
    expect(recognizePaymentRequest(BOLT11)).toEqual({kind: 'bolt11', value: BOLT11})
    expect(recognizePaymentRequest(BOLT11.toUpperCase())).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
    expect(recognizePaymentRequest(`  Lightning:${BOLT11.toUpperCase()}  `)).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
    expect(recognizePaymentRequest(`\nlightning:  ${BOLT11}\n`)).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
    expect(recognizePaymentRequest(`lightning://${BOLT11}`)).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
    expect(
      recognizePaymentRequest(
        `bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?lightning=${BOLT11.toUpperCase()}`,
      ),
    ).toEqual({kind: 'bolt11', value: BOLT11})
    expect(recognizePaymentRequest(`BITCOIN:bc1qtest?amount=0.001&lightning=${BOLT11}`)).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
  })

  test('recognizes an LNURL the same way', () => {
    expect(recognizePaymentRequest(LNURL)).toEqual({kind: 'lnurl', value: LNURL})
    expect(recognizePaymentRequest(`LIGHTNING:${LNURL.toUpperCase()}`)).toEqual({
      kind: 'lnurl',
      value: LNURL,
    })
    expect(recognizePaymentRequest(`  ${LNURL}  `)).toEqual({kind: 'lnurl', value: LNURL})
    expect(recognizePaymentRequest(`lnurlp://${LNURL}`)).toEqual({
      kind: 'lnurl',
      value: `lnurlp://${LNURL}`,
    })
    expect(recognizePaymentRequest(`LNURLW://${LNURL.toUpperCase()}`)).toEqual({
      kind: 'lnurl',
      value: `lnurlw://${LNURL}`,
    })
    expect(recognizePaymentRequest('LNURLP://Pay.Example/LnUrlP/Alice?token=AbC')).toEqual({
      kind: 'lnurl',
      value: 'lnurlp://pay.example/LnUrlP/Alice?token=AbC',
    })
    expect(
      recognizePaymentRequest('lightning:LNURLW://Pay.Example:8443/Pay/Alice?token=AbC#Keep'),
    ).toEqual({
      kind: 'lnurl',
      value: 'lnurlw://pay.example:8443/Pay/Alice?token=AbC#Keep',
    })
  })

  test('recognizes a Lightning address', () => {
    expect(recognizePaymentRequest(ADDRESS)).toEqual({
      kind: 'lightning-address',
      value: ADDRESS,
    })
    expect(recognizePaymentRequest('  Lightning:Alice@GetAlby.COM ')).toEqual({
      kind: 'lightning-address',
      value: ADDRESS,
    })
    expect(recognizePaymentRequest('user.name+tag@sub.example.co')).toEqual({
      kind: 'lightning-address',
      value: 'user.name+tag@sub.example.co',
    })
    expect(recognizePaymentRequest('satoshi@localhost')).toEqual({
      kind: 'lightning-address',
      value: 'satoshi@localhost',
    })
    expect(recognizePaymentRequest('User@MyHost')).toEqual({
      kind: 'lightning-address',
      value: 'user@myhost',
    })
    expect(recognizePaymentRequest('a@b')).toEqual({kind: 'lightning-address', value: 'a@b'})
    expect(recognizePaymentRequest('_@localhost')).toEqual({
      kind: 'lightning-address',
      value: '_@localhost',
    })
    expect(recognizePaymentRequest('tips+tag@abcdefghijklmnopqrstuvwxyz234567.onion')).toEqual({
      kind: 'lightning-address',
      value: 'tips+tag@abcdefghijklmnopqrstuvwxyz234567.onion',
    })
    expect(recognizePaymentRequest('lightning:satoshi@localhost')).toEqual({
      kind: 'lightning-address',
      value: 'satoshi@localhost',
    })
    expect(recognizePaymentRequest('.alice@example.com')).toEqual({
      kind: 'lightning-address',
      value: '.alice@example.com',
    })
    expect(recognizePaymentRequest('alice.@example.com')).toEqual({
      kind: 'lightning-address',
      value: 'alice.@example.com',
    })
    expect(recognizePaymentRequest('-alice@example.com')).toEqual({
      kind: 'lightning-address',
      value: '-alice@example.com',
    })
    expect(recognizePaymentRequest('alice-@example.com')).toEqual({
      kind: 'lightning-address',
      value: 'alice-@example.com',
    })
  })

  test('rejects garbage, usernames, amounts, and payment requests buried in a sentence', () => {
    for (const text of [
      '',
      '   ',
      'hello',
      'not an invoice',
      '@alice',
      '@bitcoin.org',
      'user_b',
      '1000',
      '0',
      'user@',
      '@localhost',
      'user@localhost:9735',
      'user@host/path',
      'user name@host',
      `pay ${BOLT11} please`,
      `see ${ADDRESS}`,
      `use ${LNURL}`,
      'lnbc',
      'lnbcrt1pabcdef',
      'lightning:lnbcrt1pabcdef',
      'LIGHTNING://LNBCRT1PABCDEF',
      'bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?lightning=lnbcrt1pabcdef',
      'lnurl',
      'lightning:',
      'nostr+walletconnect://relay?secret=1',
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      'bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    ]) {
      expect(recognizePaymentRequest(text)).toBeNull()
    }
  })
})
