import {decodeMintedInvoice, mintInvoice} from './bolt11.js'

/** Боевые значения LNbits: LNBITS_RESERVE_FEE_MIN (мсат) и LNBITS_RESERVE_FEE_PERCENT. */
const RESERVE_FEE_MIN_MSAT = 2000
const RESERVE_FEE_PERCENT = 1

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
  webhook?: string
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
  body?: (body: unknown) => boolean
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

export type FakeWatchOnlyWallet = {
  id: string
  user: string
  masterpub: string
  fingerprint: string
  title: string
  address_no: number
  balance: number
  type: string
  network: string
  meta: string
}

export type FakeSatsPayCharge = {
  id: string
  user: string
  amount: number
  time: number
  timestamp: string
  balance: number
  pending: number
  zeroconf: boolean
  fasttrack: boolean
  paid: boolean
  name: string | null
  description: string | null
  onchainwallet: string
  onchainaddress: string
  lnbitswallet: string | null
  payment_request: string | null
  payment_hash: string | null
  webhook: string | null
  completelink: string | null
  completelinktext: string | null
  extra: string | null
}

export class LnbitsState {
  readonly wallets: FakeWallet[] = []
  readonly payments: FakePayment[] = []
  /** Watch-Only extension wallets (on-chain xpub accounts). */
  readonly watchOnlyWallets: FakeWatchOnlyWallet[] = []
  /** SatsPay charges (on-chain join invoices). */
  readonly satsPayCharges: FakeSatsPayCharge[] = []
  watchOnlyAddressCounter = 0
  /**
   * BTC/USD rate for GET /api/v1/rate/USD.
   * Default 100_000 so 1000 sats → $1.00. Set null to make the rate endpoint fail (500).
   */
  btcUsdRate: number | null = 100_000

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
    webhook,
  }: {
    wallet: FakeWallet
    sats: number
    memo: string
    expirySec: number
    webhook?: string
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
      webhook,
    }
    this.payments.push(payment)
    return payment
  }

  /**
   * Резерв комиссии по произвольному инвойсу. LNbits считает его из суммы декодированного bolt11,
   * поэтому чужой инвойс тут так же легален, как свой.
   */
  feeReserveMsat(bolt11: string): number {
    const decoded = decodeMintedInvoice(bolt11)
    if (!decoded) throw new FakeLnbitsError(520, {status: 'failed', detail: 'Failed to decode.'})
    return Math.max(
      RESERVE_FEE_MIN_MSAT,
      Math.ceil((decoded.amountMsat * RESERVE_FEE_PERCENT) / 100),
    )
  }

  payInvoice({payerWallet, bolt11}: {payerWallet: FakeWallet; bolt11: string}): FakePayment {
    const payment = this.payments.find(candidate => candidate.bolt11 === bolt11 && !candidate.out)
    if (!payment) return this.payExternalInvoice({payerWallet, bolt11})
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
    const outgoing: FakePayment = {
      ...payment,
      walletId: payerWallet.id,
      out: true,
    }
    this.payments.push(outgoing)
    return outgoing
  }

  /**
   * Оплата инвойса, выпущенного вне фейка. Деньги уходят из системы: у плательщика списывается
   * сумма плюс комиссия, кошелька-получателя нет. Поэтому такой платёж ломает
   * expectLedgerBalanced — это ожидаемо, инвариант держится только на внутренних переводах.
   */
  private payExternalInvoice({
    payerWallet,
    bolt11,
  }: {
    payerWallet: FakeWallet
    bolt11: string
  }): FakePayment {
    const decoded = decodeMintedInvoice(bolt11)
    if (!decoded) throw new FakeLnbitsError(520, {status: 'failed', detail: 'Failed to decode.'})

    const feeMsat = this.feeReserveMsat(bolt11)
    if (payerWallet.balanceMsat < decoded.amountMsat + feeMsat) {
      throw new FakeLnbitsError(520, {status: 'failed', detail: 'Insufficient balance.'})
    }
    if (this.payments.some(candidate => candidate.paymentHash === decoded.paymentHash)) {
      throw new FakeLnbitsError(520, {status: 'failed', detail: 'Invoice already paid.'})
    }

    payerWallet.balanceMsat -= decoded.amountMsat + feeMsat
    const payment: FakePayment = {
      paymentHash: decoded.paymentHash,
      bolt11,
      walletId: payerWallet.id,
      amountMsat: decoded.amountMsat,
      out: true,
      paid: true,
      feeMsat,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      memo: decoded.description,
    }
    this.payments.push(payment)
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

  /** Mark a SatsPay charge paid (E2E: simulate mempool detection). */
  markSatsPayChargePaid(chargeId: string, opts?: {balance?: number; txid?: string}): void {
    const charge = this.satsPayCharges.find(c => c.id === chargeId)
    if (!charge) throw new Error(`SatsPay charge ${chargeId} not found`)
    charge.balance = opts?.balance ?? charge.amount
    charge.pending = 0
    charge.paid = true
    if (opts?.txid) charge.extra = JSON.stringify({txids: [opts.txid]})
  }

  failNext(match: FakeRequestMatch, failure: FakeFailure): void {
    this.failures.push({...failure, match, once: true})
  }

  failAlways(match: FakeRequestMatch, failure: FakeFailure): void {
    this.failures.push({...failure, match, once: false})
  }

  takeFailure(method: string, path: string, body?: unknown): FakeFailure | undefined {
    const index = this.failures.findIndex(rule => matches(rule.match, method, path, body))
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

function matches(match: FakeRequestMatch, method: string, path: string, body: unknown): boolean {
  if (match.method.toUpperCase() !== method.toUpperCase()) return false
  const pathMatches = (() => {
    if (typeof match.path === 'string') return match.path === path
    match.path.lastIndex = 0
    return match.path.test(path)
  })()
  return pathMatches && (match.body?.(body) ?? true)
}
