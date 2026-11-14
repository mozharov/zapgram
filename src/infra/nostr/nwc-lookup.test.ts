import {expect, test} from 'bun:test'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {Nip47Error} from '@getalby/sdk'
import {nwcInvoiceMissing, unixDate} from './nwc-lookup.js'

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
