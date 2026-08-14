import {type AppLocale, resolveAppLocale} from '@core/i18n/locale.js'
import type {Chat} from '@infra/db/types.js'
import {
  chatCustomMessageEditRoute,
  chatCustomMessagePreviewRoute,
  chatCustomMessageResetRoute,
  chatCustomMessageRoute,
  chatRoute,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {editLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {translate} from '@telegram/i18n/i18n.js'
import {InlineKeyboard} from 'grammy'

const customMessageLocales = ['ru', 'en'] as const

type CustomMessageChat = Pick<Chat, 'id' | 'title' | 'customMessageRu' | 'customMessageEn'>

export function effectiveCustomMessage(chat: CustomMessageChat, locale: string): string {
  const appLocale = resolveAppLocale({storedLanguageCode: locale})
  const customMessage = appLocale === 'ru' ? chat.customMessageRu : chat.customMessageEn
  return (
    customMessage ??
    translate('subscription-invoice.default-message', appLocale, {title: chat.title})
  )
}

/**
 * The same message, safe to drop into the `html` of a rich message.
 *
 * Everything the editor can produce (b/i/u/s/code/pre/a/blockquote) is spelled the same way in both
 * dialects — the spoiler is the one exception, and rows written before the join screens went rich
 * still carry the classic `<span class="tg-spoiler">` form. A rich message rejects the whole html
 * over one unknown tag, so those are rewritten here rather than left to fail the send.
 */
export function richCustomMessage(chat: CustomMessageChat, locale: string): string {
  return effectiveCustomMessage(chat, locale)
    .replaceAll('<span class="tg-spoiler">', '<tg-spoiler>')
    .replaceAll('</span>', '</tg-spoiler>')
}

export function editMessageWithCustomMessage(ctx: BotContext, chat: CustomMessageChat) {
  return editLivingMenu(ctx, () =>
    ctx.editMessageText(customMessageScreenText(ctx, chat), {
      link_preview_options: {is_disabled: true},
      reply_markup: buildCustomMessageKeyboard(ctx.t, chat),
    }),
  )
}

export function replyWithCustomMessage(ctx: BotContext, chat: CustomMessageChat) {
  return showLivingMenu(ctx, () =>
    ctx.reply(customMessageScreenText(ctx, chat), {
      link_preview_options: {is_disabled: true},
      reply_markup: buildCustomMessageKeyboard(ctx.t, chat),
    }),
  )
}

export function editMessageWithCustomMessagePreview(
  ctx: BotContext,
  chat: CustomMessageChat,
  locale: AppLocale,
) {
  return editLivingMenu(ctx, () =>
    ctx.editMessageText(
      ctx.t('chat.custom-message-preview', {
        locale: locale.toUpperCase(),
        message: effectiveCustomMessage(chat, locale),
      }),
      {
        link_preview_options: {is_disabled: true},
        reply_markup: new InlineKeyboard().text(
          ctx.t('button.back'),
          chatCustomMessageRoute.build({chatId: chat.id}),
        ),
      },
    ),
  )
}

function customMessageScreenText(ctx: BotContext, chat: CustomMessageChat): string {
  return ctx.t('chat.custom-message', {
    ruStatus: customMessageStatus(ctx, Boolean(chat.customMessageRu)),
    enStatus: customMessageStatus(ctx, Boolean(chat.customMessageEn)),
  })
}

function customMessageStatus(ctx: BotContext, isCustom: boolean): string {
  return ctx.t(
    isCustom ? 'chat.custom-message-status-custom' : 'chat.custom-message-status-default',
  )
}

function buildCustomMessageKeyboard(t: BotContext['t'], chat: CustomMessageChat): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (const locale of customMessageLocales) {
    const label = locale.toUpperCase()
    keyboard
      .text(
        t('button.edit-custom-message-locale', {locale: label}),
        chatCustomMessageEditRoute.build({chatId: chat.id, locale}),
      )
      .text(
        t('button.preview-custom-message', {locale: label}),
        chatCustomMessagePreviewRoute.build({chatId: chat.id, locale}),
      )

    const hasCustomMessage =
      locale === 'ru' ? chat.customMessageRu !== null : chat.customMessageEn !== null
    if (hasCustomMessage) {
      keyboard.text(
        t('button.reset-custom-message', {locale: label}),
        chatCustomMessageResetRoute.build({chatId: chat.id, locale}),
      )
    }
    keyboard.row()
  }

  return keyboard.text(t('button.back'), chatRoute.build({chatId: chat.id}))
}
