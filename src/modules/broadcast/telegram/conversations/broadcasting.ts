import type {AppLocale} from '@core/i18n/locale.js'
import {formatBroadcastConfirm, formatBroadcastStarted} from '@modules/broadcast/format.js'
import {
  buildBroadcastConfirmKeyboard,
  buildBroadcastLocaleKeyboard,
} from '@modules/broadcast/telegram/keyboards/broadcast.js'
import {
  broadcastConfirmRoute,
  broadcastLocaleRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/**
 * Admin broadcast: pick locale → source message → confirm → snapshot + background job.
 */
export async function broadcasting(conversation: BotConversation, ctx: ConversationContext) {
  const locale = await waitForLocale(conversation, ctx)
  if (!locale) return

  const source = await waitForSourceMessage(conversation, ctx)
  if (!source) return

  const {broadcastService} = getRuntime()
  const totalCount = await conversation.external(() =>
    broadcastService.countRecipients(locale, ctx.user.id),
  )

  const confirmMessage = await ctx.reply(formatBroadcastConfirm(locale, totalCount), {
    reply_markup: buildBroadcastConfirmKeyboard(ctx.t),
  })

  const confirmed = await waitForConfirm(conversation, ctx)
  await conversation.external(() => removeInlineKeyboard(confirmMessage))

  if (!confirmed) {
    await ctx.reply(ctx.t('canceled'))
    return
  }

  const {broadcast, totalCount: n} = await conversation.external(() =>
    broadcastService.startBroadcast({
      adminUserId: ctx.user.id,
      locale,
      sourceChatId: source.chatId,
      sourceMessageId: source.messageId,
    }),
  )

  await ctx.reply(formatBroadcastStarted(locale, n))
  // Kick the queue without blocking the conversation (cron is backup).
  void conversation
    .external(() => broadcastService.processQueue())
    .catch(error => {
      getRuntime().log.error(
        {error, broadcastId: broadcast.id},
        'Immediate broadcast process failed',
      )
    })
}

async function waitForLocale(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<AppLocale | null> {
  const prompt = await ctx.reply(ctx.t('broadcast.pick-locale'), {
    reply_markup: buildBroadcastLocaleKeyboard(ctx.t),
  })

  while (true) {
    const next = await conversation.waitFor('callback_query:data', {
      otherwise: async otherwiseCtx => {
        await conversation.external(() => removeInlineKeyboard(prompt))
        await otherwiseCtx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      },
    })

    const data = next.callbackQuery?.data
    if (!data) continue

    if (data === staticCallback.cancel) {
      await next.answerCallbackQuery()
      await conversation.external(() => removeInlineKeyboard(prompt))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt()
    }

    if (broadcastLocaleRoute.pattern.test(data)) {
      const {locale} = broadcastLocaleRoute.parse(data)
      await next.answerCallbackQuery()
      await conversation.external(() => removeInlineKeyboard(prompt))
      return locale
    }

    await next.answerCallbackQuery()
  }
}

async function waitForSourceMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<{chatId: number; messageId: number} | null> {
  const prompt = await ctx.reply(ctx.t('broadcast.send-message'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })

  while (true) {
    const next = await conversation.waitFor(['message', 'callback_query:data'], {
      otherwise: async otherwiseCtx => {
        await conversation.external(() => removeInlineKeyboard(prompt))
        await otherwiseCtx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      },
    })

    if (next.callbackQuery?.data === staticCallback.cancel) {
      await next.answerCallbackQuery()
      await conversation.external(() => removeInlineKeyboard(prompt))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt()
    }

    const message = next.message
    if (!message || !next.chat) {
      await ctx.reply(ctx.t('broadcast.invalid-message'))
      continue
    }

    if (message.text?.startsWith('/')) {
      await ctx.reply(ctx.t('broadcast.invalid-message'))
      continue
    }

    await conversation.external(() => removeInlineKeyboard(prompt))
    return {
      chatId: next.chat.id,
      messageId: message.message_id,
    }
  }
}

async function waitForConfirm(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<boolean> {
  while (true) {
    const next = await conversation.waitFor('callback_query:data', {
      otherwise: async otherwiseCtx => {
        await otherwiseCtx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      },
    })

    const data = next.callbackQuery?.data
    if (!data) continue

    if (broadcastConfirmRoute.pattern.test(data)) {
      const {action} = broadcastConfirmRoute.parse(data)
      await next.answerCallbackQuery()
      return action === 'yes'
    }

    if (data === staticCallback.cancel) {
      await next.answerCallbackQuery()
      return false
    }

    await next.answerCallbackQuery()
  }
}
