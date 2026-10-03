import {expect} from 'bun:test'
import {enterConversation, resumeConversation} from '@grammyjs/conversations'
import {parseMode} from '@infra/telegram/parse-mode.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {i18n} from '@telegram/middlewares/i18n.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import {logger} from '@telegram/middlewares/logger.js'
import type {Update} from 'grammy/types'
import {privateText} from './fixtures/updates.js'
import type {E2E} from './harness.js'

/** Run the real wizard, then force a replay after completion with one extra wait. */
export async function replayWizard(
  e2e: E2E,
  wizard: (conversation: BotConversation, ctx: ConversationContext) => Promise<void>,
  input: Update,
  assertOnce: () => void,
) {
  const builder = async (conversation: BotConversation, ctx: ConversationContext) => {
    await wizard(conversation, ctx)
    await conversation.wait()
  }
  const base = (update: Update) => ({
    update,
    api: {token: e2e.container.config.BOT_TOKEN, options: {apiRoot: e2e.tg.url}},
    me: e2e.container.bot.botInfo,
  })
  const options = {
    plugins: [
      async (ctx: ConversationContext, next: () => Promise<void>) => {
        ctx.api.config.use(parseMode('HTML'))
        await next()
      },
      logger,
      i18n,
      attachUser,
      lnbitsWallet,
    ],
  }
  const entered = await enterConversation<BotContext, ConversationContext>(
    builder,
    base(privateText('start')),
    options,
  )
  expect(entered.status).toBe('handled')
  if (entered.status !== 'handled') throw new Error('Wizard did not wait for input')
  const completed = await resumeConversation(builder, base(input), entered, options)
  expect(completed.status).toBe('handled')
  if (completed.status !== 'handled') throw new Error('Wizard did not reach the extra wait')
  assertOnce()
  const replayed = await resumeConversation(
    builder,
    base(privateText('continue')),
    {
      ...completed,
      args: entered.args,
    },
    options,
  )
  expect(replayed.status).toBe('complete')
  assertOnce()
}
