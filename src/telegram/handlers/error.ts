import {AppError} from '@core/errors/app-error.js'
import {replyWithCachedWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'
import {errorTranslationKey} from '@telegram/errors/error-copy.js'
import {replyWithTempMessage} from '@telegram/helpers/temp-message.js'
import type {ErrorHandler} from 'grammy'

export const errorHandler: ErrorHandler = async err => {
  const {error} = err
  const ctx = err.ctx as BotContext
  ctx.log.error({error}, 'Bot error')

  const errorResponse =
    error instanceof AppError
      ? ctx.t(errorTranslationKey[error.code], error.params)
      : ctx.t('error.unknown')

  // Join requests have no group reply target for the applicant — DM the private peer.
  if (ctx.chatJoinRequest) {
    await ctx.api
      .sendMessage(ctx.chatJoinRequest.user_chat_id, errorResponse)
      .catch((sendError: unknown) => {
        ctx.log.error({error: sendError}, 'Failed to reply about error on chat join request')
      })
    return
  }

  if (ctx.chat?.type === 'channel') return
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    return replyWithTempMessage(ctx, errorResponse).catch((error: unknown) => {
      ctx.log.error({error}, 'Failed to reply about error in group')
    })
  }
  await ctx.reply(errorResponse).catch((error: unknown) => {
    ctx.log.error({error}, 'Failed to reply about error in private chat')
  })
  // Use the middleware-loaded balance — never re-fetch. A live GET that just failed would
  // be repeated here with got retries and only add latency; missing wallet (middleware itself
  // failed) is a quiet no-op.
  if (ctx.chat?.type === 'private') {
    await replyWithCachedWallet(ctx).catch((error: unknown) => {
      ctx.log.error({error}, 'Failed to reply with wallet in error handler')
    })
  }
}
