import {
  createLnbitsState,
  type FakeLnbitsError,
  type FakePayment,
  type FakeWallet,
  type LnbitsState,
} from './lnbits-state.js'

export type FakeLnbitsRequest = {
  method: string
  path: string
  body?: unknown
}

export type FakeLnbits = {
  url: string
  state: LnbitsState
  requests: FakeLnbitsRequest[]
  stop(): void
}

export async function startFakeLnbits(opts: {
  adminKey: string
  feeCollectionKey: string
}): Promise<FakeLnbits> {
  const state = createLnbitsState(opts)
  const requests: FakeLnbitsRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await readBody(request)
      const recorded: FakeLnbitsRequest = {method: request.method, path: url.pathname}
      if (body !== undefined) recorded.body = body
      requests.push(recorded)

      const injectedFailure = state.takeFailure(request.method, url.pathname, body)
      if (injectedFailure) return json(injectedFailure.body, injectedFailure.status)

      try {
        return route({request, url, body, state, opts})
      } catch (error) {
        if (isFakeLnbitsError(error)) return json(error.body, error.status)
        throw error
      }
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    requests,
    stop() {
      server.stop(true)
    },
  }
}

function route({
  request,
  url,
  body,
  state,
  opts,
}: {
  request: Request
  url: URL
  body: unknown
  state: LnbitsState
  opts: {adminKey: string; feeCollectionKey: string}
}): Response {
  const {method} = request
  const path = url.pathname

  if (path.startsWith('/users/api/v1/') && !hasUsersApiAuth(request, opts.adminKey)) {
    return json({detail: 'Unauthorized.'}, 401)
  }

  if (method === 'POST' && path === '/users/api/v1/user') {
    const username = bodyValue(body, 'username')
    if (typeof username !== 'string') return json({detail: 'username is required'}, 400)
    return json({id: state.ensureUser(username).id})
  }

  const userWalletMatch = path.match(/^\/users\/api\/v1\/user\/([^/]+)\/wallet$/)
  if (method === 'GET' && userWalletMatch) {
    const userId = userWalletMatch[1]
    if (!userId) return json({detail: 'User not found.'}, 404)
    return json(state.walletsOfUser(userId).map(walletResponse))
  }

  if (method === 'GET' && path === '/users/api/v1/user') {
    const username = url.searchParams.get('username') ?? ''
    const user = state.getUserByUsername(username)
    if (!user) return json({data: [], total: 0})
    const wallets = state.walletsOfUser(user.id)
    return json({
      data: [
        {
          id: user.id,
          username: user.username,
          password_hash: null,
          pubkey: null,
          email: null,
          extra: {},
          created_at: nowIso(),
          updated_at: nowIso(),
          is_super_user: false,
          is_admin: false,
          transaction_count: state.payments.filter(payment =>
            wallets.some(wallet => wallet.id === payment.walletId),
          ).length,
          wallet_count: wallets.length,
          balance_msat: wallets.reduce((sum, wallet) => sum + wallet.balanceMsat, 0),
          last_payment: null,
        },
      ],
      total: 1,
    })
  }

  if (method === 'GET' && path === '/api/v1/health') {
    return json({server_time: Math.floor(Date.now() / 1000), up_time: '0 days, 0 hours, 1 minutes'})
  }

  // Public rate endpoint (no API key). null rate simulates LNbits outage for hide-suffix path.
  // Shape matches real LNbits: price = USD/BTC, rate = sats per 1 USD.
  if (method === 'GET' && path === '/api/v1/rate/USD') {
    if (state.btcUsdRate === null) return json({detail: 'Rate unavailable.'}, 500)
    const price = state.btcUsdRate
    return json({price, rate: 100_000_000 / price})
  }

  // This exact route must be checked before /api/v1/payments/{hash}.
  if (method === 'GET' && path === '/api/v1/payments/fee-reserve') {
    const wallet = authenticatedWallet(request, state)
    if (!wallet) return json({detail: 'Unauthorized.'}, 401)
    const bolt11 = url.searchParams.get('invoice')
    if (!bolt11) return json({detail: 'invoice is required'}, 400)
    return json({fee_reserve: state.feeReserveMsat(bolt11)})
  }

  if (method === 'POST' && path === '/api/v1/payments') {
    const wallet = authenticatedWallet(request, state)
    if (!wallet) return json({detail: 'Unauthorized.'}, 401)

    if (bodyValue(body, 'out') === false) {
      const amount = bodyValue(body, 'amount')
      if (typeof amount !== 'number') return json({detail: 'amount is required'}, 400)
      const memo = bodyValue(body, 'memo')
      const expiry = bodyValue(body, 'expiry')
      const webhook = bodyValue(body, 'webhook')
      const payment = state.createInvoice({
        wallet,
        sats: amount,
        memo: typeof memo === 'string' ? memo : '',
        expirySec: typeof expiry === 'number' ? expiry : 60 * 60,
        webhook: typeof webhook === 'string' ? webhook : undefined,
      })
      return json(paymentResponse(payment))
    }

    if (bodyValue(body, 'out') === true) {
      const bolt11 = bodyValue(body, 'bolt11')
      if (typeof bolt11 !== 'string') return json({detail: 'bolt11 is required'}, 400)
      const payment = state.payInvoice({payerWallet: wallet, bolt11})
      return json(paymentResponse(payment, {out: true, wallet}))
    }

    return json({detail: 'out is required'}, 400)
  }

  const paymentMatch = path.match(/^\/api\/v1\/payments\/([^/]+)$/)
  if (method === 'GET' && paymentMatch) {
    const wallet = authenticatedWallet(request, state)
    if (!wallet) return json({detail: 'Unauthorized.'}, 401)
    const paymentHash = paymentMatch[1]
    const payment = state.payments.find(
      candidate => candidate.paymentHash === paymentHash && candidate.walletId === wallet.id,
    )
    if (!payment) return json({detail: 'Payment not found.'}, 404)
    return json({
      paid: payment.paid,
      status: payment.paid ? 'success' : 'pending',
      preimage: payment.paid ? '00'.repeat(32) : null,
      details: paymentResponse(payment),
    })
  }

  if (method === 'GET' && path === '/api/v1/wallet') {
    const wallet = authenticatedWallet(request, state)
    if (!wallet) return json({detail: 'Unauthorized.'}, 401)
    return json({name: wallet.name, balance: wallet.balanceMsat, id: wallet.id})
  }

  // --- Watch-Only + SatsPay (on-chain join) ---
  if (method === 'POST' && path === '/watchonly/api/v1/wallet') {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const masterpub = bodyValue(body, 'masterpub')
    const title = bodyValue(body, 'title')
    const network = bodyValue(body, 'network')
    if (typeof masterpub !== 'string' || masterpub.length < 10) {
      return json({detail: 'masterpub required'}, 400)
    }
    const networkLabel = typeof network === 'string' ? network : 'Mainnet'
    const existing = state.watchOnlyWallets.find(
      w => w.masterpub === masterpub.trim() && w.network === networkLabel,
    )
    if (existing) return json(existing)
    const wallet = {
      id: `wo-${state.watchOnlyWallets.length + 1}`,
      user: 'e2e-user',
      masterpub: masterpub.trim(),
      fingerprint: `fp${state.watchOnlyWallets.length + 1}`,
      title: typeof title === 'string' ? title : 'wallet',
      address_no: 0,
      balance: 0,
      type: 'wpkh',
      network: networkLabel,
      meta: '{}',
    }
    state.watchOnlyWallets.push(wallet)
    return json(wallet)
  }

  if (method === 'GET' && path === '/watchonly/api/v1/wallet') {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const network = url.searchParams.get('network') ?? 'Mainnet'
    return json(state.watchOnlyWallets.filter(w => w.network === network))
  }

  const woWalletMatch = path.match(/^\/watchonly\/api\/v1\/wallet\/([^/]+)$/)
  if (method === 'GET' && woWalletMatch) {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const wallet = state.watchOnlyWallets.find(w => w.id === woWalletMatch[1])
    if (!wallet) return json({detail: 'Not found'}, 404)
    return json(wallet)
  }
  if (method === 'DELETE' && woWalletMatch) {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const id = woWalletMatch[1]
    const idx = state.watchOnlyWallets.findIndex(w => w.id === id)
    if (idx >= 0) state.watchOnlyWallets.splice(idx, 1)
    return new Response(null, {status: 204})
  }

  if (method === 'POST' && path === '/satspay/api/v1/charge') {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const onchainwallet = bodyValue(body, 'onchainwallet')
    const amount = bodyValue(body, 'amount')
    const time = bodyValue(body, 'time')
    const description = bodyValue(body, 'description')
    if (typeof onchainwallet !== 'string' || typeof amount !== 'number') {
      return json({detail: 'onchainwallet and amount required'}, 400)
    }
    const wo = state.watchOnlyWallets.find(w => w.id === onchainwallet)
    if (!wo) return json({detail: 'Watch-Only wallet not found'}, 400)
    state.watchOnlyAddressCounter += 1
    const n = state.watchOnlyAddressCounter
    const address =
      wo.network === 'Testnet'
        ? `tb1qe2e${String(n).padStart(30, '0')}`
        : `bc1qe2e${String(n).padStart(30, '0')}`
    const charge = {
      id: `ch-e2e-${n}`,
      user: 'e2e-user',
      amount,
      time: typeof time === 'number' ? time : 2880,
      timestamp: nowIso(),
      balance: 0,
      pending: 0,
      zeroconf: bodyValue(body, 'zeroconf') === true,
      fasttrack: false,
      paid: false,
      name:
        typeof bodyValue(body, 'name') === 'string' ? (bodyValue(body, 'name') as string) : null,
      description: typeof description === 'string' ? description : null,
      onchainwallet,
      onchainaddress: address,
      lnbitswallet: null,
      payment_request: null,
      payment_hash: null,
      webhook:
        typeof bodyValue(body, 'webhook') === 'string'
          ? (bodyValue(body, 'webhook') as string)
          : null,
      completelink: null,
      completelinktext: null,
      extra: null as string | null,
    }
    state.satsPayCharges.push(charge)
    return json(charge)
  }

  const chargeMatch = path.match(/^\/satspay\/api\/v1\/charge\/([^/]+)$/)
  if (method === 'GET' && chargeMatch) {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const charge = state.satsPayCharges.find(c => c.id === chargeMatch[1])
    if (!charge) return json({detail: 'Not found'}, 404)
    return json(charge)
  }
  if (method === 'DELETE' && chargeMatch) {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const id = chargeMatch[1]
    const idx = state.satsPayCharges.findIndex(c => c.id === id)
    if (idx >= 0) state.satsPayCharges.splice(idx, 1)
    return new Response(null, {status: 204})
  }

  const balanceMatch = path.match(/^\/satspay\/api\/v1\/charge\/balance\/([^/]+)$/)
  if (method === 'PUT' && balanceMatch) {
    if (!hasAdminKey(request, opts.adminKey)) return json({detail: 'Unauthorized.'}, 401)
    const charge = state.satsPayCharges.find(c => c.id === balanceMatch[1])
    if (!charge) return json({detail: 'Not found'}, 404)
    if (charge.paid) return json({detail: 'Charge is already paid.'}, 400)
    return json(charge)
  }

  return json({detail: 'Not found.'}, 404)
}

function hasAdminKey(request: Request, adminKey: string): boolean {
  return request.headers.get('X-Api-Key') === adminKey
}

function paymentResponse(
  payment: FakePayment,
  outgoing?: {out: true; wallet: FakeWallet},
): Record<string, unknown> {
  const timestamp = nowIso()
  return {
    checking_id: payment.paymentHash,
    payment_hash: payment.paymentHash,
    wallet_id: outgoing?.wallet.id ?? payment.walletId,
    amount: outgoing ? -payment.amountMsat : payment.amountMsat,
    fee: outgoing ? -payment.feeMsat : payment.feeMsat,
    bolt11: payment.bolt11,
    status: payment.paid ? 'success' : 'pending',
    memo: payment.memo,
    expiry: payment.expiresAt.toISOString(),
    webhook: payment.webhook ?? null,
    preimage: payment.paid ? '00'.repeat(32) : null,
    time: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    extra: {},
  }
}

function walletResponse(wallet: FakeWallet): Record<string, unknown> {
  return {
    id: wallet.id,
    user: wallet.userId,
    name: wallet.name,
    adminkey: wallet.adminkey,
    inkey: wallet.inkey,
    created_at: nowIso(),
    updated_at: nowIso(),
    balance_msat: wallet.balanceMsat,
  }
}

function authenticatedWallet(request: Request, state: LnbitsState): FakeWallet | undefined {
  return state.walletByApiKey(request.headers.get('X-Api-Key') ?? undefined)
}

function hasUsersApiAuth(request: Request, adminKey: string): boolean {
  if (request.headers.get('X-Api-Key') === adminKey) return true
  return request.headers.get('Authorization')?.startsWith('Bearer ') === true
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const text = await request.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function bodyValue(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object') return undefined
  return Reflect.get(body, key)
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {status})
}

function nowIso(): string {
  return new Date().toISOString()
}

function isFakeLnbitsError(error: unknown): error is FakeLnbitsError {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    'body' in error
  )
}
