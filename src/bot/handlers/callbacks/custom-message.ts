import {type CallbackQueryContext, InlineKeyboard} from 'grammy'
import {getAccessibleChat} from '../../../models/chat.js'
import type {BotContext} from '../../context.js'
import {translate} from '../../lib/i18n.js'

export const customMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  const keyboard = new InlineKeyboard().add({
    callback_data: `chat:${chat.id}:edit-custom-message`,
    text: ctx.t('button.edit-custom-message'),
  })
  if (chat.customMessageRu || chat.customMessageEn) {
    keyboard.row({
      callback_data: `chat:${chat.id}:remove-custom-message`,
      text: ctx.t('button.remove-custom-message'),
    })
  }
  keyboard.row({
    callback_data: `chat:${chat.id}`,
    text: ctx.t('button.back'),
  })
  return ctx.editMessageText(
    ctx.t('chat.custom-message', {
      ruMessage:
        chat.customMessageRu ??
        translate('subscription-invoice.default-message', 'ru', {title: chat.title}),
      enMessage:
        chat.customMessageEn ??
        translate('subscription-invoice.default-message', 'en', {title: chat.title}),
    }),
    {
      link_preview_options: {
        is_disabled: true,
      },
      reply_markup: keyboard,
    },
  )
}

function parseMatch(match: string | RegExpMatchArray): {id: number} {
  const strId = typeof match === 'string' ? undefined : match[1]
  if (strId === undefined) throw new Error('Invalid callback match')
  return {id: parseInt(strId, 10)}
}
