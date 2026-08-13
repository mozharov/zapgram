import {AppError} from '@core/errors/app-error.js'
import type {BotContext} from '@telegram/context.js'
import {errorTranslationKey} from '@telegram/errors/error-copy.js'
import {isVanishedTelegramMessageError} from '@telegram/errors/vanished-message.js'
import {replyOnlyToSender} from '@telegram/helpers/ephemeral-message.js'
import type {ErrorHandler} from 'grammy'
import {getRuntime} from '../../runtime.js'

export const errorHandler: ErrorHandler = async err => {
  const {error} = err
  const ctx = err.ctx as BotContext
  if (isVanishedTelegramMessageError(error)) {
    ctx.log.warn({error}, 'Ignored vanished Telegram message')
    return
  }
  ctx.log.error({error}, 'Bot error')

  const errorResponse =
    error instanceof AppError
      ? ctx.t(errorTranslationKey[error.code], error.params)
      : ctx.t('error.unknown')

  // Join requests have no group reply target for the applicant — DM the private peer.
  if (ctx.chatJoinRequest) {
    const sent = await getRuntime().notifier.send(ctx.chatJoinRequest.user_chat_id, errorResponse)
    if (!sent) ctx.log.error('Failed to reply about error on chat join request')
    return
  }

  if (ctx.chat?.type === 'channel') return
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    // Nobody but the sender needs to see a failed transfer.
    return replyOnlyToSender(ctx, errorResponse).catch((error: unknown) => {
      ctx.log.error({error}, 'Failed to reply about error in group')
    })
  }
  // Through the notifier so the error joins the open-menu chain: it carries the "Open wallet"
  // button and strips it off the previous notification. That button *is* the recovery path — the
  // handler deliberately does not render a wallet menu of its own, which used to leave an
  // untracked second menu behind on every error.
  const chatId = ctx.chat?.id
  if (chatId === undefined) return
  const sent = await getRuntime().notifier.send(chatId, errorResponse)
  if (!sent) ctx.log.error('Failed to reply about error in private chat')
}
