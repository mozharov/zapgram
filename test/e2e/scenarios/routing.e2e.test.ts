import {afterEach, beforeEach, expect, test} from 'bun:test'
import {usersTable} from '@infra/db/schema.js'
import type {Chat, Subscription} from '@infra/db/types.js'
import {parameterizedRoutes, staticCallback} from '@telegram/callback-data.js'
import {expectNoErrors} from '../asserts.js'
import {CHAT_CHANNEL, CHAT_GROUP, USER_A} from '../fixtures/ids.js'
import {seedChat, seedSubscription, seedUser} from '../fixtures/seed.js'
import {groupText, privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.routing

/**
 * Routing for the fully composed bot.
 *
 * Every assertion is an observable Bot API call plus a complete DB/LNbits delta. No terminal
 * handler or middleware is replaced: each update passes through the real container, middleware
 * chain, repositories and HTTP fakes.
 *
 * The point of this file is *which handler ran*, not what it computed — so each case is chosen so
 * that its output cannot be produced by any other route, and in particular not by
 * `unknownCallback` or the `on('message')` wallet fallback.
 */

/** A fresh user, so `users.added: 1` is the whole DB delta of a first-touch update. */
const FIRST_TOUCH = {
  db: {users: {added: 1}},
  lnbits: {balances: {'100001 wallet': 0}},
} as const

/** Nothing in the world knows this id, so the route lands on its "not found" branch. */
const UNKNOWN_UUID = '0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f'

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Commands ---

const commandCases: {command: string; telegram: {method: string; to: number; text?: RegExp}[]}[] = [
  {
    command: '/start',
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendRichMessage', to: USER_A, text: /Bitcoin Lightning wallet/},
    ],
  },
  {
    command: '/help',
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendRichMessage', to: USER_A, text: /Lightning Network/},
    ],
  },
  // /wallet is the one command whose output cannot distinguish routing from the fallback: the
  // terminal on('message') handler IS walletCommand.
  {
    command: '/wallet',
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendRichMessage', to: USER_A, text: /Wallet/},
    ],
  },
  {
    command: '/donate',
    telegram: [
      {method: 'deleteMessage', to: USER_A},
      {method: 'sendRichMessage', to: USER_A, text: /Support ZapGram|zapgram@getalby.com/},
    ],
  },
]

for (const {command, telegram} of commandCases) {
  test(`command ${command} reaches its handler`, async () => {
    await expectDelta(e2e, () => e2e.send(privateCommand(command)), {...FIRST_TOUCH, telegram})
    expectNoErrors(e2e.logs)
  })
}

test('the private commands are the ones the bot registers', () => {
  expect(commandCases.map(item => item.command).sort()).toEqual([
    '/donate',
    '/help',
    '/start',
    '/wallet',
  ])
})

for (const command of ['/settings', '/chats', '/subscriptions', '/feature']) {
  test(`${command} no longer has a dedicated handler`, async () => {
    await expectDelta(e2e, () => e2e.send(privateCommand(command)), {
      ...FIRST_TOUCH,
      telegram: [
        {method: 'deleteMessage', to: USER_A},
        {method: 'sendRichMessage', to: USER_A, text: /Wallet/},
      ],
    })
    expectNoErrors(e2e.logs)
  })
}

// --- Static callback routes ---

const staticCases: {
  data: string
  methods: string[]
  text: RegExp
  conversation?: boolean
}[] = [
  {data: staticCallback.wallet, methods: ['editMessageText'], text: /Wallet/},
  {
    data: staticCallback.openMenu,
    methods: ['answerCallbackQuery', 'sendRichMessage'],
    text: /Wallet/,
  },
  {data: staticCallback.settings, methods: ['editMessageText'], text: /NWC/},
  {data: staticCallback.help, methods: ['editMessageText'], text: /Lightning Network/},
  {data: staticCallback.groupSettings, methods: ['editMessageText'], text: /Chats/},
  {data: staticCallback.sendMenu, methods: ['editMessageText'], text: /Send payment/},
  {
    data: staticCallback.sendToUser,
    methods: ['editMessageText'],
    text: /Enter the username/,
    conversation: true,
  },
  {
    data: staticCallback.createInvoice,
    methods: ['editMessageText'],
    text: /Enter the amount/,
    conversation: true,
  },
  // Only meaningful inside creatingInvoice after the QR; alone it is an unknown button.
  {
    data: staticCallback.addInvoiceMemo,
    methods: ['deleteMessage', 'answerCallbackQuery'],
    text: /Unknown button/,
  },
  {
    data: staticCallback.payInvoice,
    methods: ['editMessageText'],
    text: /Lightning invoice/,
    conversation: true,
  },
  {
    data: staticCallback.connectNwc,
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /NWC URL/,
    conversation: true,
  },
  {
    data: staticCallback.disconnectNwc,
    methods: ['deleteMessage', 'sendMessage', 'sendRichMessage'],
    text: /Wallet disconnected/,
  },
  {
    data: staticCallback.toggleNwcTips,
    methods: ['answerCallbackQuery', 'editMessageText'],
    text: /NWC/,
  },
  {data: staticCallback.cancel, methods: ['sendRichMessage'], text: /Wallet/},
  {
    data: staticCallback.donationSettings,
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /Auto % on payments/,
  },
  {
    data: staticCallback.donate,
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /zapgram@getalby.com/,
  },
  {
    data: staticCallback.donateCustom,
    methods: ['answerCallbackQuery', 'deleteMessage', 'sendMessage'],
    text: /amount in sats/,
    conversation: true,
  },
  {
    data: staticCallback.donationCustomPercent,
    methods: ['answerCallbackQuery', 'sendMessage'],
    text: /auto-donation percent|percent \(0/,
    conversation: true,
  },
  {
    data: staticCallback.featureRequest,
    methods: ['answerCallbackQuery', 'sendMessage'],
    text: /What should we build/,
    conversation: true,
  },
  // Conversation-only feature-request fund buttons.
  {
    data: staticCallback.featureFundSkip,
    methods: ['deleteMessage', 'answerCallbackQuery'],
    text: /Unknown button/,
  },
  {
    data: staticCallback.donateMonthlyMenu,
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /Monthly donation/,
  },
  {
    data: staticCallback.donateMonthlyDisable,
    methods: ['answerCallbackQuery', 'editMessageText'],
    text: /zapgram@getalby.com|Support ZapGram/,
  },
  {
    data: staticCallback.donateMonthlyCustom,
    methods: ['answerCallbackQuery', 'deleteMessage', 'sendMessage'],
    text: /monthly donation amount/,
    conversation: true,
  },
]

for (const {data, methods, text, conversation} of staticCases) {
  test(`callback "${data}" reaches its handler, not unknownCallback`, async () => {
    await expectDelta(e2e, () => e2e.send(privateCallback(data)), {
      db: {
        users: {added: 1},
        ...(conversation ? {conversations: {added: 1}} : {}),
      },
      lnbits: FIRST_TOUCH.lnbits,
      telegram: methods,
    })
    expect(joinedOutput()).toMatch(text)
    expectNoErrors(e2e.logs)
  })
}

// --- Parameterized callback routes ---

type World = {chat: Chat; subscription: Subscription}

/**
 * One world for every parameterized route. It is deliberately over-specified — active paid access,
 * monthly payments, both custom messages set — so that each route produces a screen no sibling
 * route can produce. A shared "chat not found" answer would prove the module was reached but not
 * *which* of its eight handlers ran.
 */
async function seedRoutingWorld(): Promise<World> {
  const owner = await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  const chat = await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: owner.id,
    status: 'active',
    paymentType: 'monthly',
    customMessageEn: 'Custom EN message',
    customMessageRu: 'Custom RU message',
  })
  const subscription = await seedSubscription(e2e, {
    userId: owner.id,
    chatId: chat.id,
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
  return {chat, subscription}
}

const parameterizedCases: {
  route: string
  data: (world: World) => string
  methods: string[]
  text: RegExp
  db?: Parameters<typeof expectDelta>[2]['db']
  lnbits?: Parameters<typeof expectDelta>[2]['lnbits']
}[] = [
  {
    route: 'chats-page',
    data: () => 'chats:1',
    methods: ['editMessageText'],
    text: /Your chats with the ability/,
  },
  {
    route: 'chat',
    data: ({chat}) => `chat:${chat.id}`,
    methods: ['editMessageText'],
    text: /E2E paid chat/,
  },
  {
    route: 'chat-paid-access',
    data: ({chat}) => `chat:${chat.id}:off-paid`,
    methods: ['editMessageText'],
    text: /Paid access: <b>disabled/,
    db: {chats: {changed: 1}},
  },
  {
    route: 'chat-paid-access',
    data: ({chat}) => `chat:${chat.id}:on-paid`,
    methods: ['editMessageText'],
    text: /Paid access: <b>enabled/,
  },
  {
    route: 'chat-payment-type',
    data: ({chat}) => `chat:${chat.id}:turn-one_time`,
    methods: ['editMessageText'],
    text: /Payment type: <b>one-time/,
    db: {chats: {changed: 1}},
  },
  {
    route: 'chat-payment-type',
    data: ({chat}) => `chat:${chat.id}:turn-monthly`,
    methods: ['editMessageText'],
    text: /Payment type: <b>monthly/,
  },
  {
    route: 'chat-change-price',
    data: ({chat}) => `chat:${chat.id}:change-price`,
    methods: ['editMessageText'],
    text: /Changing the price of paid access/,
    db: {conversations: {added: 1}},
  },
  {
    route: 'chat-custom-message',
    data: ({chat}) => `chat:${chat.id}:custom-message`,
    methods: ['editMessageText'],
    text: /Join request message[\s\S]*RU: <b>custom[\s\S]*EN: <b>custom/,
  },
  {
    route: 'chat-edit-custom-message',
    data: ({chat}) => `chat:${chat.id}:edit-custom-message`,
    methods: ['editMessageText'],
    text: /Join request message/,
  },
  {
    route: 'chat-custom-message-edit',
    data: ({chat}) => `chat:${chat.id}:custom-message:edit:ru`,
    methods: ['deleteMessage', 'sendMessage'],
    text: /Enter a custom message in Russian/,
    db: {conversations: {added: 1}},
  },
  {
    route: 'chat-custom-message-preview',
    data: ({chat}) => `chat:${chat.id}:custom-message:preview:en`,
    methods: ['editMessageText'],
    text: /Preview · EN[\s\S]*Custom EN message/,
  },
  {
    route: 'chat-custom-message-reset',
    data: ({chat}) => `chat:${chat.id}:custom-message:reset:ru`,
    methods: ['editMessageText'],
    text: /Join request message[\s\S]*RU: <b>default[\s\S]*EN: <b>custom/,
    db: {chats: {changed: 1}},
  },
  {
    route: 'chat-remove-custom-message',
    data: ({chat}) => `chat:${chat.id}:remove-custom-message`,
    methods: ['editMessageText'],
    text: /E2E paid chat/,
    db: {chats: {changed: 1}},
  },
  {
    route: 'chat-onchain-enable',
    data: ({chat}) => `chat:${chat.id}:onchain-enable`,
    methods: ['deleteMessage', 'sendMessage'],
    text: /Enable on-chain payments/,
    db: {conversations: {added: 1}},
  },
  {
    route: 'chat-onchain-disable',
    data: ({chat}) => `chat:${chat.id}:onchain-disable`,
    methods: ['answerCallbackQuery', 'editMessageText'],
    text: /On-chain pay: <b>disabled/,
  },
  {
    route: 'pay-onchain',
    data: ({chat}) => `pay-onchain:${chat.id}`,
    // Chat has no xpub — handler answers disabled and does not create a charge.
    methods: ['answerCallbackQuery'],
    text: /.*/,
  },
  {
    route: 'pay-lightning',
    data: ({chat}) => `pay-lightning:${chat.id}`,
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /lnbc/,
    db: {
      subscriptionIntents: {added: 1},
      subscriptionPayments: {added: 1},
    },
    lnbits: {payments: [{out: false, sats: 1000, times: 1}]},
  },
  {
    route: 'pay-join-balance',
    data: ({chat}) => `pay-join-balance:${chat.id}:wallet`,
    // No balance — answers insufficient and does not mint.
    methods: ['answerCallbackQuery'],
    text: /.*/,
  },
  {
    route: 'subscriptions-page',
    data: () => 'subscriptions:1',
    methods: ['editMessageText'],
    text: /Your subscriptions to private chats/,
  },
  {
    route: 'subscription',
    data: ({subscription}) => `subscription:${subscription.id}`,
    methods: ['editMessageText'],
    text: /Subscription to chat "E2E paid chat"/,
  },
  {
    route: 'subscription-renew',
    data: ({subscription}) => `subscription:${subscription.id}:renew`,
    methods: ['editMessageText'],
    text: /Auto-renewal: <b>disabled/,
    db: {subscriptions: {changed: 1}},
  },
  {
    route: 'pay-subscription',
    data: () => `pay-sub:${UNKNOWN_UUID}:wallet`,
    methods: ['editMessageText'],
    text: /subscription invoice has expired/,
  },
  {
    route: 'pay-subscription',
    data: () => `pay-sub:${UNKNOWN_UUID}:nwc`,
    methods: ['editMessageText'],
    text: /subscription invoice has expired/,
  },
  {
    route: 'donation-percent',
    data: () => 'donation:percent:5',
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /Auto % on payments/,
    db: {users: {changed: 1}},
  },
  {
    route: 'donation-scope',
    data: () => 'donation:scope:tips',
    methods: ['editMessageText', 'answerCallbackQuery'],
    text: /Auto % on payments/,
    db: {users: {changed: 1}},
  },
  {
    route: 'donate-amount',
    data: () => 'donate:amount:21',
    methods: [
      'answerCallbackQuery',
      'deleteMessage',
      'sendChatAction',
      'sendMessage',
      'sendRichMessage',
    ],
    text: /Could not send 21 sats|Support ZapGram/,
    // Fee-collection invoice is created even when the user cannot pay it.
    lnbits: {payments: [{out: false, sats: 21, times: 1}]},
  },
  {
    route: 'donate-monthly-amount',
    data: () => 'donate:monthly:21',
    methods: [
      'answerCallbackQuery',
      'deleteMessage',
      'sendChatAction',
      'sendMessage',
      'sendRichMessage',
    ],
    text: /first charge failed|zapgram@getalby.com|Support ZapGram/,
    db: {users: {changed: 1}},
    lnbits: {payments: [{out: false, sats: 21, times: 1}]},
  },
  // Conversation-only routes: outside an active conversation they fall through to unknownCallback.
  {
    route: 'feature-fund-amount',
    data: () => 'feature:fund:1000',
    methods: ['deleteMessage', 'answerCallbackQuery'],
    text: /Unknown button/,
  },
  {
    route: 'broadcast-locale',
    data: () => 'broadcast:locale:en',
    methods: ['deleteMessage', 'answerCallbackQuery'],
    text: /Unknown button/,
  },
  {
    route: 'broadcast-confirm',
    data: () => 'broadcast:confirm:yes',
    methods: ['deleteMessage', 'answerCallbackQuery'],
    text: /Unknown button/,
  },
]

for (const {route, data, methods, text, db, lnbits} of parameterizedCases) {
  test(`callback route ${route} handles "${data({chat: {id: CHAT_GROUP} as Chat, subscription: {id: '<id>'} as Subscription})}"`, async () => {
    const world = await seedRoutingWorld()
    await expectDelta(e2e, () => e2e.send(privateCallback(data(world))), {
      db,
      lnbits,
      telegram: methods,
    })
    expect(joinedOutput()).toMatch(text)
    expectNoErrors(e2e.logs)
  })
}

test('the tables above exercise every callback route the bot registers', () => {
  const registry = [
    ...parameterizedRoutes.map(route => route.name),
    ...Object.values(staticCallback),
  ].sort()
  const covered = [
    ...new Set([
      ...parameterizedCases.map(item => item.route),
      ...staticCases.map(item => item.data),
    ]),
  ].sort()

  expect(registry).toHaveLength(50)
  expect(covered).toEqual(registry)
})

// --- Fallbacks ---

test('unroutable callback data reaches unknownCallback and changes nothing else', async () => {
  await seedRoutingWorld()
  await expectDelta(e2e, () => e2e.send(privateCallback('no-such-route')), {
    telegram: ['deleteMessage', 'answerCallbackQuery'],
  })
  expect(e2e.tg.last('answerCallbackQuery')?.text).toMatch(/Unknown button/)
  expectNoErrors(e2e.logs)
})

test('a refused deleteMessage does not abort callback cleanup or raise a bot error', async () => {
  await seedRoutingWorld()
  e2e.tg.fail('deleteMessage', {
    error_code: 400,
    description: "Bad Request: message can't be deleted for everyone",
  })

  await expectDelta(e2e, () => e2e.send(privateCallback('no-such-route')), {
    telegram: ['deleteMessage', 'answerCallbackQuery'],
  })
  expect(e2e.tg.last('answerCallbackQuery')?.text).toMatch(/Unknown button/)
  // Cleanup is best-effort: Telegram 400 must not surface as "Bot error" / PostHog $exception.
  expectNoErrors(e2e.logs)
  expect(e2e.tg.of('sendMessage')).toHaveLength(0)
})

test('plain private text falls back to the wallet', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('hello there')), {
    ...FIRST_TOUCH,
    telegram: [{method: 'sendRichMessage', to: USER_A, text: /Wallet/}],
  })
  expectNoErrors(e2e.logs)
})

test('pasted bolt11 invoice reaches the invoices module', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('lnbc1pabcdef')), {
    ...FIRST_TOUCH,
    telegram: ['sendMessage'],
  })
  expect(joinedOutput()).toMatch(/Invalid Lightning invoice/)
  // The invoice is unparseable on purpose: routing is proven by the invoice-input conversation
  // returning its localized correction rather than falling through to the wallet.
  expect(e2e.logs).toHaveLength(0)
})

// --- Chat-type isolation ---

test('group text does not reach the private wallet fallback', async () => {
  const update = groupText('hello there')
  expect(update.message?.chat.type).toBe('supergroup')

  await expectDelta(e2e, () => e2e.send(update), {})
  expectNoErrors(e2e.logs)
})

test('a command in a group does not reach the private command handlers', async () => {
  const update = privateCommand('/wallet', {chat: groupChat()})
  expect(update.message?.chat.type).toBe('supergroup')
  expect(update.message?.entities).toEqual([{type: 'bot_command', offset: 0, length: 7}])

  await expectDelta(e2e, () => e2e.send(update), {})
  expectNoErrors(e2e.logs)
})

for (const [type, chat] of [
  ['supergroup', groupChat],
  ['channel', channelChat],
] as const) {
  test(`a callback in a ${type} does not reach the private callback handlers`, async () => {
    const update = privateCallback(staticCallback.wallet, {chat: chat()})
    // Same callback_data that opens the wallet in a private chat — only the chat type differs, so
    // silence here can only come from the chatType('private') filter.
    expect(update.callback_query?.message?.chat.type).toBe(type)
    expect(update.callback_query?.data).toBe('wallet')

    await expectDelta(e2e, () => e2e.send(update), {})
    expectNoErrors(e2e.logs)
  })
}

test('/tip in a private chat does not reach the group tipping handler', async () => {
  await expectDelta(e2e, () => e2e.send(privateCommand('/tip 21')), {
    ...FIRST_TOUCH,
    telegram: [{method: 'sendRichMessage', to: USER_A, text: /Wallet/}],
  })
  expectNoErrors(e2e.logs)
})

// --- Anonymous senders ---

test('an update from a bot account is rejected before a user row is created', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('hello', {from: {is_bot: true}})), {
    telegram: [
      {method: 'sendMessage', to: USER_A, text: /bot, channel, group, or anonymous profile/},
    ],
  })

  expect(await e2e.db.select().from(usersTable)).toEqual([])
  // FromBotError only: attachUser never set ctx.user, so replyWithCachedWallet no-ops.
  expect(errorMessages()).toEqual(['Bot error'])
})

function joinedOutput(): string {
  return e2e.tg.calls
    .map(call => {
      const richMessage = call.payload.rich_message as
        | {html?: string; markdown?: string}
        | undefined
      return String(
        call.payload.text ??
          call.payload.caption ??
          richMessage?.html ??
          richMessage?.markdown ??
          '',
      )
    })
    .join('\n')
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}

function groupChat(): Record<string, unknown> {
  return {id: CHAT_GROUP, type: 'supergroup', title: 'E2E Group'}
}

function channelChat(): Record<string, unknown> {
  return {id: CHAT_CHANNEL, type: 'channel', title: 'E2E Channel'}
}
