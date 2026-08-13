import {afterEach, beforeEach, expect, test} from 'bun:test'
import type {Chat} from '@infra/db/types.js'
import {effectiveCustomMessage} from '@modules/chats/telegram/messages/custom-message.js'
import {
  chatChangePriceRoute,
  chatCustomMessageEditRoute,
  chatCustomMessagePreviewRoute,
  chatCustomMessageResetRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatOnchainEnableRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
  chatsPageRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import {expectEditedNotSent, expectNoConversations, expectNoErrors} from '../asserts.js'
import {CHAT_CHANNEL, CHAT_GROUP, OWNER, USER_A, USER_B} from '../fixtures/ids.js'
import {seedChat, seedUser} from '../fixtures/seed.js'
import {
  chatJoinRequest,
  myChatMember,
  newChatTitle,
  privateCallback,
  privateCommand,
  privateText,
} from '../fixtures/updates.js'
import {createE2E, type E2E} from '../harness.js'
import {expectDelta, expectLedgerBalanced, snapshot} from '../state.js'
import {scenarioCoverage} from './coverage.js'

export const COVERS = scenarioCoverage.chats

/**
 * Paid-chat administration from Telegram updates all the way through the real repositories.
 *
 * The assertions deliberately distinguish menus from conversation prompts. Navigation menus
 * replace the active menu with a new message, while conversation prompts continue editing their
 * host message until the conversation completes.
 */

const CHAT_PRICE = 1000
const CHANGED_PRICE = 123
const MASTERPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'
const OWNER_PROFILE = {
  id: OWNER,
  is_bot: false,
  first_name: 'Chat Owner',
  username: 'chat_owner',
  language_code: 'en',
}

let e2e: E2E

beforeEach(async () => {
  e2e = await createE2E()
})

afterEach(async () => {
  await e2e.dispose()
})

// --- Telegram rights and chat metadata ---

for (const type of ['supergroup', 'channel'] as const) {
  test(`granting the required rights registers an inactive ${type} and notifies its owner`, async () => {
    queueChatOwner()
    const update = myChatMember(type, true)
    const chatId = type === 'channel' ? CHAT_CHANNEL : CHAT_GROUP
    const title = type === 'channel' ? 'E2E Channel' : 'E2E Group'

    await expectDelta(e2e, () => e2e.send(update), {
      db: {
        users: {
          added: 1,
          match: rows => {
            expect(rows[0]?.after).toMatchObject({
              id: OWNER,
              username: 'chat_owner',
              firstName: 'Chat Owner',
              languageCode: 'en',
            })
          },
        },
        chats: {
          added: 1,
          match: rows => {
            expect(rows[0]?.after).toMatchObject({
              id: chatId,
              ownerId: OWNER,
              title,
              type,
              status: 'inactive',
              price: CHAT_PRICE,
              paymentType: 'one_time',
              customMessageEn: null,
              customMessageRu: null,
            })
          },
        },
      },
      telegram: [
        {method: 'getChatAdministrators'},
        {method: 'sendMessage', to: OWNER, text: new RegExp(`was added to ${title}`)},
      ],
    })

    expect(e2e.tg.last('getChatAdministrators')?.chat_id).toBe(chatId)
    expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
      chatRoute.build({chatId}),
      staticCallback.openMenu,
    ])
    expectNoErrors(e2e.logs)
  })
}

test('losing the required rights marks an active chat as inaccessible', async () => {
  await seedOwner()
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active'})

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', false)), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {status: 'no_access'}),
      },
    },
    telegram: [{method: 'sendMessage', to: OWNER, text: /was removed from E2E Group/}],
  })

  expect(e2e.tg.of('getChatAdministrators')).toHaveLength(0)
  expect(urlsOf(e2e.tg.last('sendMessage'))).toEqual(['https://t.me/zap_gram_bot?startgroup=true'])
  expectNoErrors(e2e.logs)
})

test('returning the required rights restores an inaccessible chat as inactive', async () => {
  await seedOwner()
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'E2E Group',
    status: 'no_access',
  })
  queueChatOwner()

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', true)), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {status: 'inactive'}),
      },
    },
    telegram: [
      {method: 'getChatAdministrators'},
      {method: 'sendMessage', to: OWNER, text: /was added to E2E Group/},
    ],
  })

  expectNoErrors(e2e.logs)
})

for (const permission of ['can_invite_users', 'can_restrict_members'] as const) {
  test(`a first grant without ${permission} does not register the chat`, async () => {
    const update = myChatMember('supergroup', true)
    const member = update.my_chat_member?.new_chat_member
    if (member?.status !== 'administrator') throw new Error('Expected an administrator fixture')
    member[permission] = false

    await expectDelta(e2e, () => e2e.send(update), {})

    expectNoErrors(e2e.logs)
  })
}

test('a failed administrator lookup is logged and leaves the world unchanged', async () => {
  e2e.tg.fail('getChatAdministrators', {
    error_code: 400,
    description: 'Bad Request: chat administrators unavailable',
  })

  await expectDelta(e2e, () => e2e.send(myChatMember('supergroup', true)), {
    telegram: [{method: 'getChatAdministrators'}],
  })

  expect(errorMessages()).toEqual(['Cannot get chat creator of paid chat'])
})

test('a new chat title changes only the stored title', async () => {
  await seedOwner()
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: OWNER, status: 'active'})

  await expectDelta(e2e, () => e2e.send(newChatTitle('Renamed paid chat')), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {title: 'Renamed paid chat'}),
      },
    },
  })

  expectNoErrors(e2e.logs)
})

// --- Chat card callbacks ---

type CardCase = {
  label: string
  seed: Partial<Pick<Chat, 'status' | 'paymentType' | 'price'>>
  data: string
  changes?: Partial<Pick<Chat, 'status' | 'paymentType'>>
  text: RegExp
}

const cardCases: CardCase[] = [
  {
    label: 'opening a chat card',
    seed: {status: 'active', paymentType: 'monthly', price: 4321},
    data: chatRoute.build({chatId: CHAT_GROUP}),
    text: /E2E paid chat/,
  },
  {
    label: 'disabling paid access',
    seed: {status: 'active'},
    data: chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'inactive'}),
    changes: {status: 'inactive'},
    text: /Paid access: <b>disabled/,
  },
  {
    label: 'enabling paid access',
    seed: {status: 'inactive'},
    data: chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'active'}),
    changes: {status: 'active'},
    text: /Paid access: <b>enabled/,
  },
  {
    label: 'switching to monthly payments',
    seed: {paymentType: 'one_time'},
    data: chatPaymentTypeRoute.build({chatId: CHAT_GROUP, paymentType: 'monthly'}),
    changes: {paymentType: 'monthly'},
    text: /Payment type: <b>monthly/,
  },
  {
    label: 'switching to one-time payments',
    seed: {paymentType: 'monthly'},
    data: chatPaymentTypeRoute.build({chatId: CHAT_GROUP, paymentType: 'one_time'}),
    changes: {paymentType: 'one_time'},
    text: /Payment type: <b>one-time/,
  },
]

for (const cardCase of cardCases) {
  test(`${cardCase.label} replaces the active menu`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    const chat = await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      ...cardCase.seed,
    })

    await expectDelta(e2e, () => e2e.send(privateCallback(cardCase.data)), {
      db: cardCase.changes
        ? {
            chats: {
              changed: 1,
              match: rows => expectOnlyChatChanges(rows, cardCase.changes ?? {}),
            },
          }
        : undefined,
      telegram: [{method: 'sendMessage', to: USER_A, text: cardCase.text}],
    })

    const finalChat = {...chat, ...cardCase.changes}
    expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
      chatPaidAccessRoute.build({
        chatId: CHAT_GROUP,
        status: finalChat.status === 'active' ? 'inactive' : 'active',
      }),
      chatPaymentTypeRoute.build({
        chatId: CHAT_GROUP,
        paymentType: finalChat.paymentType === 'monthly' ? 'one_time' : 'monthly',
      }),
      chatChangePriceRoute.build({chatId: CHAT_GROUP}),
      chatOnchainEnableRoute.build({chatId: CHAT_GROUP}),
      chatCustomMessageRoute.build({chatId: CHAT_GROUP}),
      chatsPageRoute.build({page: 1}),
    ])
    expectNoErrors(e2e.logs)
  })
}

test("a different user cannot enable paid access for someone else's chat", async () => {
  await seedOwner()
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: OWNER,
    title: 'Foreign paid chat',
    status: 'inactive',
  })
  const before = await snapshot(e2e)

  await expectDelta(
    e2e,
    () =>
      e2e.send(privateCallback(chatPaidAccessRoute.build({chatId: CHAT_GROUP, status: 'active'}))),
    {
      telegram: [{method: 'editMessageText', to: USER_A, text: /Chat not found/}],
    },
  )

  const after = await snapshot(e2e)
  expect(after.db).toEqual(before.db)
  expect(String(e2e.tg.last('editMessageText')?.text)).not.toContain('Foreign paid chat')
  expectEditedNotSent(e2e.tg)
  expectNoErrors(e2e.logs)
})

// --- Price conversation ---

test('a valid price is stored and the completed conversation sends a fresh card', async () => {
  await enterChangingPrice()

  await expectDelta(e2e, () => e2e.send(privateText(String(CHANGED_PRICE))), {
    db: {
      chats: {
        changed: 1,
        match: rows => expectOnlyChatChanges(rows, {price: CHANGED_PRICE}),
      },
      conversations: {removed: 1},
    },
    telegram: [
      {method: 'editMessageReplyMarkup', to: USER_A},
      {method: 'editMessageText', to: USER_A, text: /set to 123 sats/},
      {method: 'sendMessage', to: USER_A, text: /Price: <b>123 sats/},
    ],
  })

  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

for (const price of [0, -5]) {
  test(`price ${price} is rejected and can be corrected`, async () => {
    await enterChangingPrice()

    await expectDelta(e2e, () => e2e.send(privateText(String(price))), {
      db: {conversations: {changed: 1}},
      telegram: [{method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/}],
    })

    await expectDelta(e2e, () => e2e.send(privateText(String(CHANGED_PRICE))), {
      db: {
        chats: {
          changed: 1,
          match: rows => expectOnlyChatChanges(rows, {price: CHANGED_PRICE}),
        },
        conversations: {removed: 1},
      },
      telegram: [
        {method: 'editMessageReplyMarkup', to: USER_A},
        {method: 'editMessageText', to: USER_A, text: /set to 123 sats/},
        {method: 'sendMessage', to: USER_A, text: /Price: <b>123 sats/},
      ],
    })

    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('a nonnumeric price keeps the conversation active', async () => {
  await enterChangingPrice()

  await expectDelta(e2e, () => e2e.send(privateText('abc')), {
    db: {conversations: {changed: 1}},
    telegram: [{method: 'sendMessage', to: USER_A, text: /Invalid amount of sats/}],
  })

  expect((await snapshot(e2e)).db.conversations).toHaveLength(1)
  expectNoErrors(e2e.logs)
})

// --- On-chain setup conversation ---

test('invalid masterpub keeps on-chain setup active and a corrected key enables it', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})

  await e2e.send(privateCallback(chatOnchainEnableRoute.build({chatId: CHAT_GROUP})))
  const beforeInvalid = await snapshot(e2e)
  await e2e.send(privateText('not-an-xpub'))

  const afterInvalid = await snapshot(e2e)
  expect(afterInvalid.db.chats).toEqual(beforeInvalid.db.chats)
  expect(afterInvalid.lnbits).toEqual(beforeInvalid.lnbits)
  expect(afterInvalid.db.conversations).toHaveLength(1)
  expect(String(e2e.tg.last('sendMessage')?.text)).toMatch(/Paste a zpub|Вставь zpub/i)

  await e2e.send(privateText(MASTERPUB))

  const chat = await e2e.container.chats.getOrThrow(CHAT_GROUP)
  expect(chat).toMatchObject({onchainEnabled: true, onchainMasterpub: MASTERPUB})
  expect(chat.watchonlyWalletId).toBeTruthy()
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('canceling on-chain setup marks its prompt and returns to chat details', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})

  await e2e.send(privateCallback(chatOnchainEnableRoute.build({chatId: CHAT_GROUP})))
  const promptMessageId = requiredPromptMessageId()
  await e2e.send(privateCallback(staticCallback.cancel, {messageId: promptMessageId}))

  await expectNoConversations(e2e.db)
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Action canceled|Действие отменено/i)
  expect(String(e2e.tg.last('sendMessage')?.text)).toContain('E2E paid chat')
  expect((await e2e.container.chats.getOrThrow(CHAT_GROUP)).onchainEnabled).toBe(false)
  expectNoErrors(e2e.logs)
})

test('/wallet interrupts on-chain setup without reopening chat details', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})

  await e2e.send(privateCallback(chatOnchainEnableRoute.build({chatId: CHAT_GROUP})))
  await e2e.send(privateCommand('/wallet'))

  await expectNoConversations(e2e.db)
  expect(String(e2e.tg.last('editMessageText')?.text)).toMatch(/Action canceled|Действие отменено/i)
  const messages = e2e.tg.of('sendMessage').map(call => String(call.text))
  expect(messages.filter(text => text.includes('E2E paid chat'))).toHaveLength(0)
  expect(e2e.tg.of('sendRichMessage').some(call => /Wallet|Кошелёк/i.test(richHtmlOf(call)))).toBe(
    true,
  )
  expectNoErrors(e2e.logs)
})

// --- Custom join message ---

const customScreenCases = [
  {
    label: 'with both defaults',
    customMessages: {},
    status: /RU: <b>default<\/b>[\s\S]*EN: <b>default<\/b>/,
    expectedCallbacks: [
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatRoute.build({chatId: CHAT_GROUP}),
    ],
  },
  {
    label: 'with only Russian customized',
    customMessages: {customMessageRu: 'Особое приветствие'},
    status: /RU: <b>custom<\/b>[\s\S]*EN: <b>default<\/b>/,
    expectedCallbacks: [
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessageResetRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatRoute.build({chatId: CHAT_GROUP}),
    ],
  },
  {
    label: 'with both languages customized',
    customMessages: {
      customMessageRu: 'Особое приветствие',
      customMessageEn: 'A special welcome',
    },
    status: /RU: <b>custom<\/b>[\s\S]*EN: <b>custom<\/b>/,
    expectedCallbacks: [
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessageResetRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
      chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatCustomMessagePreviewRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatCustomMessageResetRoute.build({chatId: CHAT_GROUP, locale: 'en'}),
      chatRoute.build({chatId: CHAT_GROUP}),
    ],
  },
] as const

for (const screenCase of customScreenCases) {
  test(`the custom-message screen ${screenCase.label} exposes only valid actions`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      ...screenCase.customMessages,
    })

    await expectDelta(
      e2e,
      () => e2e.send(privateCallback(chatCustomMessageRoute.build({chatId: CHAT_GROUP}))),
      {telegram: [{method: 'sendMessage', to: USER_A, text: screenCase.status}]},
    )

    expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([...screenCase.expectedCallbacks])
    expect(String(e2e.tg.last('sendMessage')?.text)).not.toMatch(
      /Особое приветствие|A special welcome/,
    )
    expectNoErrors(e2e.logs)
  })
}

for (const editCase of [
  {
    locale: 'ru' as const,
    prompt: /Enter a custom message in Russian/,
    input: 'Новое русское сообщение',
    initial: {customMessageRu: 'Старое русское', customMessageEn: 'Keep English'},
    change: {customMessageRu: 'Новое русское сообщение'},
  },
  {
    locale: 'en' as const,
    prompt: /Enter a custom message in English/,
    input: 'New English message',
    initial: {customMessageRu: 'Сохрани русский', customMessageEn: 'Old English'},
    change: {customMessageEn: 'New English message'},
  },
] as const) {
  test(`editing ${editCase.locale.toUpperCase()} changes only that language`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      ...editCase.initial,
    })

    await expectDelta(
      e2e,
      () =>
        e2e.send(
          privateCallback(
            chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: editCase.locale}),
          ),
        ),
      {
        db: {conversations: {added: 1}},
        telegram: [
          {method: 'deleteMessage', to: USER_A},
          {method: 'sendMessage', to: USER_A, text: editCase.prompt},
        ],
      },
    )
    e2e.tg.reset()

    await expectDelta(e2e, () => e2e.send(privateText(editCase.input)), {
      db: {
        chats: {
          changed: 1,
          match: rows => expectOnlyChatChanges(rows, editCase.change),
        },
        conversations: {removed: 1},
      },
      telegram: [
        {method: 'editMessageReplyMarkup', to: USER_A},
        {
          method: 'sendMessage',
          to: USER_A,
          text: new RegExp(`${editCase.locale.toUpperCase()} custom message has been updated`),
        },
        {method: 'sendMessage', to: USER_A, text: /Join request message/},
      ],
    })

    expect(await e2e.container.chats.getOrThrow(CHAT_GROUP)).toMatchObject({
      ...editCase.initial,
      ...editCase.change,
    })
    await expectNoConversations(e2e.db)
    expectNoErrors(e2e.logs)
  })
}

test('invalid and too-long input keep the selected one-language flow active', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    customMessageRu: 'Не менять',
    customMessageEn: 'Old English',
  })
  await e2e.send(
    privateCallback(chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'en'})),
  )

  await e2e.send(privateText(' '))
  await e2e.send(privateText('x'.repeat(1001)))

  expect((await snapshot(e2e)).db.conversations).toHaveLength(1)
  expect(await e2e.container.chats.getOrThrow(CHAT_GROUP)).toMatchObject({
    customMessageRu: 'Не менять',
    customMessageEn: 'Old English',
  })
  expect(
    e2e.tg
      .of('sendMessage')
      .map(call => String(call.text))
      .join('\n'),
  ).toMatch(/valid text message[\s\S]*too long/)

  await e2e.send(privateText('Correct English'))

  expect(await e2e.container.chats.getOrThrow(CHAT_GROUP)).toMatchObject({
    customMessageRu: 'Не менять',
    customMessageEn: 'Correct English',
  })
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

test('canceling one language returns to custom-message management without changing either text', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    customMessageRu: 'Сохранить RU',
    customMessageEn: 'Keep EN',
  })
  await e2e.send(
    privateCallback(chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'ru'})),
  )
  const promptMessageId = requiredPromptMessageId()

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(staticCallback.cancel, {messageId: promptMessageId})),
    {
      db: {conversations: {removed: 1}},
      telegram: [
        {method: 'answerCallbackQuery'},
        {method: 'editMessageText', to: USER_A, text: /Action canceled/},
        {method: 'sendMessage', to: USER_A, text: /Join request message/},
      ],
    },
  )
  expect(await e2e.container.chats.getOrThrow(CHAT_GROUP)).toMatchObject({
    customMessageRu: 'Сохранить RU',
    customMessageEn: 'Keep EN',
  })
  await expectNoConversations(e2e.db)
  expectNoErrors(e2e.logs)
})

for (const previewCase of [
  {locale: 'ru' as const, custom: 'Особое приветствие'},
  {locale: 'en' as const, custom: null},
] as const) {
  test(`preview ${previewCase.locale.toUpperCase()} uses its effective custom/default text`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    const chat = await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      customMessageRu: previewCase.locale === 'ru' ? previewCase.custom : null,
      customMessageEn: previewCase.locale === 'en' ? previewCase.custom : null,
    })
    const expected = effectiveCustomMessage(chat, previewCase.locale)

    await expectDelta(
      e2e,
      () =>
        e2e.send(
          privateCallback(
            chatCustomMessagePreviewRoute.build({
              chatId: CHAT_GROUP,
              locale: previewCase.locale,
            }),
          ),
        ),
      {telegram: [{method: 'sendMessage', to: USER_A, text: new RegExp(expected)}]},
    )

    expect(String(e2e.tg.last('sendMessage')?.text)).toContain(expected)
    expect(callbackDataOf(e2e.tg.last('sendMessage'))).toEqual([
      chatCustomMessageRoute.build({chatId: CHAT_GROUP}),
    ])
    expectNoErrors(e2e.logs)
  })
}

for (const locale of ['ru', 'en'] as const) {
  test(`reset ${locale.toUpperCase()} preserves the other language`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      customMessageRu: 'Сохранённый RU',
      customMessageEn: 'Saved EN',
    })
    const changes = locale === 'ru' ? {customMessageRu: null} : {customMessageEn: null}

    await expectDelta(
      e2e,
      () =>
        e2e.send(privateCallback(chatCustomMessageResetRoute.build({chatId: CHAT_GROUP, locale}))),
      {
        db: {
          chats: {changed: 1, match: rows => expectOnlyChatChanges(rows, changes)},
        },
        telegram: [{method: 'sendMessage', to: USER_A, text: /Join request message/}],
      },
    )

    const chat = await e2e.container.chats.getOrThrow(CHAT_GROUP)
    expect(chat.customMessageRu).toBe(locale === 'ru' ? null : 'Сохранённый RU')
    expect(chat.customMessageEn).toBe(locale === 'en' ? null : 'Saved EN')
    expect(callbackDataOf(e2e.tg.last('sendMessage'))).not.toContain(
      chatCustomMessageResetRoute.build({chatId: CHAT_GROUP, locale}),
    )
    expectNoErrors(e2e.logs)
  })
}

test('legacy edit callback opens the new language selector without starting a conversation', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {id: CHAT_GROUP, ownerId: USER_A, status: 'active'})

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatEditCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {telegram: [{method: 'sendMessage', to: USER_A, text: /Join request message/}]},
  )

  await expectNoConversations(e2e.db)
  expect(callbackDataOf(e2e.tg.last('sendMessage'))).toContain(
    chatCustomMessageEditRoute.build({chatId: CHAT_GROUP, locale: 'ru'}),
  )
  expectNoErrors(e2e.logs)
})

for (const customJoin of [
  {languageCode: 'en', selected: /A special welcome/, other: 'Особое приветствие'},
  {languageCode: 'en-US', selected: /A special welcome/, other: 'Особое приветствие'},
  {languageCode: 'ru', selected: /Особое приветствие/, other: 'A special welcome'},
  {languageCode: 'ru-RU', selected: /Особое приветствие/, other: 'A special welcome'},
] as const) {
  test(`${customJoin.languageCode} selects the matching custom join message`, async () => {
    await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
    await seedUser(e2e, {
      id: USER_B,
      username: 'user_b',
      firstName: 'User B',
      languageCode: customJoin.languageCode,
    })
    await seedChat(e2e, {
      id: CHAT_GROUP,
      ownerId: USER_A,
      status: 'active',
      customMessageRu: 'Особое приветствие',
      customMessageEn: 'A special welcome',
    })

    const beforeJoin = await snapshot(e2e)
    await expectDelta(
      e2e,
      () =>
        e2e.send(
          chatJoinRequest('supergroup', {
            from: {
              id: USER_B,
              username: 'user_b',
              first_name: 'User B',
              language_code: customJoin.languageCode,
            },
          }),
        ),
      {
        telegram: [{method: 'sendMessage', to: USER_B, text: customJoin.selected}],
      },
    )

    const notification = String(e2e.tg.last('sendMessage')?.text)
    expect(notification).not.toContain(customJoin.other)
    expect(notification).not.toContain('Access to private community')
    expect(notification).toMatch(/Choose a payment method|Выбери способ оплаты/)
    expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([])
    expectLedgerBalanced(beforeJoin, await snapshot(e2e))
    expectNoErrors(e2e.logs)
  })
}

test('removing a custom message restores the default join copy', async () => {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedUser(e2e, {
    id: USER_B,
    username: 'user_b',
    firstName: 'User B',
    languageCode: 'en',
  })
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    customMessageRu: 'Старое приветствие',
    customMessageEn: 'Old custom welcome',
  })

  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatRemoveCustomMessageRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {
        chats: {
          changed: 1,
          match: rows =>
            expectOnlyChatChanges(rows, {customMessageRu: null, customMessageEn: null}),
        },
      },
      telegram: [{method: 'sendMessage', to: USER_A, text: /E2E paid chat/}],
    },
  )
  e2e.tg.reset()

  const beforeJoin = await snapshot(e2e)
  await expectDelta(
    e2e,
    () =>
      e2e.send(
        chatJoinRequest('supergroup', {
          from: {id: USER_B, username: 'user_b', first_name: 'User B', language_code: 'en'},
        }),
      ),
    {
      telegram: [
        {method: 'sendMessage', to: USER_B, text: /Access to private community "E2E paid chat"/},
      ],
    },
  )

  const joinText = String(e2e.tg.last('sendMessage')?.text)
  expect(joinText).not.toContain('Old custom welcome')
  expect(joinText).toMatch(/Choose a payment method/)
  expect(await e2e.db.query.subscriptionPaymentsTable.findMany()).toEqual([])
  expectLedgerBalanced(beforeJoin, await snapshot(e2e))
  expectNoErrors(e2e.logs)
})

// --- Pagination ---

test('/chats with one accessible chat has no page controls', async () => {
  const chats = await seedOwnedChats(1)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  expect(chatCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([
    chatRoute.build({chatId: requiredChat(chats, 0).id}),
  ])
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('/chats with exactly ten accessible chats has no next page', async () => {
  const chats = await seedOwnedChats(10)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  const callbacks = chatCallbacksOf(e2e.tg.last('sendMessage'))
  expect(callbacks).toHaveLength(10)
  expect(new Set(callbacks)).toEqual(new Set(chats.map(chat => chatRoute.build({chatId: chat.id}))))
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('/chats with eleven accessible chats exposes a second page after ten rows', async () => {
  const chats = await seedOwnedChats(11)

  await expectDelta(e2e, () => e2e.send(privateCommand('/chats')), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  const firstPageChats = chatCallbacksOf(e2e.tg.last('sendMessage'))
  expect(firstPageChats).toHaveLength(10)
  expect(new Set(firstPageChats)).toEqual(
    new Set(chats.slice(0, 10).map(chat => chatRoute.build({chatId: chat.id}))),
  )
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([chatsPageRoute.build({page: 2})])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

test('the last page replaces the list with one row and a previous-page button', async () => {
  const chats = await seedOwnedChats(11)

  await expectDelta(e2e, () => e2e.send(privateCallback(chatsPageRoute.build({page: 2}))), {
    telegram: [{method: 'sendMessage', to: USER_A, text: /Your chats with the ability/}],
  })

  expect(chatCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([
    chatRoute.build({chatId: requiredChat(chats, 10).id}),
  ])
  expect(pageCallbacksOf(e2e.tg.last('sendMessage'))).toEqual([chatsPageRoute.build({page: 1})])
  expectAddChatButton(e2e.tg.last('sendMessage'))
  expectNoErrors(e2e.logs)
})

// --- Setup and payload helpers ---

async function seedOwner(): Promise<void> {
  await seedUser(e2e, {
    id: OWNER,
    username: 'chat_owner',
    firstName: 'Chat Owner',
    languageCode: 'en',
  })
}

function queueChatOwner(): void {
  e2e.tg.reply('getChatAdministrators', [
    {status: 'creator', user: OWNER_PROFILE, is_anonymous: false},
  ])
}

async function enterChangingPrice(): Promise<void> {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedChat(e2e, {
    id: CHAT_GROUP,
    ownerId: USER_A,
    status: 'active',
    price: CHAT_PRICE,
  })
  await expectDelta(
    e2e,
    () => e2e.send(privateCallback(chatChangePriceRoute.build({chatId: CHAT_GROUP}))),
    {
      db: {conversations: {added: 1}},
      telegram: [
        {method: 'editMessageText', to: USER_A, text: /Changing the price of paid access/},
      ],
    },
  )
  e2e.tg.reset()
}

async function seedOwnedChats(count: number): Promise<Chat[]> {
  await seedUser(e2e, {id: USER_A, username: 'user_a', firstName: 'User A'})
  await seedOwner()

  const chats: Chat[] = []
  const newest = Date.UTC(2026, 0, 1)
  for (let index = 0; index < count; index++) {
    chats.push(
      await seedChat(e2e, {
        id: CHAT_GROUP - index * 10,
        ownerId: USER_A,
        title: `Owned chat ${index + 1}`,
        status: 'inactive',
        createdAt: new Date(newest - index * 60_000),
      }),
    )
  }

  // Neither a foreign owner's chat nor an inaccessible owned chat may affect a page boundary.
  await seedChat(e2e, {
    id: CHAT_GROUP - 20_000,
    ownerId: OWNER,
    title: 'Foreign chat',
    status: 'active',
    createdAt: new Date(newest + 60_000),
  })
  await seedChat(e2e, {
    id: CHAT_GROUP - 10_000,
    ownerId: USER_A,
    title: 'Inaccessible chat',
    status: 'no_access',
    createdAt: new Date(newest + 120_000),
  })
  return chats
}

function expectOnlyChatChanges(
  rows: {before?: unknown; after?: unknown}[],
  changes: Partial<Chat>,
): void {
  expect(rows).toHaveLength(1)
  const before = asRecord(rows[0]?.before)
  const after = asRecord(rows[0]?.after)
  expect(after).toEqual({...before, ...changes})
}

function callbackDataOf(payload: Record<string, unknown> | undefined): string[] {
  return buttonsOf(payload).flatMap(button =>
    typeof button.callback_data === 'string' ? [button.callback_data] : [],
  )
}

function chatCallbacksOf(payload: Record<string, unknown> | undefined): string[] {
  return callbackDataOf(payload).filter(data => data.startsWith('chat:'))
}

function pageCallbacksOf(payload: Record<string, unknown> | undefined): string[] {
  return callbackDataOf(payload).filter(data => data.startsWith('chats:'))
}

function urlsOf(payload: Record<string, unknown> | undefined): string[] {
  return buttonsOf(payload).flatMap(button => (typeof button.url === 'string' ? [button.url] : []))
}

function buttonsOf(payload: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const markup = payload?.reply_markup as
    | {inline_keyboard?: Record<string, unknown>[][]}
    | undefined
  return (markup?.inline_keyboard ?? []).flat()
}

function expectAddChatButton(payload: Record<string, unknown> | undefined): void {
  expect(urlsOf(payload)).toContain('https://t.me/zap_gram_bot?startgroup=true')
}

function richHtmlOf(payload: Record<string, unknown> | undefined): string {
  const richMessage = payload?.rich_message
  if (!richMessage || typeof richMessage !== 'object' || Array.isArray(richMessage)) return ''
  return String(Reflect.get(richMessage, 'html') ?? '')
}

function requiredChat(chats: Chat[], index: number): Chat {
  const chat = chats[index]
  if (!chat) throw new Error(`Expected chat fixture at index ${index}`)
  return chat
}

function requiredPromptMessageId(): number {
  const messageId = e2e.tg.lastMessageId('sendMessage')
  if (messageId === undefined) throw new Error('Expected an outbound prompt message ID')
  return messageId
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${String(value)}`)
  }
  return value as Record<string, unknown>
}

function errorMessages(): string[] {
  return e2e.logs
    .filter(log => log.level === 'error' || log.level === 50)
    .map(log => String(log.msg ?? ''))
}
