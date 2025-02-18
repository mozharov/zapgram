import {InlineKeyboard} from 'grammy'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'

export async function waitForWallet(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<'internal' | 'nwc'> {
  if (!ctx.user.nwc) return 'internal'
  const message = await replyWithWaitForWallet(ctx)
  const context = await conversation.waitForCallbackQuery(['internal', 'nwc'], {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))

  if (context.callbackQuery.data === 'nwc') {
    await ctx.reply(ctx.t('wait-for-wallet.nwc'))
    return 'nwc'
  }
  await ctx.reply(ctx.t('wait-for-wallet.internal'))
  return 'internal'
}

function replyWithWaitForWallet(ctx: ConversationContext) {
  const keyboard = new InlineKeyboard()
    .row({
      callback_data: 'internal',
      text: ctx.t('button.internal-wallet'),
    })
    .add({
      callback_data: 'nwc',
      text: ctx.t('button.nwc-wallet'),
    })
    .row({callback_data: 'cancel', text: ctx.t('button.cancel')})
  return ctx.reply(ctx.t('wait-for-wallet'), {reply_markup: keyboard})
}
