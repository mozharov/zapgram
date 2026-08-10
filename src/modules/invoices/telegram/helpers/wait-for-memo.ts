import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'

const MAX_MEMO_LENGTH = 150

export type MemoTextResult =
  | {status: 'ok'; memo: string}
  | {status: 'cancelled'; reason: 'cancel' | 'invalid'}

/**
 * Prompt for invoice memo text (after the user opted in via Add memo).
 */
export async function waitForMemoText(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<MemoTextResult> {
  const message = await ctx.reply(ctx.t('wait-for-memo'), {
    reply_markup: new InlineKeyboard().row({
      callback_data: staticCallback.cancel,
      text: ctx.t('button.cancel'),
    }),
  })
  const context = await conversation.wait()
  await conversation.external(() => removeInlineKeyboard(message))

  if (context.callbackQuery) {
    return {status: 'cancelled', reason: 'cancel'}
  }

  const memo = context.message?.text?.trim()
  if (!memo || memo.length > MAX_MEMO_LENGTH) {
    await ctx.reply(ctx.t('wait-for-memo.invalid'))
    return {status: 'cancelled', reason: 'invalid'}
  }

  return {status: 'ok', memo}
}
