import {getAccessibleChat} from '@modules/chats/repository.js'
import {
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {translate} from '@telegram/i18n/i18n.js'
import {type CallbackQueryContext, InlineKeyboard} from 'grammy'

export const customMessageCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {chatId: id} = chatCustomMessageRoute.parse(ctx.match)
  const chat = await getAccessibleChat(id)
  if (!chat) return ctx.editMessageText(ctx.t('chat.not-found'))

  const keyboard = new InlineKeyboard().add({
    callback_data: chatEditCustomMessageRoute.build({chatId: chat.id}),
    text: ctx.t('button.edit-custom-message'),
  })
  if (chat.customMessageRu || chat.customMessageEn) {
    keyboard.row({
      callback_data: chatRemoveCustomMessageRoute.build({chatId: chat.id}),
      text: ctx.t('button.remove-custom-message'),
    })
  }
  keyboard.row({
    callback_data: chatRoute.build({chatId: chat.id}),
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
