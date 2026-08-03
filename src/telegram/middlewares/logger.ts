import type {BotContext} from '@telegram/context.js'
import type {Middleware} from 'grammy'
import type {Update} from 'grammy/types'
import {getRuntime} from '../../runtime.js'

export const logger: Middleware<BotContext & {update: Update & {reqId: string}}> = (ctx, next) => {
  ctx.log = getRuntime().log.child({reqId: ctx.update.reqId})
  return next()
}
