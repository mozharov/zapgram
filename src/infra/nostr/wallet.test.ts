import {afterAll, afterEach, expect, spyOn, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NoNWCAnswerError} from '@core/errors/no-nwc-answer.js'
import {Nip47Error, Nip47TimeoutError, NWCClient} from '@getalby/sdk'
import {encode, sign} from 'bolt11'
import {NostrWallet} from './wallet.js'

const PREIMAGE = '12'.repeat(32)
const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex')
const INVOICE = sign(
  encode({
    satoshis: 21,
    tags: [
      {tagName: 'payment_hash', data: PAYMENT_HASH},
      {tagName: 'description', data: 'NWC receipt verification'},
    ],
  }),
  '11'.repeat(32),
).paymentRequest

if (!INVOICE) throw new Error('missing test invoice')

// Stub both SDK operations before constructing the wallet; no relay is contacted.
const pay = spyOn(NWCClient.prototype, 'payInvoice')
const lookup = spyOn(NWCClient.prototype, 'lookupInvoice')

afterAll(() => {
  pay.mockRestore()
  lookup.mockRestore()
})

afterEach(() => {
  pay.mockReset()
  lookup.mockReset()
})

function wallet() {
  lookup.mockRejectedValue(new Nip47TimeoutError('lookup unavailable', 'OTHER'))
  return new NostrWallet(
    `nostr+walletconnect://${'aa'.repeat(32)}?relay=wss://relay.invalid&secret=${'bb'.repeat(32)}`,
  )
}

function found(preimage: string) {
  return {
    type: 'outgoing' as const,
    state: 'settled' as const,
    invoice: INVOICE as string,
    description: '',
    description_hash: '',
    preimage,
    payment_hash: PAYMENT_HASH,
    amount: 21_000,
    fees_paid: 0,
    settled_at: 1_700_000_001,
    created_at: 1_700_000_000,
    expires_at: 1_700_003_600,
  }
}

for (const timeout of [true, false]) {
  test(`NWC success requires the invoice preimage (timeout=${timeout})`, async () => {
    const nwc = wallet()
    pay.mockResolvedValue({preimage: PREIMAGE.toUpperCase(), fees_paid: 0})
    await expect(nwc.payInvoice(INVOICE, timeout)).resolves.toBeUndefined()
    expect(pay).toHaveBeenCalledTimes(1)
    expect(lookup).not.toHaveBeenCalled()
  })

  test(`NWC success with a mismatched preimage is unknown (timeout=${timeout})`, async () => {
    const nwc = wallet()
    pay.mockResolvedValue({preimage: '34'.repeat(32), fees_paid: 0})
    lookup.mockResolvedValue(found('34'.repeat(32)))
    await expect(nwc.payInvoice(INVOICE, timeout)).rejects.toBeInstanceOf(NoNWCAnswerError)
    expect(pay).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
}

for (const preimage of ['', '12'.repeat(31), `${PREIMAGE}gg`, '34'.repeat(32)]) {
  test(`claimExisting rejects an invalid preimage of length ${preimage.length}`, async () => {
    const nwc = wallet()
    pay.mockRejectedValue(new Nip47TimeoutError('pay timeout', 'OTHER'))
    lookup.mockResolvedValue(found(preimage))
    await expect(nwc.payInvoice(INVOICE, false)).rejects.toBeInstanceOf(NoNWCAnswerError)
    expect(pay).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
}

test('claimExisting accepts a lookup preimage matching the invoice hash', async () => {
  const nwc = wallet()
  pay.mockRejectedValue(new Nip47TimeoutError('pay timeout', 'OTHER'))
  lookup.mockResolvedValue(found(PREIMAGE))
  await expect(nwc.payInvoice(INVOICE, false)).resolves.toBeUndefined()
  expect(pay).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledWith({invoice: INVOICE})
})

test('claimExisting=false never claims a previous payment after an error', async () => {
  const nwc = wallet()
  pay.mockRejectedValue(new Nip47TimeoutError('pay timeout', 'OTHER'))
  lookup.mockResolvedValue(found(PREIMAGE))
  await expect(nwc.payInvoice(INVOICE, false, {claimExisting: false})).rejects.toBeInstanceOf(
    NoNWCAnswerError,
  )
  expect(pay).toHaveBeenCalledTimes(1)
  expect(lookup).not.toHaveBeenCalled()
})

test('an explicit already-paid error remains an error without claiming a preimage', async () => {
  const nwc = wallet()
  pay.mockRejectedValue(new Nip47Error('invoice has already been paid', 'OTHER'))
  lookup.mockResolvedValue(found(PREIMAGE))
  await expect(nwc.payInvoice(INVOICE, false)).rejects.toBeInstanceOf(InvoiceAlreadyPaidError)
  expect(pay).toHaveBeenCalledTimes(1)
  expect(lookup).not.toHaveBeenCalled()
})
