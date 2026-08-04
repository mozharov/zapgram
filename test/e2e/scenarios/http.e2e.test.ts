import {afterEach, beforeEach, expect, test} from 'bun:test'
import {buildLnbitsPaymentWebhookUrl} from '@core/lnbits/payment-webhook-url.js'
import {createRouter} from '@http/router.js'
import {pendingInvoicesTable} from '@infra/db/schema.js'
import {
  extractPaymentHashFromLnbitsWebhook,
  handleLnbitsPaymentWebhook,
} from '@modules/lnbits-webhook/handle-payment-webhook.js'
import {expectNoErrors, expectWorldUnchanged} from '../asserts.js'
import {USER_A, USER_B} from '../fixtures/ids.js'
import {seedPendingInvoice, seedUser} from '../fixtures/seed.js'
import {privateCommand, privateText, type TestUpdate} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.http

/**
 * HTTP edge of the process: health check, Telegram webhook secret, request id stamping, and
 * rejection of garbage bodies — all via `createRouter(...).handle(Request)` without opening a
 * socket. Update delivery still goes through the real bot stack and the fake Telegram API.
 *
 * LNbits payment webhooks share the same BOT_WEBHOOK_SECRET (in the path) and settle pending
 * invoices immediately; cron remains the fallback when the POST never arrives.
 */

const SECRET_HEADER = 'x-telegram-bot-api-secret-token'
const WEBHOOK_URL = 'http://local/bot'
const HEALTH_URL = 'http://local/'

let e2e: E2E
let router: ReturnType<typeof createRouter>

beforeEach(async () => {
  e2e = await createE2E({env: {LOG_LEVEL: 'info'}})
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'en',
  })
  router = createRouter({
    // Same cast as createApp → startServer: HTTP is flavor-agnostic.
    bot: e2e.container.bot as never,
    config: e2e.container.config,
    log: e2e.container.log,
    lnbitsPaymentWebhook: {
      extractPaymentHash: extractPaymentHashFromLnbitsWebhook,
      handle: handleLnbitsPaymentWebhook,
    },
  })
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Health ---

test('GET / returns 200 ok', async () => {
  const response = await router.handle(new Request(HEALTH_URL))

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
  expectNoErrors(e2e.logs)
})

// --- Webhook delivery ---

test('POST /bot with the correct secret delivers the update to the bot', async () => {
  const update = privateCommand('/wallet', {from: {id: USER_A}})

  await expectDelta(
    e2e,
    async () => {
      const response = await postBot(update)
      expect(response.status).toBe(200)
    },
    {
      telegram: [{method: 'sendMessage', to: USER_A, text: /<b>Balance:<\/b>/}],
    },
  )

  expectNoErrors(e2e.logs)
})

test('POST /bot with a wrong or missing secret leaves the world unchanged', async () => {
  const update = privateCommand('/wallet', {from: {id: USER_A}})
  const before = await snapshot(e2e)
  const telegramMark = e2e.tg.calls.length

  const wrong = await postBot(update, {secret: 'not-the-secret'})
  expect(wrong.status).toBe(401)

  const missing = await postBot(update, {secret: null})
  expect(missing.status).toBe(401)

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(e2e.tg.calls).toHaveLength(telegramMark)
})

// --- Request id ---

test('POST /bot stamps reqId on the update and the handler log carries it', async () => {
  // Undecodable bolt11 trips the error boundary, which logs through ctx.log — the child logger
  // that middleware builds from `update.reqId`. Matching that id with the HTTP request log is
  // proof the router wrote the same reqId onto the body before grammY ran the update.
  e2e.logs.length = 0
  const update = privateText('lnbc1invalid', {from: {id: USER_A}})

  const response = await postBot(update)
  expect(response.status).toBe(200)

  const botError = e2e.logs.find(
    log => (log.level === 'error' || log.level === 50) && log.msg === 'Bot error',
  )
  const requestLog = e2e.logs.find(
    log => typeof log.msg === 'string' && String(log.msg).startsWith('POST /bot'),
  )

  expect(botError, 'expected Bot error log with reqId').toBeDefined()
  expect(requestLog, 'expected HTTP request log with reqId').toBeDefined()
  expect(typeof botError?.reqId).toBe('string')
  expect(botError?.reqId).toMatch(/^[a-z0-9]{8}$/)
  expect(requestLog?.reqId).toBe(botError?.reqId)
  // Fixture reqIds look like `e2e-N`; the router must overwrite them with its own.
  expect(String(botError?.reqId)).not.toMatch(/^e2e-/)
})

// --- Malformed bodies ---

test('invalid JSON and empty body return 4xx and leave the process usable', async () => {
  const before = await snapshot(e2e)
  const telegramMark = e2e.tg.calls.length

  const invalidJson = await postRaw('{not-json')
  expect(invalidJson.status).toBeGreaterThanOrEqual(400)
  expect(invalidJson.status).toBeLessThan(500)

  const emptyBody = await postRaw('')
  expect(emptyBody.status).toBeGreaterThanOrEqual(400)
  expect(emptyBody.status).toBeLessThan(500)

  const afterErrors = await snapshot(e2e)
  expectWorldUnchanged(before, afterErrors)
  expect(e2e.tg.calls).toHaveLength(telegramMark)

  // Process still serves health and real updates after the bad traffic.
  const health = await router.handle(new Request(HEALTH_URL))
  expect(health.status).toBe(200)
  expect(await health.text()).toBe('ok')

  await expectDelta(
    e2e,
    async () => {
      const response = await postBot(privateCommand('/wallet', {from: {id: USER_A}}))
      expect(response.status).toBe(200)
    },
    {
      telegram: [{method: 'sendMessage', to: USER_A, text: /<b>Balance:<\/b>/}],
    },
  )
})

// --- LNbits payment webhook ---

test('POST /lnbits/webhook/:secret notifies a paid pending invoice once', async () => {
  const pending = await seedPendingInvoice(e2e, {sats: 21})
  const payment = e2e.ln.state.payments.find(p => p.paymentHash === pending.paymentHash)
  expect(payment).toBeDefined()
  if (!payment) throw new Error('seeded LNbits payment missing')
  payment.paid = true

  await expectDelta(
    e2e,
    async () => {
      const response = await postLnbitsWebhook({payment_hash: pending.paymentHash})
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ok: true, result: 'invoice_notified'})
    },
    {
      db: {pendingInvoices: {removed: 1}},
      telegram: [
        {method: 'sendMessage', to: USER_A, text: /You received payment for a Lightning invoice/},
      ],
    },
  )

  const second = await postLnbitsWebhook({payment_hash: pending.paymentHash})
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual({ok: true, result: 'unknown'})
  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
  expect(e2e.tg.of('sendMessage')).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

test('POST /lnbits/webhook with a wrong secret leaves the world unchanged', async () => {
  const pending = await seedPendingInvoice(e2e, {sats: 21})
  const before = await snapshot(e2e)
  const telegramMark = e2e.tg.calls.length

  const response = await postLnbitsWebhook(
    {payment_hash: pending.paymentHash},
    {secret: 'not-the-secret'},
  )
  expect(response.status).toBe(401)

  const after = await snapshot(e2e)
  expectWorldUnchanged(before, after)
  expect(e2e.tg.calls).toHaveLength(telegramMark)
})

test('a second webhook after claim is a no-op (no double notify)', async () => {
  await seedUser(e2e, {
    id: USER_B,
    username: 'user_b',
    firstName: 'User B',
    languageCode: 'en',
  })
  const pending = await seedPendingInvoice(e2e, {userId: USER_B, sats: 21})
  const payment = e2e.ln.state.payments.find(p => p.paymentHash === pending.paymentHash)
  expect(payment).toBeDefined()
  if (!payment) throw new Error('seeded LNbits payment missing')
  payment.paid = true

  // Webhook path claims first — the same claim the internal-pay conversation uses after payInvoice.
  expect(await handleLnbitsPaymentWebhook(pending.paymentHash)).toBe('invoice_notified')
  // Row is gone; a late webhook (or internal-pay claim) must not message again.
  expect(await handleLnbitsPaymentWebhook(pending.paymentHash)).toBe('unknown')
  expect(await e2e.container.invoices.claimByPaymentHash(pending.paymentHash)).toBeUndefined()

  expect(e2e.tg.of('sendMessage').filter(c => c.chat_id === USER_B)).toHaveLength(1)
  expect(await e2e.db.select().from(pendingInvoicesTable)).toEqual([])
  expectNoErrors(e2e.logs)
})

// --- helpers ---

function telegramBody(update: TestUpdate): string {
  // Real Telegram payloads have no reqId; the router is responsible for stamping one.
  const {reqId: _reqId, ...body} = update
  return JSON.stringify(body)
}

async function postBot(update: TestUpdate, opts?: {secret?: string | null}): Promise<Response> {
  const headers = new Headers({'content-type': 'application/json'})
  if (opts?.secret !== null) {
    headers.set(SECRET_HEADER, opts?.secret ?? e2e.container.config.BOT_WEBHOOK_SECRET)
  }
  return router.handle(
    new Request(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: telegramBody(update),
    }),
  )
}

async function postRaw(body: string): Promise<Response> {
  return router.handle(
    new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SECRET_HEADER]: e2e.container.config.BOT_WEBHOOK_SECRET,
      },
      body,
    }),
  )
}

async function postLnbitsWebhook(body: unknown, opts?: {secret?: string}): Promise<Response> {
  const secret = opts?.secret ?? e2e.container.config.BOT_WEBHOOK_SECRET
  const url = buildLnbitsPaymentWebhookUrl('http://local', secret)
  return router.handle(
    new Request(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    }),
  )
}
