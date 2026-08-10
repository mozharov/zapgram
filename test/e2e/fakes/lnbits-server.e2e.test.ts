import {describe, expect, test} from 'bun:test'
import {createConfig} from '@config'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {limiter} from '@infra/lnbits/lnbits-api.js'
import {createMasterWallet} from '@infra/lnbits/master-wallet.js'
import {UserWallet} from '@infra/lnbits/user-wallet.js'
import {HTTPError} from 'got'
import {mintInvoice} from './bolt11.js'
import {type FakeLnbits, startFakeLnbits} from './lnbits-server.js'

const keys = {adminKey: 'master-admin-key', feeCollectionKey: 'fee-collection-key'}

limiter.updateSettings({
  reservoir: null,
  reservoirRefreshAmount: null,
  reservoirRefreshInterval: null,
  maxConcurrent: null,
  minTime: 0,
})

describe('fake LNbits HTTP server', () => {
  test('serves user and health endpoints through MasterWallet schemas', async () => {
    await withFake(async fake => {
      const master = createMasterWallet(testConfig(fake.url))

      expect((await master.checkStatus()).up_time).toBe('0 days, 0 hours, 1 minutes')
      expect(await master.getUserByUsername('100001')).toBeUndefined()

      const created = await master.createUser('100001')
      if (!created.id) throw new Error('Fake LNbits did not return a user id')
      expect((await master.getUserByUsername('100001'))?.username).toBe('100001')

      const wallet = await master.getWallet(created.id)
      expect(wallet.user).toBe(created.id)
      expect(wallet.balance_msat).toBe(0)
    })
  })

  test('serves BTC/USD rate without an API key', async () => {
    await withFake(async fake => {
      const response = await fetch(`${fake.url}/api/v1/rate/USD`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({price: 100_000, rate: 1000})

      fake.state.btcUsdRate = 42_000
      expect(await (await fetch(`${fake.url}/api/v1/rate/USD`)).json()).toEqual({
        price: 42_000,
        rate: 100_000_000 / 42_000,
      })

      fake.state.btcUsdRate = null
      expect((await fetch(`${fake.url}/api/v1/rate/USD`)).status).toBe(500)
    })
  })

  test('accepts bearer auth without X-Api-Key on users endpoints', async () => {
    await withFake(async fake => {
      const master = createMasterWallet(testConfig(fake.url, {bearerToken: 'e2e-token'}))

      const created = await master.createUser('100001')
      if (!created.id) throw new Error('Fake LNbits did not return a user id')
      expect((await master.getUserByUsername('100001'))?.id).toBe(created.id)
      expect((await master.getWallet(created.id)).user).toBe(created.id)
    })
  })

  test('serves payment endpoints with real clients, schemas and millisatoshi units', async () => {
    await withFake(async fake => {
      const master = createMasterWallet(testConfig(fake.url))
      const payer = userWallet(fake, '100001')
      const receiver = userWallet(fake, '100002')
      fake.state.credit(payer.walletId, 100_000)

      const invoice = await receiver.client.createInvoice({sats: 21, memo: 'e2e transfer'})
      expect(await payer.client.getFeeReserve(invoice.bolt11)).toBe(2000)

      const outgoing = await payer.client.payInvoice(invoice.bolt11)
      expect(outgoing.amount).toBe(-21_000)
      expect((await receiver.client.lookupPayment(invoice.payment_hash)).paid).toBe(true)
      expect(await payer.client.getBalance()).toBe(79_000)
      expect(await receiver.client.getBalance()).toBe(21_000)

      const masterInvoice = await master.createInvoice(10, 60)
      expect((await master.lookupPayment(masterInvoice.payment_hash)).paid).toBe(false)

      const feeInvoice = await master.createFeeCollectionInvoice(5)
      const masterWallet = fake.state.walletByApiKey(keys.adminKey)
      if (!masterWallet) throw new Error('Fake master wallet not found')
      fake.state.credit(masterWallet.id, 5_000)
      expect((await master.payInvoice(feeInvoice.bolt11)).amount).toBe(-5_000)
      expect((await master.lookupPayment(feeInvoice.payment_hash)).paid).toBe(true)

      const createRequest = fake.requests.find(request => {
        const body = asRecord(request.body)
        return body?.out === false && body.amount === 21
      })
      expect(asRecord(createRequest?.body)?.unit).toBe('sat')
      expect(fake.state.wallets.find(wallet => wallet.id === receiver.walletId)?.balanceMsat).toBe(
        21_000,
      )
    })
  })

  test('maps insufficient balance and already-paid 520 responses to domain errors', async () => {
    await withFake(async fake => {
      const payer = userWallet(fake, '100001')
      const receiver = userWallet(fake, '100002')
      const invoice = await receiver.client.createInvoice({sats: 21})

      await expect(payer.client.payInvoice(invoice.bolt11)).rejects.toBeInstanceOf(
        InsufficientFundsError,
      )

      fake.state.credit(payer.walletId, 21_000)
      await payer.client.payInvoice(invoice.bolt11)
      await expect(payer.client.payInvoice(invoice.bolt11)).rejects.toBeInstanceOf(
        InvoiceAlreadyPaidError,
      )
    })
  })

  test('returns an HTTPError with 404 for an unknown payment hash', async () => {
    await withFake(async fake => {
      const master = createMasterWallet(testConfig(fake.url))

      try {
        await master.lookupPayment('f'.repeat(64))
        throw new Error('Expected lookupPayment to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPError)
        if (!(error instanceof HTTPError)) throw error
        expect(error.response.statusCode).toBe(404)
      }
    })
  })

  test('scopes payment lookup to the authenticated wallet', async () => {
    await withFake(async fake => {
      const master = createMasterWallet(testConfig(fake.url))
      const receiver = userWallet(fake, '100002')
      const invoice = await receiver.client.createInvoice({sats: 21})

      try {
        await master.lookupPayment(invoice.payment_hash)
        throw new Error('Expected a cross-wallet lookup to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPError)
        if (!(error instanceof HTTPError)) throw error
        expect(error.response.statusCode).toBe(404)
      }

      expect((await receiver.client.lookupPayment(invoice.payment_hash)).paid).toBe(false)
    })
  })

  test('moves 21,000 msat between user wallets and keeps the total unchanged', async () => {
    await withFake(async fake => {
      const payer = userWallet(fake, '100001')
      const receiver = userWallet(fake, '100002')
      fake.state.credit(payer.walletId, 21_000)
      const before = totalBalance(fake)
      const invoice = await receiver.client.createInvoice({sats: 21})

      const outgoing = await payer.client.payInvoice(invoice.bolt11)

      expect(outgoing.amount).toBe(-21_000)
      expect(await payer.client.getBalance()).toBe(0)
      expect(await receiver.client.getBalance()).toBe(21_000)
      expect(totalBalance(fake)).toBe(before)
    })
  })

  test('matches fee-reserve before the payment-hash route', async () => {
    await withFake(async fake => {
      const wallet = userWallet(fake, '100001')
      const invoice = await wallet.client.createInvoice({sats: 21})

      expect(await wallet.client.getFeeReserve(invoice.bolt11)).toBeNumber()
      expect(fake.requests.at(-1)?.path).toBe('/api/v1/payments/fee-reserve')
    })
  })

  test('quotes a fee reserve for an invoice the fake never issued', async () => {
    await withFake(async fake => {
      const wallet = userWallet(fake, '100001')
      const external = mintInvoice({sats: 100_000, description: 'external'})

      // The reserve scales with the amount: max(2000 msat, 1%). This is the branch
      // wait-for-invoice-review.ts takes for every pasted invoice that is not ours.
      expect(await wallet.client.getFeeReserve(external.bolt11)).toBe(1_000_000)
    })
  })

  test('pays an external invoice, charging the fee reserve on top of the amount', async () => {
    await withFake(async fake => {
      const payer = userWallet(fake, '100001')
      fake.state.credit(payer.walletId, 100_000)
      const external = mintInvoice({sats: 21, description: 'external'})

      const outgoing = await payer.client.payInvoice(external.bolt11)

      expect(outgoing.amount).toBe(-21_000)
      expect(outgoing.fee).toBe(-2000)
      expect(await payer.client.getBalance()).toBe(77_000)
      expect((await payer.client.lookupPayment(external.paymentHash)).paid).toBe(true)
      await expect(payer.client.payInvoice(external.bolt11)).rejects.toBeInstanceOf(
        InvoiceAlreadyPaidError,
      )
    })
  })

  test('refuses an external payment the balance cannot cover including the reserve', async () => {
    await withFake(async fake => {
      const payer = userWallet(fake, '100001')
      fake.state.credit(payer.walletId, 21_000)
      const external = mintInvoice({sats: 21, description: 'external'})

      await expect(payer.client.payInvoice(external.bolt11)).rejects.toBeInstanceOf(
        InsufficientFundsError,
      )
      expect(await payer.client.getBalance()).toBe(21_000)
    })
  })
})

async function withFake(run: (fake: FakeLnbits) => Promise<void>): Promise<void> {
  const fake = await startFakeLnbits(keys)
  try {
    await run(fake)
  } finally {
    fake.stop()
  }
}

function testConfig(url: string, opts: {bearerToken?: string} = {}) {
  return createConfig({
    NODE_ENV: 'test',
    BOT_TOKEN: 'e2e-token',
    BOT_WEBHOOK_SECRET: 'e2e-secret',
    DB_URL: ':memory:',
    LNBITS_URL: url,
    LNBITS_ADMIN_KEY: keys.adminKey,
    LNBITS_FEE_COLLECTION_INVOICE_KEY: keys.feeCollectionKey,
    LNBITS_BEARER_TOKEN: opts.bearerToken,
    HOST: '127.0.0.1',
    CONFIGURE_BOT: 'false',
  })
}

function userWallet(fake: FakeLnbits, username: string) {
  const user = fake.state.ensureUser(username)
  const wallet = fake.state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake wallet not created for ${username}`)
  return {
    walletId: wallet.id,
    client: new UserWallet(wallet.adminkey, wallet.balanceMsat, fake.url),
  }
}

function totalBalance(fake: FakeLnbits): number {
  return fake.state.wallets.reduce((sum, wallet) => sum + wallet.balanceMsat, 0)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}
