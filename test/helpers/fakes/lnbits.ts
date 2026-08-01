import {HTTPError} from 'got'

export type FakePaymentStatus = 'paid' | 'pending' | 'failed' | 'missing'

export type FakeInvoice = {
  payment_hash: string
  bolt11: string
  sats: number
}

/**
 * In-memory stand-in for master + user wallets used by settlement tests.
 * Control outcomes via `setLookup` / `setPayResult`.
 */
export function createFakeLnbits() {
  let invoiceCounter = 0
  const issued: FakeInvoice[] = []
  const paidBolt11s: string[] = []
  const ledger = new Map<string, {paid: boolean; status?: string}>()
  let payResult: 'ok' | 'throw' | FakePaymentStatus = 'ok'

  function createInvoice(sats: number): FakeInvoice {
    invoiceCounter++
    const invoice: FakeInvoice = {
      payment_hash: `hash-${invoiceCounter}`,
      bolt11: `bolt11-${invoiceCounter}`,
      sats,
    }
    issued.push(invoice)
    return invoice
  }

  const userWallet = {
    createInvoice: async ({sats}: {sats: number}) => {
      const inv = createInvoice(sats)
      return {payment_hash: inv.payment_hash, bolt11: inv.bolt11}
    },
    payInvoice: async (bolt11: string) => {
      if (payResult === 'throw') throw new Error('pay failed')
      paidBolt11s.push(bolt11)
      const inv = issued.find(i => i.bolt11 === bolt11)
      if (inv) ledger.set(inv.payment_hash, {paid: true})
      return {payment_hash: inv?.payment_hash ?? 'unknown'}
    },
    balance: 1_000_000_000,
  }

  const masterWallet = {
    createInvoice: async (sats: number, _expiry?: number) => {
      const inv = createInvoice(sats)
      return {payment_hash: inv.payment_hash, bolt11: inv.bolt11}
    },
    createFeeCollectionInvoice: async (sats: number) => {
      const inv = createInvoice(sats)
      return {payment_hash: inv.payment_hash, bolt11: inv.bolt11}
    },
    payInvoice: async (bolt11: string) => {
      if (payResult === 'throw') throw new Error('pay failed')
      paidBolt11s.push(bolt11)
      const inv = issued.find(i => i.bolt11 === bolt11)
      if (!inv) throw new Error(`unknown bolt11 ${bolt11}`)
      if (payResult === 'pending') {
        ledger.set(inv.payment_hash, {paid: false})
      } else if (payResult === 'failed') {
        ledger.set(inv.payment_hash, {paid: false, status: 'failed'})
      } else if (payResult === 'missing') {
        // leave out of ledger → 404 on lookup
      } else {
        ledger.set(inv.payment_hash, {paid: true})
      }
      return {payment_hash: inv.payment_hash}
    },
    lookupPayment: async (hash: string) => {
      const entry = ledger.get(hash)
      if (!entry) {
        const error = Object.create(HTTPError.prototype) as HTTPError
        Object.assign(error, {response: {statusCode: 404}})
        throw error
      }
      return entry
    },
  }

  return {
    issued,
    paidBolt11s,
    ledger,
    userWallet,
    masterWallet,
    setLookup(hash: string, state: FakePaymentStatus) {
      if (state === 'missing') {
        ledger.delete(hash)
        return
      }
      if (state === 'paid') ledger.set(hash, {paid: true})
      else if (state === 'pending') ledger.set(hash, {paid: false})
      else ledger.set(hash, {paid: false, status: 'failed'})
    },
    setPayResult(result: 'ok' | 'throw' | FakePaymentStatus) {
      payResult = result
    },
    reset() {
      invoiceCounter = 0
      issued.length = 0
      paidBolt11s.length = 0
      ledger.clear()
      payResult = 'ok'
    },
  }
}

export type FakeLnbits = ReturnType<typeof createFakeLnbits>
