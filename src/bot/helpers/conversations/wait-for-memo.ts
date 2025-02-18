import {InlineKeyboard} from 'grammy'
import type {BotConversation, ConversationContext} from '../../context.js'
import {removeInlineKeyboard} from '../keyboard.js'

const MAX_MEMO_LENGTH = 150

export async function waitForMemo(conversation: BotConversation, ctx: ConversationContext) {
  const message = await replyWithWaitForMemo(ctx)
  const context = await conversation.wait()
  await conversation.external(() => removeInlineKeyboard(message))
  if (context.hasCallbackQuery('skip')) {
    await ctx.reply(ctx.t('wait-for-memo.skipped'))
    return undefined
  }
  if (context.callbackQuery) {
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt({next: true})
  }

  const memo = context.message?.text?.trim()
  if (!memo || memo.length > MAX_MEMO_LENGTH) {
    await ctx.reply(ctx.t('wait-for-memo.invalid'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  return memo
}

function replyWithWaitForMemo(ctx: ConversationContext) {
  return ctx.reply(ctx.t('wait-for-memo'), {
    reply_markup: new InlineKeyboard()
      .add({callback_data: 'skip', text: ctx.t('button.skip')})
      .row({callback_data: 'cancel', text: ctx.t('button.cancel')}),
  })
}
