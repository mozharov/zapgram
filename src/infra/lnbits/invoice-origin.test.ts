import {describe, expect, test} from 'bun:test'
import {mintInvoice} from '../../../test/e2e/fakes/bolt11.js'
import {FAKE_LNBITS_ADMIN_BEARER, startFakeLnbits} from '../../../test/e2e/fakes/lnbits-server.js'
import {createInvoiceOriginLookup, originFromAdminPaymentPage} from './invoice-origin.js'
import {UserWallet} from './user-wallet.js'

const incoming = {amount: 21_000, status: 'pending', wallet_id: 'receiver'}

describe('originFromAdminPaymentPage', () => {
  test('a pending or paid incoming row does not need the funding source', () => {
    expect(originFromAdminPaymentPage({data: [incoming], total: 1})).toBe('internal')
    expect(
      originFromAdminPaymentPage({
        data: [{amount: 21_000, status: 'success', wallet_id: 'receiver'}],
        total: 1,
      }),
    ).toBe('internal')
  })

  test('a failed incoming row, or only another wallet outgoing row, still pays externally', () => {
    expect(
      originFromAdminPaymentPage({
        data: [{amount: 21_000, status: 'failed', wallet_id: 'receiver'}],
        total: 1,
      }),
    ).toBe('external')
    expect(
      originFromAdminPaymentPage(
        {data: [{amount: -21_000, status: 'success', wallet_id: 'payer-a'}], total: 1},
        'payer-b',
      ),
    ).toBe('external')
  })

  test('the payer own pending or successful outgoing row is not sent again', () => {
    const page = {data: [{amount: -21_000, status: 'success', wallet_id: 'payer-a'}], total: 1}
    expect(originFromAdminPaymentPage(page, 'payer-a')).toBe('internal')
    expect(originFromAdminPaymentPage(page)).toBe('external')
  })

  test('an unreadable page does not decide', () => {
    expect(originFromAdminPaymentPage(null)).toBe('unknown')
    expect(originFromAdminPaymentPage({paid: true})).toBe('unknown')
    expect(originFromAdminPaymentPage({data: [{amount: '21', status: 'pending'}]})).toBe('unknown')
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
})
