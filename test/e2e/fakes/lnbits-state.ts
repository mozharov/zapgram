import {mintInvoice} from './bolt11.js'

export type FakeWallet = {
  id: string
  userId: string
  username: string
  name: string
  adminkey: string
  inkey: string
  balanceMsat: number
}

export type FakePayment = {
  paymentHash: string
  bolt11: string
  walletId: string
  amountMsat: number
  out: boolean
  paid: boolean
  feeMsat: number
  expiresAt: Date
  memo: string
}

export type FakeUser = {
  id: string
  username: string
}

export type FakeFailure = {
  status: number
  body: unknown
}

export type FakeRequestMatch = {
  method: string
  path: string | RegExp
}

type FailureRule = FakeFailure & {
  match: FakeRequestMatch
  once: boolean
}

export type LnbitsSnapshot = {
  wallets: FakeWallet[]
  payments: FakePayment[]
}

export class FakeLnbitsError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Fake LNbits request failed with status ${status}`)
  }
}

export class LnbitsState {
  readonly wallets: FakeWallet[] = []
  readonly payments: FakePayment[] = []

  private readonly users: FakeUser[] = []
  private readonly failures: FailureRule[] = []
  private readonly masterWallet: FakeWallet
  private readonly feeCollectionWallet: FakeWallet
  private nextUserId = 1
  private nextWalletId = 1

  constructor(
    private readonly adminKey: string,
    private readonly feeCollectionKey: string,
  ) {
    const masterUser = this.createUserRecord('master')
    const feeUser = this.createUserRecord('fees')
    this.masterWallet = this.createWallet(
      masterUser.id,
      masterUser.username,
      adminKey,
      'master-in-key',
    )
    this.feeCollectionWallet = this.createWallet(
      feeUser.id,
      feeUser.username,
      feeCollectionKey,
      'fees-in-key',
    )
  }

  walletByApiKey(key: string | undefined): FakeWallet | undefined {
    if (!key) return undefined
    if (key === this.adminKey) return this.masterWallet
    if (key === this.feeCollectionKey) return this.feeCollectionWallet
    return this.wallets.find(wallet => wallet.adminkey === key || wallet.inkey === key)
  }

  ensureUser(username: string): FakeUser {
    const existing = this.getUserByUsername(username)
    if (existing) return existing

    const user = this.createUserRecord(username)
    this.createWallet(user.id, username)
    return user
  }

  getUserByUsername(username: string): FakeUser | undefined {
    return this.users.find(user => user.username === username)
  }

  walletsOfUser(userId: string): FakeWallet[] {
    return this.wallets.filter(wallet => wallet.userId === userId)
  }

  createInvoice({
    wallet,
    sats,
    memo,
    expirySec,
  }: {
    wallet: FakeWallet
    sats: number
    memo: string
    expirySec: number
  }): FakePayment {
    const minted = mintInvoice({sats, description: memo, expirySec})
    const payment: FakePayment = {
      paymentHash: minted.paymentHash,
      bolt11: minted.bolt11,
      walletId: wallet.id,
      amountMsat: sats * 1000,
      out: false,
      paid: false,
      feeMsat: 0,
      expiresAt: new Date(Date.now() + expirySec * 1000),
      memo,
    }
    this.payments.push(payment)
    return payment
  }

  payInvoice({payerWallet, bolt11}: {payerWallet: FakeWallet; bolt11: string}): FakePayment {
    const payment = this.payments.find(candidate => candidate.bolt11 === bolt11)
    if (!payment) throw new FakeLnbitsError(404, {detail: 'Invoice not found.'})
    if (payment.paid) {
      throw new FakeLnbitsError(520, {status: 'failed', detail: 'Invoice already paid.'})
    }

    const totalMsat = payment.amountMsat + payment.feeMsat
    if (payerWallet.balanceMsat < totalMsat) {
      throw new FakeLnbitsError(520, {status: 'failed', detail: 'Insufficient balance.'})
    }

    const receiverWallet = this.wallets.find(wallet => wallet.id === payment.walletId)
    if (!receiverWallet) throw new Error(`Fake LNbits wallet ${payment.walletId} not found`)

    payerWallet.balanceMsat -= totalMsat
    receiverWallet.balanceMsat += payment.amountMsat
    payment.paid = true
    return payment
  }

  credit(walletId: string, msats: number): void {
    const wallet = this.wallets.find(candidate => candidate.id === walletId)
    if (!wallet) throw new Error(`Fake LNbits wallet ${walletId} not found`)
    wallet.balanceMsat += msats
  }

  snapshot(): LnbitsSnapshot {
    return {
      wallets: this.wallets.map(wallet => ({...wallet})),
      payments: this.payments.map(payment => ({
        ...payment,
        expiresAt: new Date(payment.expiresAt),
      })),
    }
  }

  failNext(match: FakeRequestMatch, failure: FakeFailure): void {
    this.failures.push({...failure, match, once: true})
  }

  failAlways(match: FakeRequestMatch, failure: FakeFailure): void {
    this.failures.push({...failure, match, once: false})
  }

  takeFailure(method: string, path: string): FakeFailure | undefined {
    const index = this.failures.findIndex(rule => matches(rule.match, method, path))
    if (index === -1) return undefined

    const rule = this.failures[index]
    if (!rule) return undefined
    if (rule.once) this.failures.splice(index, 1)
    return {status: rule.status, body: rule.body}
  }

  private createWallet(
    userId: string,
    username: string,
    adminkey?: string,
    inkey?: string,
  ): FakeWallet {
    const id = `w-${this.nextWalletId++}`
    const wallet: FakeWallet = {
      id,
      userId,
      username,
      name: `${username} wallet`,
      adminkey: adminkey ?? `${id}-admin-key`,
      inkey: inkey ?? `${id}-invoice-key`,
      balanceMsat: 0,
    }
    this.wallets.push(wallet)
    return wallet
  }

  private createUserRecord(username: string): FakeUser {
    const user: FakeUser = {id: `u-${this.nextUserId++}`, username}
    this.users.push(user)
    return user
  }
}

export function createLnbitsState(opts: {adminKey: string; feeCollectionKey: string}): LnbitsState {
  return new LnbitsState(opts.adminKey, opts.feeCollectionKey)
}

function matches(match: FakeRequestMatch, method: string, path: string): boolean {
  if (match.method.toUpperCase() !== method.toUpperCase()) return false
  if (typeof match.path === 'string') return match.path === path
  match.path.lastIndex = 0
  return match.path.test(path)
}
