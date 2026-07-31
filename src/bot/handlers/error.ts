import type {ErrorHandler} from 'grammy'
import type {BotContext} from '../context.js'
import {ExposedError} from '../errors/exposed-error.js'
import {replyWithWallet} from '../helpers/messages/wallet.js'
import {replyWithTempMessage} from '../helpers/temp-message.js'

export const errorHandler: ErrorHandler = async err => {
  const {error} = err
  const ctx = err.ctx as BotContext
  ctx.log.error({error}, 'Bot error')

  const errorResponse =
    error instanceof ExposedError
      ? ctx.t(error.translationKey, error.translationParams)
      : ctx.t('error.unknown')

  if (ctx.chat?.type === 'channel') return
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    return replyWithTempMessage(ctx, errorResponse).catch((error: unknown) => {
      ctx.log.error({error}, 'Failed to reply about error in group')
    })
  }
  await ctx.reply(errorResponse).catch((error: unknown) => {
    ctx.log.error({error}, 'Failed to reply about error in private chat')
  })
  if (ctx.chat?.type === 'private') {
    await replyWithWallet(ctx).catch((error: unknown) => {
      ctx.log.error({error}, 'Failed to reply with wallet in error handler')
    })
  }
}
