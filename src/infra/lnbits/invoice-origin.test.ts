import {describe, expect, test} from 'bun:test'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {FAKE_LNBITS_ADMIN_BEARER, startFakeLnbits} from '../../../test/e2e/fakes/lnbits-server.js'
import {createInvoiceOriginLookup, originFromAdminPaymentPage} from './invoice-origin.js'
import {UserWallet} from './user-wallet.js'

const HASH = 'ab'.repeat(32)
const incoming = {
  amount: 21_000,
  status: 'pending',
  wallet_id: 'receiver',
  payment_hash: HASH,
}

describe('originFromAdminPaymentPage', () => {
  test('a pending or paid incoming row does not need the funding source', () => {
    expect(originFromAdminPaymentPage({data: [incoming], total: 1}, HASH)).toBe('internal')
    expect(
      originFromAdminPaymentPage(
        {
          data: [{amount: 21_000, status: 'success', wallet_id: 'receiver', payment_hash: HASH}],
          total: 1,
        },
        HASH,
      ),
    ).toBe('internal')
  })

  test('a failed incoming row, or only another wallet outgoing row, still pays externally', () => {
    expect(
      originFromAdminPaymentPage(
        {
          data: [{amount: 21_000, status: 'failed', wallet_id: 'receiver', payment_hash: HASH}],
          total: 1,
        },
        HASH,
      ),
    ).toBe('external')
    expect(
      originFromAdminPaymentPage(
        {
          data: [{amount: -21_000, status: 'success', wallet_id: 'payer-a', payment_hash: HASH}],
          total: 1,
        },
        HASH,
        'payer-b',
      ),
    ).toBe('external')
  })

  test('the payer own pending or successful outgoing row is not sent again', () => {
    const page = {
      data: [{amount: -21_000, status: 'success', wallet_id: 'payer-a', payment_hash: HASH}],
      total: 1,
    }
    expect(originFromAdminPaymentPage(page, HASH, 'payer-a')).toBe('internal')
    expect(originFromAdminPaymentPage(page, HASH)).toBe('external')
  })

  test('a row for a different payment hash is not treated as internal', () => {
    expect(originFromAdminPaymentPage({data: [incoming], total: 1}, 'cd'.repeat(32))).toBe(
      'unknown',
    )
    expect(
      originFromAdminPaymentPage(
        {data: [{amount: 21_000, status: 'pending', wallet_id: 'receiver'}], total: 1},
        HASH,
      ),
    ).toBe('unknown')
    expect(originFromAdminPaymentPage({data: [], total: 0}, HASH)).toBe('external')
  })

  test('an unreadable page does not decide', () => {
    expect(originFromAdminPaymentPage(null, HASH)).toBe('unknown')
    expect(originFromAdminPaymentPage({paid: true}, HASH)).toBe('unknown')
    expect(
      originFromAdminPaymentPage(
        {data: [{amount: '21', status: 'pending', payment_hash: HASH}]},
        HASH,
      ),
    ).toBe('unknown')
  })
})

describe('createInvoiceOriginLookup', () => {
  test('uses the admin payment list and ignores a keyless 200', async () => {
    const fake = await startFakeLnbits({
      adminKey: 'master-admin-key',
      feeCollectionKey: 'fee-collection-key',
    })
    try {
      const wallet = fake.state.walletByApiKey('master-admin-key')
      if (!wallet) throw new Error('master wallet missing')
      const invoice = fake.state.createInvoice({
        wallet,
        sats: 21,
        memo: 'origin',
        expirySec: 3600,
      })
      const before = fake.requests.length
      const classify = createInvoiceOriginLookup(fake.url, FAKE_LNBITS_ADMIN_BEARER)
      expect(await classify(invoice.bolt11, wallet.id)).toBe('internal')
      const lookup = fake.requests.slice(before).map(request => request.path)
      expect(lookup).toEqual(['/api/v1/payments/all/paginated'])

      fake.state.credit(wallet.id, 100_000_000)
      const foreign = mintInvoice({sats: 21, description: 'foreign'})
      await new UserWallet(wallet.adminkey, wallet.balanceMsat, fake.url).payInvoice(foreign.bolt11)
      expect(await classify(foreign.bolt11, 'someone-else')).toBe('external')
      expect(await classify(foreign.bolt11, wallet.id)).toBe('internal')

      const unmarked = fake.requests.length
      expect(await createInvoiceOriginLookup(fake.url)(invoice.bolt11)).toBe('unknown')
      expect(fake.requests.length).toBe(unmarked)
    } finally {
      fake.stop()
    }
  })

  test('pages through the admin list and fails open past the row ceiling', async () => {
    const fake = await startFakeLnbits({
      adminKey: 'master-admin-key',
      feeCollectionKey: 'fee-collection-key',
    })
    try {
      const wallet = fake.state.walletByApiKey('master-admin-key')
      if (!wallet) throw new Error('master wallet missing')
      const invoice = fake.state.createInvoice({
        wallet,
        sats: 21,
        memo: 'pages',
        expirySec: 3600,
      })
      const sample = fake.state.payments[0]
      if (!sample) throw new Error('payment missing')
      for (let index = 0; index < 55; index++) {
        fake.state.payments.push({...sample, out: true, paid: true})
      }
      const classify = createInvoiceOriginLookup(fake.url, FAKE_LNBITS_ADMIN_BEARER)
      const before = fake.requests.length
      expect(await classify(invoice.bolt11, wallet.id)).toBe('internal')
      const pages = fake.requests
        .slice(before)
        .filter(request => request.path.endsWith('/paginated'))
      expect(pages.length).toBe(2)

      for (let index = 0; index < 150; index++) {
        fake.state.payments.push({...sample, out: true, paid: true})
      }
      expect(await classify(invoice.bolt11, wallet.id)).toBe('unknown')
    } finally {
      fake.stop()
    }
  })
})
