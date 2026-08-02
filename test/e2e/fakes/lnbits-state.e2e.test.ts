import {describe, expect, test} from 'bun:test'
import {mintInvoice} from './bolt11.js'
import {createLnbitsState, FakeLnbitsError} from './lnbits-state.js'

const keys = {adminKey: 'master-admin-key', feeCollectionKey: 'fee-collection-key'}

describe('LnbitsState', () => {
  test('moves balance between wallets without changing the total', () => {
    const state = createLnbitsState(keys)
    const payer = walletFor(state, '100001')
    const receiver = walletFor(state, '100002')
    state.credit(payer.id, 21_000)
    const invoice = state.createInvoice({wallet: receiver, sats: 21, memo: 'tip', expirySec: 60})
    const before = totalBalance(state)

    state.payInvoice({payerWallet: payer, bolt11: invoice.bolt11})

    expect(payer.balanceMsat).toBe(0)
    expect(receiver.balanceMsat).toBe(21_000)
    expect(totalBalance(state)).toBe(before)
    expect(state.payments.filter(payment => payment.out)).toHaveLength(1)
  })

  test('does not move balance when the same invoice is paid twice', () => {
    const state = createLnbitsState(keys)
    const payer = walletFor(state, '100001')
    const receiver = walletFor(state, '100002')
    state.credit(payer.id, 42_000)
    const invoice = state.createInvoice({wallet: receiver, sats: 21, memo: '', expirySec: 60})
    state.payInvoice({payerWallet: payer, bolt11: invoice.bolt11})
    const afterFirstPayment = state.snapshot()

    expect(() => state.payInvoice({payerWallet: payer, bolt11: invoice.bolt11})).toThrow(
      FakeLnbitsError,
    )
    expect(state.snapshot()).toEqual(afterFirstPayment)
  })

  test('sends money out of the system when the invoice is not its own', () => {
    const state = createLnbitsState(keys)
    const payer = walletFor(state, '100001')
    state.credit(payer.id, 50_000)
    const external = mintInvoice({sats: 21, description: 'external'})
    const feeMsat = state.feeReserveMsat(external.bolt11)

    const payment = state.payInvoice({payerWallet: payer, bolt11: external.bolt11})

    expect(payment.out).toBe(true)
    expect(payment.paid).toBe(true)
    expect(payment.feeMsat).toBe(feeMsat)
    expect(payer.balanceMsat).toBe(50_000 - 21_000 - feeMsat)
    expect(totalBalance(state)).toBe(payer.balanceMsat)
  })

  test('resolves master, fee collection and user API keys', () => {
    const state = createLnbitsState(keys)
    const userWallet = walletFor(state, '100001')

    expect(state.walletByApiKey(keys.adminKey)?.username).toBe('master')
    expect(state.walletByApiKey(keys.feeCollectionKey)?.username).toBe('fees')
    expect(state.walletByApiKey(userWallet.adminkey)).toBe(userWallet)
    expect(state.walletByApiKey(userWallet.inkey)).toBe(userWallet)
  })

  test('rejects payments when the payer balance is insufficient', () => {
    const state = createLnbitsState(keys)
    const payer = walletFor(state, '100001')
    const receiver = walletFor(state, '100002')
    const invoice = state.createInvoice({wallet: receiver, sats: 21, memo: '', expirySec: 60})

    expect(() => state.payInvoice({payerWallet: payer, bolt11: invoice.bolt11})).toThrow(
      FakeLnbitsError,
    )
    expect(payer.balanceMsat).toBe(0)
    expect(receiver.balanceMsat).toBe(0)
    expect(invoice.paid).toBe(false)
  })
})

function walletFor(state: ReturnType<typeof createLnbitsState>, username: string) {
  const user = state.ensureUser(username)
  const wallet = state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not created for ${username}`)
  return wallet
}

function totalBalance(state: ReturnType<typeof createLnbitsState>) {
  return state.wallets.reduce((total, wallet) => total + wallet.balanceMsat, 0)
}
