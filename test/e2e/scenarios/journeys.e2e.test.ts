import {afterEach, beforeEach, expect, test} from 'bun:test'
import {ONE_MONTH_IN_MS} from '@core/subscriptions/policy.js'
import type {Subscription, SubscriptionPayment} from '@infra/db/types.js'
import {
  chatChangePriceRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
  chatsPageRoute,
  payLightningRoute,
  paySubscriptionRoute,
  staticCallback,
  subscriptionRenewRoute,
  subscriptionRoute,
  subscriptionsPageRoute,
} from '@telegram/callback-data.js'
import {expectNoConversations, expectNoErrors, expectPayoutsExactly} from '../asserts.js'
import type {FakeWallet} from '../fakes/lnbits-state.js'
import {CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedActivePaidChat, seedSubscription, seedUser} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  groupReply,
  myChatMember,
  privateCallback,
  privateCommand,
  privateText,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.journeys

const PRICE = 1000
const TIP = 100
const FEE = 50
const OWNER_PAYOUT = PRICE - FEE
const OWNER_PROFILE = {
  id: OWNER,
  is_bot: false,
  first_name: 'Chat Owner',
  username: 'chat_owner',
  language_code: 'en' as const,
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E({env: {BOT_USERNAME: 'zap_gram_bot'}})
})

afterEach(async () => {
  await e2e?.dispose()
})

test('a new user receives, observes and tips sats without rebuilding the world', async () => {
  await expectDelta(e2e, () => e2e.send(privateCommand('/start')), {
    db: {users: {added: 1}},
    lnbits: {balances: {[userWalletName(USER_A)]: 0}},
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /Bitcoin Lightning wallet in Telegram/},
      {method: 'sendMessage', to: USER_A, text: /Balance:<\/b> 0 sats/},
    ],
  })

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Balance:<\/b> 0 sats/}],
  })

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.createInvoice)), {
    db: {conversations: {added: 1}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Creating Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Enter the amount of sats/},
    ],
  })

  await expectDelta(e2e, () => e2e.send(privateText(String(PRICE))), {
    db: {conversations: {changed: 1}, pendingInvoices: {added: 1}},
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendPhoto', to: USER_A, text: /Amount: <b>1\D?000 sats(?: \(~\$[^)]+\))?<\/b>/},
    ],
  })

  // Leave the optional Add memo step: cancel keeps the invoice and ends the conversation.
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Balance:<\/b> 0 sats/},
    ],
  })

  const pending = await onlyPendingInvoice()
  payFromOutside(pending.paymentRequest, PRICE)

  await expectDelta(e2e, () => e2e.jobs.pendingInvoices(), {
    db: {pendingInvoices: {removed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /received payment/}],
  })

  await expectDelta(e2e, () => e2e.send(privateCommand('/wallet')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Balance:<\/b> 1\D?000 sats/}],
  })

  const beforeTip = await snapshot(e2e)
  // New users start with 5% voluntary donation (DONATION_DEFAULT_PERCENT) on tips.
  const donationSats = 5
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        groupReply(
          `/tip ${TIP}`,
          {
            text: 'A useful contribution',
            from: {id: USER_B, username: 'user_b', first_name: 'User B'},
          },
          {from: {id: USER_A, username: 'user_a'}},
        ),
      ),
    {
      db: {
        users: {added: 1},
        donations: {added: 1},
        // Migration seeds the singleton; each successful donation bumps totals.
        donationPlatformStats: {changed: 1},
      },
      lnbits: {
        balances: {
          [userWalletName(USER_A)]: -(TIP + donationSats),
          [userWalletName(USER_B)]: TIP,
          'fees wallet': donationSats,
        },
        payments: [
          {out: false, sats: TIP, times: 1},
          {out: true, sats: TIP, times: 1},
          {out: false, sats: donationSats, times: 1},
          {out: true, sats: donationSats, times: 1},
        ],
      },
      telegram: [
        {method: 'deleteMessage', to: CHAT_GROUP},
        {method: 'sendChatAction', to: CHAT_GROUP},
        {method: 'sendMessage', to: CHAT_GROUP, text: /sent 100 sats to @user_b/},
        {method: 'sendMessage', to: USER_B, text: /You received 100 sats/},
      ],
    },
  )

  expectLedgerBalanced(beforeTip, await snapshot(e2e))
  expect(walletFor(USER_A).balanceMsat).toBe((PRICE - TIP - donationSats) * 1000)
  expect(walletFor(USER_B).balanceMsat).toBe(TIP * 1000)
  expectPayoutsExactly(e2e.ln, {toWallet: walletFor(USER_B), sats: TIP, times: 1})
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('a one-time paid chat runs from administrator grant through repeat admission', async () => {
  queueChatOwner()
  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', true)), {
    db: {
      users: {added: 1},
      chats: {
        added: 1,
        match: rows =>
          expect(rows[0]?.after).toMatchObject({
            id: CHAT_GROUP,
            ownerId: OWNER,
            status: 'inactive',
            price: PRICE,
            paymentType: 'one_time',
          }),
      },
    },
    telegram: [
      {method: 'getChatAdministrators'},
      {method: 'sendMessage', to: OWNER, text: /was added to E2E Group/},
    ],
  })

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'active'}), {
          from: OWNER_PROFILE,
        }),
      ),
    {
      db: {chats: {changed: 1}},
      lnbits: {balances: {[userWalletName(OWNER)]: 0}},
      telegram: [{method: 'editMessageText', to: OWNER, text: /Paid access: <b>enabled/}],
    },
  )

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(chatChangePriceRoute.build({chatId: CHAT_GROUP}), {from: OWNER_PROFILE}),
      ),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'deleteMessage', to: OWNER},
        {method: 'sendMessage', to: OWNER, text: /Changing the price of paid access/},
        {method: 'sendMessage', to: OWNER, text: /Enter the amount of sats/},
      ],
    },
  )

  await expectDelta(e2e, () => e2e.send(privateText(String(PRICE), {from: OWNER_PROFILE})), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: OWNER},
      {method: 'sendMessage', to: OWNER, text: /set to 1\D?000 sats/},
      {method: 'sendMessage', to: OWNER, text: /Price: <b>1\D?000 sats/},
    ],
  })

  creditExternal(USER_A, PRICE)
  const payment = await requestJoin('one_time')
  await payJoinFromBalance(payment)
  await settleJoin(payment, null, 1)

  const beforeRepeat = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'approveChatJoinRequest', to: CHAT_GROUP}],
  })
  expectLedgerBalanced(beforeRepeat, await snapshot(e2e))

  const subscription = await requiredSubscription()
  expect(subscription.endsAt).toBeNull()
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([
    expect.objectContaining({id: payment.id, attemptStatus: 'processed', refundedAt: null}),
  ])
  expectPayouts(1)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('a monthly subscription renews, expires and can begin again in one world', async () => {
  await seedUser(e2e, {id: OWNER, username: 'chat_owner', firstName: 'Chat Owner'})
  await seedUser(e2e, {id: USER_A, username: 'subscriber', firstName: 'Subscriber'})
  await seedActivePaidChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    price: PRICE,
    paymentType: 'one_time',
  })
  creditExternal(USER_A, PRICE * 3)

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(chatPaymentTypeRoute.build({chatId: CHAT_GROUP, paymentType: 'monthly'}), {
          from: OWNER_PROFILE,
        }),
      ),
    {
      db: {chats: {changed: 1}},
      telegram: [{method: 'editMessageText', to: OWNER, text: /Payment type: <b>monthly/}],
    },
  )

  const payment = await requestJoin('monthly', {userAdded: false})
  await payJoinFromBalance(payment)
  await settleJoin(payment, 'monthly', 1)

  const firstEnd = requiredEnd(await requiredSubscription())
  const firstExpiringEnd = new Date(Date.now() + 60 * 60 * 1000)
  await e2e.container.subscriptions.update((await requiredSubscription()).id, {
    endsAt: firstExpiringEnd,
  })
  const beforeRenewal = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {subscriptions: {changed: 1}},
    lnbits: {
      balances: {
        [userWalletName(USER_A)]: -PRICE,
        'master wallet': 0,
        [userWalletName(OWNER)]: OWNER_PAYOUT,
        'fees wallet': FEE,
      },
      payments: [
        {out: false, sats: PRICE, times: 1},
        {out: true, sats: PRICE, times: 1},
        ...payoutEvents(),
      ],
    },
    telegram: renewalTelegram(),
  })
  expectLedgerBalanced(beforeRenewal, await snapshot(e2e))

  const renewed = await requiredSubscription()
  expect(firstEnd.getTime()).toBeGreaterThan(Date.now())
  expect(Math.floor(requiredEnd(renewed).getTime() / 1000)).toBe(
    Math.floor((firstExpiringEnd.getTime() + ONE_MONTH_IN_MS) / 1000),
  )
  expect(renewed.notificationSent).toBe(false)
  expectPayouts(2)

  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(subscriptionRenewRoute.build({subscriptionId: renewed.id}), {
          from: subscriberProfile(),
        }),
      ),
    {
      db: {subscriptions: {changed: 1}},
      telegram: [{method: 'editMessageText', to: USER_A, text: /Auto-renewal: <b>disabled/}],
    },
  )

  const manualEnd = new Date(Date.now() + 60 * 60 * 1000)
  await e2e.container.subscriptions.update(renewed.id, {
    endsAt: manualEnd,
    notificationSent: false,
  })
  await expectDelta(e2e, () => e2e.jobs.expiringSubscriptions(), {
    db: {
      subscriptions: {changed: 1},
      subscriptionIntents: {added: 1},
      subscriptionPayments: {added: 1},
    },
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [{method: 'sendPhoto', to: USER_A, text: /expires in 24 hours/}],
  })

  const manualPayment = await onlySubscriptionPayment()
  expect(manualPayment).toMatchObject({kind: 'renewal', subscriptionType: 'monthly'})
  expect((await requiredSubscription()).notificationSent).toBe(true)

  const manualInvoice = e2e.ln.state.payments.find(
    candidate => candidate.paymentHash === manualPayment.paymentHash && !candidate.out,
  )
  if (!manualInvoice) throw new Error('Manual renewal invoice not found in fake LNbits')
  manualInvoice.expiresAt = new Date(Date.now() - 1000)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptionIntents: {removed: 1},
      subscriptionPayments: {removed: 1},
    },
  })

  await e2e.container.subscriptions.update(renewed.id, {endsAt: new Date(Date.now() - 1000)})
  await expectDelta(e2e, () => e2e.jobs.expiredSubscriptions(), {
    db: {subscriptions: {removed: 1}},
    telegram: [
      {method: 'banChatMember', to: CHAT_GROUP},
      {method: 'unbanChatMember', to: CHAT_GROUP},
    ],
  })

  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
  })
  const rejoinChooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: subscriberProfile(),
          messageId: Number(rejoinChooser?.message_id ?? 1),
        }),
      ),
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {added: 1},
      },
      lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
      telegram: [
        {method: 'editMessageText', text: /Access to private community/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )

  expect(await e2e.db.query.subscriptionsTable.findMany()).toEqual([])
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({id: payment.id, attemptStatus: 'processed'}),
      expect.objectContaining({attemptStatus: 'pending'}),
    ]),
  )
  expectPayouts(2)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('private keyboard navigation keeps one world through screens and conversations', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedActivePaidChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, paymentType: 'monthly'})
  const subscription = await seedSubscription(e2e, {
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    endsAt: new Date(Date.now() + ONE_MONTH_IN_MS),
  })

  await expectEditedScreen(staticCallback.wallet, /Wallet/)
  await expectEditedScreen(staticCallback.settings, /Settings/)
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toContain(staticCallback.connectNwc)
  await expectEditedScreen(staticCallback.wallet, /Wallet/)
  await expectEditedScreen(staticCallback.sendMenu, /Send payment/)
  expect(callbackDataOf(e2e.tg.last('editMessageText'))).toContain(staticCallback.sendToUser)

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.sendToUser)), {
    db: {conversations: {added: 1}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Sending sats to a Telegram user/},
      {method: 'sendMessage', to: USER_A, text: /Enter the username/},
    ],
  })
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Wallet/},
    ],
  })

  await expectEditedScreen(chatsPageRoute.build({page: 1}), /Your chats with the ability/)
  await expectEditedScreen(chatRoute.build({chatId: CHAT_GROUP}), /E2E paid chat/)

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatChangePriceRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Changing the price/},
        {method: 'sendMessage', to: USER_A, text: /Enter the amount of sats/},
      ],
    },
  )
  await expectDelta(e2e, () => e2e.send(privateText('1234')), {
    db: {chats: {changed: 1}, conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /set to 1\D?234 sats/},
      {method: 'sendMessage', to: USER_A, text: /Price: <b>1\D?234 sats/},
    ],
  })

  await expectEditedScreen(chatCustomMessageRoute.build({chatId: CHAT_GROUP}), /Current message/)
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatEditCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Enter a custom message in Russian/},
      ],
    },
  )
  await expectDelta(e2e, () => e2e.send(privateText('Особое приветствие')), {
    db: {conversations: {changed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Enter a custom message in English/},
    ],
  })
  await expectDelta(e2e, () => e2e.send(privateText('A special welcome')), {
    db: {chats: {changed: 1}, conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Custom message has been updated/},
      {method: 'sendMessage', to: USER_A, text: /E2E paid chat/},
    ],
  })
  await expectEditedScreen(chatCustomMessageRoute.build({chatId: CHAT_GROUP}), /Current message/)
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatRemoveCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {chats: {changed: 1}},
      telegram: [{method: 'editMessageText', to: USER_A, text: /E2E paid chat/}],
    },
  )
  await expectEditedScreen(chatRoute.build({chatId: CHAT_GROUP}), /E2E paid chat/)
  await expectEditedScreen(chatsPageRoute.build({page: 1}), /Your chats with the ability/)

  await expectEditedScreen(subscriptionsPageRoute.build({page: 1}), /Your subscriptions/)
  await expectEditedScreen(
    subscriptionRoute.build({subscriptionId: subscription.id}),
    /E2E paid chat/,
  )
  await expectDelta(
    e2e,
    () =>
      e2e.send(privateCallback(subscriptionRenewRoute.build({subscriptionId: subscription.id}))),
    {
      db: {subscriptions: {changed: 1}},
      telegram: [{method: 'editMessageText', to: USER_A, text: /Auto-renewal: <b>disabled/}],
    },
  )
  await expectEditedScreen(subscriptionsPageRoute.build({page: 1}), /Your subscriptions/)
  await expectEditedScreen(staticCallback.help, /Lightning Network/)
  await expectEditedScreen(staticCallback.wallet, /Wallet/)

  const chat = await e2e.container.chats.getOrThrow(CHAT_GROUP)
  expect(chat).toMatchObject({price: 1234, customMessageRu: null, customMessageEn: null})
  expect(await requiredSubscription()).toMatchObject({id: subscription.id, autoRenew: false})
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('an invoice conversation survives a container restart on the same database', async () => {
  await e2e.dispose()
  e2e = await createE2E({mode: 'file', env: {BOT_USERNAME: 'zap_gram_bot'}})

  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.createInvoice)), {
    db: {users: {added: 1}, conversations: {added: 1}},
    lnbits: {balances: {[userWalletName(USER_A)]: 0}},
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Creating Lightning invoice/},
      {method: 'sendMessage', to: USER_A, text: /Enter the amount of sats/},
    ],
  })

  await expectDelta(e2e, () => e2e.send(privateText(String(PRICE))), {
    db: {conversations: {changed: 1}, pendingInvoices: {added: 1}},
    lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendChatAction', to: USER_A},
      {method: 'sendPhoto', to: USER_A, text: /Amount: <b>1\D?000 sats(?: \(~\$[^)]+\))?<\/b>/},
    ],
  })

  const beforeRestart = await snapshot(e2e)
  await e2e.restart()
  expect(await snapshot(e2e)).toEqual(beforeRestart)

  // Conversation is still open on the optional Add memo step after restart.
  await expectDelta(e2e, () => e2e.send(privateCallback(staticCallback.cancel)), {
    db: {conversations: {removed: 1}},
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'sendMessage', to: USER_A, text: /Action canceled/},
      {method: 'sendMessage', to: USER_A, text: /Balance:<\/b> 0 sats/},
    ],
  })

  expect(await e2e.db.query.pendingInvoicesTable.findMany()).toHaveLength(1)
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

async function requestJoin(
  type: 'one_time' | 'monthly',
  options: {userAdded?: boolean} = {},
): Promise<SubscriptionPayment> {
  await expectDelta(e2e, () => e2e.send(joinUpdate()), {
    db: {
      ...(options.userAdded === false ? {} : {users: {added: 1}}),
    },
    telegram: [{method: 'sendMessage', to: USER_A, text: /Choose a payment method/}],
  })
  const chooser = e2e.tg.last('sendMessage')
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(payLightningRoute.build({chatId: CHAT_GROUP}), {
          from: subscriberProfile(),
          messageId: Number(chooser?.message_id ?? 1),
        }),
      ),
    {
      db: {
        subscriptionIntents: {added: 1},
        subscriptionPayments: {added: 1},
      },
      lnbits: {payments: [{out: false, sats: PRICE, times: 1}]},
      telegram: [
        {method: 'editMessageText', text: /Access to private community/},
        {method: 'answerCallbackQuery'},
      ],
    },
  )
  const payment = await onlySubscriptionPayment()
  expect(payment).toMatchObject({
    userId: USER_A,
    chatId: CHAT_GROUP,
    price: PRICE,
    subscriptionType: type,
    kind: 'join',
    settledAt: null,
  })
  return payment
}

async function payJoinFromBalance(payment: SubscriptionPayment): Promise<void> {
  const before = await snapshot(e2e)
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        privateCallback(paySubscriptionRoute.build({paymentId: payment.id, from: 'wallet'}), {
          from: subscriberProfile(),
        }),
      ),
    {
      lnbits: {
        balances: {[userWalletName(USER_A)]: -PRICE, 'master wallet': PRICE},
        payments: [
          {out: false, sats: PRICE, times: 1},
          {out: true, sats: PRICE, times: 1},
        ],
      },
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendMessage', to: USER_A, text: /Payment completed/},
      ],
    },
  )
  expectLedgerBalanced(before, await snapshot(e2e))
}

async function settleJoin(
  payment: SubscriptionPayment,
  expectedEnd: 'monthly' | null,
  payoutTimes: number,
): Promise<void> {
  const before = await snapshot(e2e)
  await expectDelta(e2e, () => e2e.jobs.subscriptionPayments(), {
    db: {
      subscriptions: {added: 1},
      subscriptionIntents: {
        changed: 1,
        match: rows =>
          expect(rows[0]?.after).toMatchObject({
            status: 'completed',
            winnerAttemptId: payment.id,
          }),
      },
      subscriptionPayments: {
        changed: 1,
        match: rows =>
          expect(rows[0]?.after).toMatchObject({
            id: payment.id,
            attemptStatus: 'processed',
            processedAt: expect.any(Date),
          }),
      },
    },
    lnbits: {
      balances: {
        'master wallet': -PRICE,
        [userWalletName(OWNER)]: OWNER_PAYOUT,
        'fees wallet': FEE,
      },
      payments: payoutEvents(),
    },
    telegram: [
      {method: 'approveChatJoinRequest', to: CHAT_GROUP},
      {method: 'sendMessage', to: USER_A, text: /Access to the community/},
      {method: 'sendMessage', to: OWNER, text: /New subscription payment/},
    ],
  })
  expectLedgerBalanced(before, await snapshot(e2e))
  const subscription = await requiredSubscription()
  if (expectedEnd === null) expect(subscription.endsAt).toBeNull()
  else {
    const end = requiredEnd(subscription).getTime()
    expect(end).toBeGreaterThanOrEqual(Date.now() + ONE_MONTH_IN_MS - 2000)
    expect(end).toBeLessThanOrEqual(Date.now() + ONE_MONTH_IN_MS)
  }
  expectPayouts(payoutTimes)
}

async function expectEditedScreen(data: string, text: RegExp): Promise<void> {
  await expectDelta(e2e, () => e2e.send(privateCallback(data)), {
    telegram: [{method: 'editMessageText', to: USER_A, text}],
  })
}

function joinUpdate() {
  return chatJoinRequest('supergroup', {from: subscriberProfile()})
}

function subscriberProfile() {
  return {
    id: USER_A,
    username: 'subscriber',
    first_name: 'Subscriber',
    language_code: 'en' as const,
  }
}

function queueChatOwner(): void {
  e2e.tg.reply('getChatAdministrators', [
    {status: 'creator', user: OWNER_PROFILE, is_anonymous: false},
  ])
}

function payoutEvents() {
  return [
    {out: false, sats: OWNER_PAYOUT, times: 1},
    {out: true, sats: OWNER_PAYOUT, times: 1},
    {out: false, sats: FEE, times: 1},
    {out: true, sats: FEE, times: 1},
  ]
}

function renewalTelegram() {
  return [
    {method: 'approveChatJoinRequest', to: CHAT_GROUP},
    {method: 'sendMessage', to: USER_A, text: /subscription .* (?:renewed|extended)/},
    {method: 'sendMessage', to: OWNER, text: /New subscription payment/},
  ]
}

function payFromOutside(bolt11: string, sats: number): void {
  const payer = e2e.ln.state.ensureUser('external-payer')
  const wallet = e2e.ln.state.walletsOfUser(payer.id)[0]
  if (!wallet) throw new Error('External payer wallet not found')
  e2e.ln.state.credit(wallet.id, sats * 1000)
  e2e.ln.state.payInvoice({payerWallet: wallet, bolt11})
}

function creditExternal(userId: number, sats: number): void {
  const user = e2e.ln.state.ensureUser(String(userId))
  const wallet = e2e.ln.state.walletsOfUser(user.id)[0]
  if (!wallet) throw new Error(`Fake LNbits wallet not found for ${userId}`)
  e2e.ln.state.credit(wallet.id, sats * 1000)
}

function walletFor(userId: number): FakeWallet {
  const user = e2e.ln.state.getUserByUsername(String(userId))
  const wallet = user ? e2e.ln.state.walletsOfUser(user.id)[0] : undefined
  if (!wallet) throw new Error(`Fake LNbits wallet not found for ${userId}`)
  return wallet
}

function userWalletName(userId: number): string {
  return `${userId} wallet`
}

function expectPayouts(times: number): void {
  expectPayoutsExactly(e2e.ln, {
    toWallet: userWalletName(OWNER),
    sats: OWNER_PAYOUT,
    times,
  })
  expectPayoutsExactly(e2e.ln, {toWallet: 'fees wallet', sats: FEE, times})
}

async function requiredSubscription(): Promise<Subscription> {
  const subscription = await e2e.container.subscriptions.findByUserAndChat(USER_A, CHAT_GROUP)
  if (!subscription) throw new Error('Subscription not found')
  return subscription
}

function requiredEnd(subscription: Subscription): Date {
  if (!subscription.endsAt) throw new Error('Monthly subscription has no end date')
  return subscription.endsAt
}

async function onlySubscriptionPayment(): Promise<SubscriptionPayment> {
  const rows = (await e2e.db.query.subscriptionPaymentsTable.findMany()).filter(
    payment => payment.attemptStatus === 'pending',
  )
  const payment = rows[0]
  if (rows.length !== 1 || !payment) {
    throw new Error(`Expected one subscription payment, got ${rows.length}`)
  }
  return payment
}

async function onlyPendingInvoice() {
  const rows = await e2e.db.query.pendingInvoicesTable.findMany()
  const invoice = rows[0]
  if (rows.length !== 1 || !invoice)
    throw new Error(`Expected one pending invoice, got ${rows.length}`)
  return invoice
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  const markup = payload?.reply_markup as
    | {inline_keyboard?: {callback_data?: string}[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat().flatMap(button => button.callback_data ?? [])
}
