import {afterEach, beforeEach, expect, test} from 'bun:test'
import {expectNoErrors} from '../asserts.js'
import {privateCallback, privateCommand, privateText} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta} from '../state.js'

/**
 * Routing guard for the fully composed bot.
 *
 * The assertions deliberately use observable Bot API calls and complete DB/LNbits deltas. No
 * terminal handler or middleware is replaced: every update passes through the real container,
 * middleware chain, repositories and HTTP fakes.
 */

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

test('unroutable callback data reaches unknownCallback', async () => {
  await expectDelta(e2e, () => e2e.send(privateCallback('no-such-route')), {
    db: {users: {added: 1}},
    lnbits: {balances: {'100001 wallet': 0}},
    telegram: ['deleteMessage', 'answerCallbackQuery'],
  })
  expect(e2e.tg.last('answerCallbackQuery')?.text).toMatch(/Unknown button/)
  expectNoErrors(e2e.logs)
})

test('plain private text falls back to the wallet', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('hello there')), {
    db: {users: {added: 1}},
    lnbits: {balances: {'100001 wallet': 0}},
    telegram: [{method: 'sendMessage', to: 100001, text: /Wallet/}],
  })
  expectNoErrors(e2e.logs)
})

for (const [command, text] of [
  ['/settings', /Settings/],
  ['/chats', /don't have any chats/],
  ['/subscriptions', /don't have any subscriptions/],
] as const) {
  test(`${command} reaches its module, not the fallback`, async () => {
    await expectDelta(e2e, () => e2e.send(privateCommand(command)), {
      db: {users: {added: 1}},
      lnbits: {balances: {'100001 wallet': 0}},
      telegram: [{method: 'sendMessage', to: 100001, text}],
    })
    expectNoErrors(e2e.logs)
  })
}

const callbackCases: {
  data: string
  methods: string[]
  text: RegExp
  conversation?: boolean
}[] = [
  {data: 'wallet', methods: ['editMessageText'], text: /Wallet/},
  {data: 'settings', methods: ['editMessageText'], text: /Settings/},
  {data: 'group-settings', methods: ['editMessageText'], text: /Groups and channels/},
  {data: 'send-menu', methods: ['editMessageText'], text: /Send payment/},
  {
    data: 'send-to-user',
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /Enter the username/,
    conversation: true,
  },
  {
    data: 'create-invoice',
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /Enter the amount/,
    conversation: true,
  },
  {
    data: 'pay-invoice',
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /Lightning invoice/,
    conversation: true,
  },
  {
    data: 'connect-nwc',
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /NWC URL/,
    conversation: true,
  },
  {
    data: 'disconnect-nwc',
    methods: ['deleteMessage', 'sendMessage', 'sendMessage'],
    text: /Wallet disconnected/,
  },
  {
    data: 'toggle-nwc-tips',
    methods: ['answerCallbackQuery', 'editMessageText'],
    text: /Settings/,
  },
  {data: 'cancel', methods: ['sendMessage'], text: /Wallet/},
  {data: 'chats:1', methods: ['editMessageText'], text: /don't have any chats/},
  {data: 'chat:-1001', methods: ['editMessageText'], text: /Chat not found/},
  {data: 'chat:-1001:on-paid', methods: ['editMessageText'], text: /Chat not found/},
  {data: 'chat:-1001:change-price', methods: ['editMessageText'], text: /Chat not found/},
  {
    data: 'subscriptions:1',
    methods: ['editMessageText'],
    text: /don't have any subscriptions/,
  },
  {
    data: 'subscription:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f',
    methods: ['editMessageText'],
    text: /Subscription not found/,
  },
  {
    data: 'subscription:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f:renew',
    methods: ['editMessageText'],
    text: /Subscription not found/,
  },
  {
    data: 'pay-sub:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f:wallet',
    methods: ['editMessageText'],
    text: /subscription invoice has expired/,
  },
]

for (const {data, methods, text, conversation} of callbackCases) {
  test(`callback "${data}" reaches its handler, not unknownCallback`, async () => {
    await expectDelta(e2e, () => e2e.send(privateCallback(data)), {
      db: {
        users: {added: 1},
        ...(conversation ? {conversations: {added: 1}} : {}),
      },
      lnbits: {balances: {'100001 wallet': 0}},
      telegram: methods,
    })
    const output = e2e.tg.calls
      .map(call => String(call.payload.text ?? call.payload.caption ?? ''))
      .join('\n')
    expect(output).toMatch(text)
    expectNoErrors(e2e.logs)
  })
}

test('pasted bolt11 invoice reaches the invoices module', async () => {
  await expectDelta(e2e, () => e2e.send(privateText('lnbc1pabcdef')), {
    db: {users: {added: 1}},
    lnbits: {balances: {'100001 wallet': 0}},
    telegram: ['sendMessage', 'sendMessage', 'sendMessage'],
  })
  expect(
    e2e.tg
      .of('sendMessage')
      .map(call => call.text)
      .join('\n'),
  ).toMatch(/Paying Lightning invoice/)
  expect(e2e.logs).toHaveLength(1)
})

test('/start and /help are still served by the shell', async () => {
  await expectDelta(e2e, () => e2e.send(privateCommand('/start')), {
    db: {users: {added: 1}},
    lnbits: {balances: {'100001 wallet': 0}},
    telegram: [
      {method: 'sendMessage', to: 100001},
      {method: 'sendMessage', to: 100001, text: /Wallet/},
    ],
  })

  await expectDelta(e2e, () => e2e.send(privateCommand('/help')), {
    telegram: [{method: 'sendMessage', to: 100001}],
  })
  expectNoErrors(e2e.logs)
})
