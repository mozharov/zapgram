import {logger as appLogger} from '@infra/logger.js'
import type {Middleware} from 'grammy'
import type {Update} from 'grammy/types'
import type {BotContext} from '../context.js'

export const logger: Middleware<BotContext & {update: Update & {reqId: string}}> = (ctx, next) => {
  ctx.log = appLogger.child({reqId: ctx.update.reqId})
  return next()
}
