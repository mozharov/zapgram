import {ToYourselfError} from '@core/errors/to-yourself.js'
import {UserDoesNotHaveWalletError} from '@core/errors/user-does-not-have-wallet.js'
import {InlineKeyboard} from 'grammy'
import {getUserByUsername} from '../../../models/user.js'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'

const USERNAME_REGEX = /^@([a-zA-Z0-9_]+)$/

export async function waitForUser(conversation: BotConversation, ctx: ConversationContext) {
  const message = await replyWithWaitForUser(ctx)
  const usernameContext = await conversation.waitForHears(USERNAME_REGEX, {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      if (ctx.update.message?.text) await ctx.reply(ctx.t('wait-for-user.invalid'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  const matched = usernameContext.match[1]
  if (matched === undefined) throw new Error('Username match missing')
  const username = matched.toLowerCase()
  await conversation.external(() => removeInlineKeyboard(message))
  return validateUsername(ctx, username)
}

function replyWithWaitForUser(ctx: ConversationContext) {
  return ctx.reply(ctx.t('wait-for-user'), {
    reply_markup: new InlineKeyboard([[{callback_data: 'cancel', text: ctx.t('button.cancel')}]]),
  })
}

async function validateUsername(ctx: ConversationContext, username: string) {
  if (username === ctx.user.username) throw new ToYourselfError()
  const user = await getUserByUsername(username)
  if (!user) throw new UserDoesNotHaveWalletError()
  const tgUser = await ctx.api.getChat(user.id)
  if (tgUser.username?.toLowerCase() !== username) throw new UserDoesNotHaveWalletError()
  return user
}
