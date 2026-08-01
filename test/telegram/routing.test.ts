import {expect, mock, test} from 'bun:test'
import {createTestDb} from '@test/helpers/db.js'

/**
 * Routing guard for the composed bot.
 *
 * telegram/composition.ts installs terminal catch-alls (`on('callback_query')` → unknownCallback,
 * `on('message')` → walletCommand). grammY fixes a child composer's position in the parent chain
 * at `chatType()` call time, so if those terminals sit on a composer created *before* the feature
 * `register*()` calls they short-circuit every module — every command and every inline button
 * silently answers with the wallet fallback instead of its real handler.
 *
 * The two terminal handlers are replaced with markers. A feature update must never reach them;
 * genuinely unroutable updates must (those are the positive controls that keep the negative
 * assertions honest).
 */

const terminalHits: string[] = []

mock.module('@telegram/handlers/unknown-callback.js', () => ({
  unknownCallback: async () => {
    terminalHits.push('unknownCallback')
  },
}))
mock.module('@modules/wallet/telegram/handlers/wallet-command.js', () => ({
  walletCommand: async () => {
    terminalHits.push('walletCommand')
  },
}))

// Infra-dependent middleware only. The conversations plugin stays REAL: the feature registers
// call createConversation(), which throws if the plugin is not installed.
mock.module('@telegram/middlewares/attach-user.js', () => ({
  attachUser: (ctx: never, next: () => Promise<void>) => {
    Object.assign(ctx as object, {
      user: {
        id: 42,
        languageCode: 'en',
        username: 'u',
        wallet: {balance: 0, getBalance: async () => 0},
      },
    })
    return next()
  },
}))
mock.module('@telegram/middlewares/lnbits-wallet.js', () => ({
  lnbitsWallet: (_ctx: never, next: () => Promise<void>) => next(),
}))
mock.module('@telegram/middlewares/i18n.js', () => ({
  i18n: (ctx: never, next: () => Promise<void>) => {
    const t = (key: string) => `T(${key})`
    Object.assign(ctx as object, {t, translate: t, i18n: {getLocale: async () => 'en'}})
    return next()
  },
}))
mock.module('@telegram/middlewares/logger.js', () => ({
  logger: (ctx: never, next: () => Promise<void>) => {
    Object.assign(ctx as object, {log: {error() {}, info() {}, warn() {}, debug() {}}})
    return next()
  },
}))
mock.module('@telegram/handlers/error.js', () => ({
  // Feature handlers hit incomplete stubs and throw; that is fine — this suite only asserts
  // WHICH handler the update was routed to, not that the handler completes.
  errorHandler: () => {},
}))

const {createBot} = await import('@infra/telegram/bot.js')
const {registerHandlers} = await import('@telegram/composition.js')
const {createConversationRepository} = await import('@modules/conversations/repository.js')
const {setRuntime} = await import('../../src/runtime.js')

const quiet = {error() {}, info() {}, warn() {}, debug() {}, child: () => quiet}
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'T',
  username: 'zap_gram_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as never

async function buildBot() {
  const db = createTestDb()
  setRuntime({
    config: {chatsPerPage: 10, memoFooter: 'f'},
    log: quiet,
    db,
    conversations: createConversationRepository(db),
  } as never)

  const bot = createBot('000000:test-token', botInfo)
  const calls: string[] = []
  bot.api.config.use(async (_prev, method) => {
    calls.push(method)
    return {message_id: 1, date: 1, chat: {id: 42, type: 'private'}, text: 'x'} as never
  })
  registerHandlers(bot as never)
  await bot.init()
  terminalHits.length = 0
  return {bot, calls}
}

const privateMessage = (text: string) =>
  ({
    update_id: 1,
    reqId: 'test',
    message: {
      message_id: 1,
      date: 1,
      text,
      chat: {id: 42, type: 'private', first_name: 'U'},
      from: {id: 42, is_bot: false, first_name: 'U', language_code: 'en'},
      entities: text.startsWith('/')
        ? [{type: 'bot_command', offset: 0, length: text.length}]
        : undefined,
    },
  }) as never

const privateCallback = (data: string) =>
  ({
    update_id: 1,
    reqId: 'test',
    callback_query: {
      id: 'cb1',
      chat_instance: 'ci',
      from: {id: 42, is_bot: false, first_name: 'U', language_code: 'en'},
      data,
      message: {
        message_id: 1,
        date: 1,
        text: 'm',
        chat: {id: 42, type: 'private', first_name: 'U'},
      },
    },
  }) as never

// --- positive controls: these MUST reach the terminal handlers ---

test('unroutable callback data reaches unknownCallback', async () => {
  const {bot} = await buildBot()
  await bot.handleUpdate(privateCallback('no-such-route'))
  expect(terminalHits).toEqual(['unknownCallback'])
})

test('plain private text falls back to the wallet', async () => {
  const {bot} = await buildBot()
  await bot.handleUpdate(privateMessage('hello there'))
  expect(terminalHits).toEqual(['walletCommand'])
})

// --- the invariant: feature routes must never be swallowed ---
// /wallet is excluded on purpose: the wallet module's own handler IS walletCommand.

for (const command of ['/settings', '/chats', '/subscriptions']) {
  test(`${command} reaches its module, not the fallback`, async () => {
    const {bot} = await buildBot()
    await bot.handleUpdate(privateMessage(command))
    expect(terminalHits).toEqual([])
  })
}

for (const data of [
  'wallet',
  'settings',
  'group-settings',
  'send-menu',
  'send-to-user',
  'create-invoice',
  'pay-invoice',
  'connect-nwc',
  'disconnect-nwc',
  'toggle-nwc-tips',
  'cancel',
  'chats:1',
  'chat:-1001',
  'chat:-1001:on-paid',
  'chat:-1001:change-price',
  'subscriptions:1',
  'subscription:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f',
  'subscription:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f:renew',
  'pay-sub:0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f:wallet',
]) {
  test(`callback "${data}" reaches its handler, not unknownCallback`, async () => {
    const {bot} = await buildBot()
    await bot.handleUpdate(privateCallback(data))
    expect(terminalHits).toEqual([])
  })
}

test('pasted bolt11 invoice reaches the invoices module', async () => {
  const {bot} = await buildBot()
  await bot.handleUpdate(privateMessage('lnbc1pabcdef'))
  expect(terminalHits).toEqual([])
})

test('/start and /help are still served by the shell', async () => {
  const {bot, calls} = await buildBot()
  for (const command of ['/start', '/help']) {
    calls.length = 0
    terminalHits.length = 0
    await bot.handleUpdate(privateMessage(command))
    expect(terminalHits).toEqual([])
    expect(calls[0]).toBe('sendMessage')
  }
})
