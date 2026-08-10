import {afterEach, beforeEach, expect, test} from 'bun:test'
import {createRouter} from '@http/router.js'
import {
  onchainChatPaymentsTable,
  subscriptionPaymentsTable,
  subscriptionsTable,
} from '@infra/db/schema.js'
import {handleSatsPayWebhook} from '@modules/onchain/handle-satspay-webhook.js'
import {payLightningRoute, payOnchainRoute} from '@telegram/callback-data.js'
import {eq} from 'drizzle-orm'
import {expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import {CHAT_GROUP, OWNER, USER_A} from '../fixtures/ids.js'
import {seedUser} from '../fixtures/seed.js'
import {chatJoinRequest, privateCallback} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage['onchain-join']

/**
 * On-chain join rail: enable xpub → join shows Pay on-chain → charge → webhook → grant.
 * Asserts zero LN owner/fee payouts (funds stay on owner's chain addresses).
 */

const PRICE = 1000
const MASTERPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'

let e2e: E2E
let router: ReturnType<typeof createRouter>

beforeEach(async () => {
  e2e = await createE2E()
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Owner'})
  // Match privateUser() fixture defaults so attachUser does not rewrite the row.
  await seedUser(e2e, {
    id: USER_A,
    username: 'user_a',
    firstName: 'User A',
    languageCode: 'en',
  })
  router = createRouter({
    bot: e2e.container.bot as never,
    config: e2e.container.config,
    log: e2e.container.log,
    satsPayWebhook: {handle: handleSatsPayWebhook},
  })
})

afterEach(async () => {
  await e2e.dispose()
})

test('enable on-chain, pay on-chain, webhook grants access with zero LN payouts', async () => {
  await seedOnchainChat()
  const before = await snapshot(e2e)

  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
  })

  const joinMessage = e2e.tg.last('sendMessage')
  if (!joinMessage?.reply_markup) throw new Error('join chooser missing markup')
  expect(callbackDatas(joinMessage)).toEqual([
    payLightningRoute.build({chatId: CHAT_GROUP}),
    payOnchainRoute.build({chatId: CHAT_GROUP}),
  ])
  // Lightning + Bitcoin share one row; no balance button without funds.
  const markup = joinMessage.reply_markup as {inline_keyboard?: {text?: string}[][]}
  expect(markup.inline_keyboard?.map(row => row.map(b => b.text))).toEqual([
    ['⚡ Lightning', '⛓ Bitcoin'],
  ])
  const onchainData = payOnchainRoute.build({chatId: CHAT_GROUP})

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(onchainData, {
          from: {id: USER_A},
          messageId: Number(joinMessage.message_id ?? 1),
        }),
      ),
    {
      db: {onchainChatPayments: {added: 1}},
      telegram: [
        {method: 'editMessageText', text: /On-chain payment/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  const [onchainRow] = await e2e.db.select().from(onchainChatPaymentsTable)
  if (!onchainRow) throw new Error('onchain payment missing')
  expect(onchainRow).toMatchObject({
    chatId: CHAT_GROUP,
    userId: USER_A,
    amountSats: PRICE,
    status: 'pending',
  })
  expect(onchainRow.address).toMatch(/^bc1q/)
  expect(e2e.ln.state.satsPayCharges).toHaveLength(1)
  const charge = e2e.ln.state.satsPayCharges[0]
  if (!charge) throw new Error('SatsPay charge missing')
  expect(charge.zeroconf).toBe(true)
  expect(charge.amount).toBe(PRICE)
  expect(charge.webhook).toContain('/satspay/webhook/')

  const edited = e2e.tg.last('editMessageText')
  expect(String(edited?.text)).toContain(onchainRow.address)
  expect(callbackDatas(edited).find(d => d.startsWith('pay-lightning:'))).toBe(
    payLightningRoute.build({chatId: CHAT_GROUP}),
  )

  e2e.ln.state.markSatsPayChargePaid(charge.id, {txid: 'txid-e2e-onchain'})
  const paidBody = {
    ...charge,
    paid: true,
    balance: PRICE,
    extra: JSON.stringify({txids: ['txid-e2e-onchain']}),
  }
  const secret = e2e.container.config.BOT_WEBHOOK_SECRET

  await expectDelta(
    e2e,
    async () => {
      const response = await router.handle(
        new Request(`http://local/satspay/webhook/${secret}`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(paidBody),
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ok: true, result: 'settled'})
    },
    {
      db: {
        onchainChatPayments: {changed: 1},
        subscriptionIntents: {added: 1},
        subscriptionPayments: {added: 1},
        subscriptions: {added: 1},
      },
      telegram: [
        {method: 'approveChatJoinRequest', to: CHAT_GROUP},
        {method: 'editMessageText', text: /Access to the community/},
        {method: 'sendMessage', to: OWNER, text: /on-chain subscription payment/i},
      ],
    },
  )

  const [paidOnchain] = await e2e.db.select().from(onchainChatPaymentsTable)
  expect(paidOnchain?.status).toBe('paid')
  expect(paidOnchain?.txid).toBe('txid-e2e-onchain')

  const subs = await e2e.db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, USER_A))
  expect(subs).toHaveLength(1)

  const after = await snapshot(e2e)
  expectLedgerBalanced(before, after)
  expectNoOwnerFeePayouts()
  expectNoErrors(e2e.logs)
})

test('cron poll grants when charge is paid without webhook', async () => {
  await seedOnchainChat()

  await e2e.send(joinUpdate())
  const joinMessage = e2e.tg.last('sendMessage')
  await e2e.send(
    privateCallback(payOnchainRoute.build({chatId: CHAT_GROUP}), {
      from: {id: USER_A},
      messageId: Number(joinMessage?.message_id ?? 1),
    }),
  )

  const charge = e2e.ln.state.satsPayCharges[0]
  if (!charge) throw new Error('charge missing')
  e2e.ln.state.markSatsPayChargePaid(charge.id, {txid: 'txid-cron'})

  await expectDelta(e2e, () => e2e.jobs.onchainCharges(), {
    db: {
      onchainChatPayments: {changed: 1},
      subscriptionIntents: {added: 1},
      subscriptionPayments: {added: 1},
      subscriptions: {added: 1},
    },
    telegram: [
      {method: 'approveChatJoinRequest', to: CHAT_GROUP},
      {method: 'editMessageText', text: /Access to the community/},
      {method: 'sendMessage', to: OWNER},
    ],
  })

  expectNoOwnerFeePayouts()
  expectNoErrors(e2e.logs)
})

test('pay-lightning shows the LN invoice on the same message after on-chain', async () => {
  await seedOnchainChat()
  await e2e.send(joinUpdate())
  const joinMessage = e2e.tg.last('sendMessage')
  expect(String(joinMessage?.text)).not.toContain('lnbc')
  await e2e.send(
    privateCallback(payOnchainRoute.build({chatId: CHAT_GROUP}), {
      from: {id: USER_A},
      messageId: Number(joinMessage?.message_id ?? 1),
    }),
  )
  await e2e.send(
    privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
      from: {id: USER_A},
      messageId: Number(joinMessage?.message_id ?? 1),
    }),
  )
  const restored = e2e.tg.last('editMessageText')
  expect(String(restored?.text)).toContain('lnbc')
  const payments = await e2e.db.select().from(subscriptionPaymentsTable)
  const lnPayments = payments.filter(p => !p.paymentHash.startsWith('onchain:'))
  expect(lnPayments).toHaveLength(1)
  const lnPayment = lnPayments[0]
  if (!lnPayment) throw new Error('LN payment missing')
  expect(String(restored?.text)).toContain(lnPayment.paymentRequest)
  expectNoErrors(e2e.logs)
})

async function seedOnchainChat() {
  await e2e.container.chats.createOrUpdate({
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E on-chain chat',
    type: 'supergroup',
    price: PRICE,
    status: 'active',
    paymentType: 'one_time',
  })
  const enable = await e2e.container.onchainEnableService.enable(
    await e2e.container.chats.getOrThrow(CHAT_GROUP),
    MASTERPUB,
  )
  expect(enable.status).toBe('enabled')
}

function joinUpdate() {
  return chatJoinRequest('supergroup', {
    from: {id: USER_A},
    chat: {id: CHAT_GROUP, title: 'E2E on-chain chat'},
  })
}

function callbackDatas(payload: {reply_markup?: unknown} | undefined): string[] {
  const markup = payload?.reply_markup as
    | {inline_keyboard?: {callback_data?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? [])
    .flat()
    .flatMap(b => (b.callback_data ? [b.callback_data] : []))
}

/** On-chain rail must not create owner/fee Lightning payout invoices. */
function expectNoOwnerFeePayouts() {
  expectPayoutsExactly(e2e.ln, {toWallet: 'master wallet', sats: PRICE, times: 0})
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees wallet', sats: Math.floor(PRICE * 0.05), times: 0})
}
