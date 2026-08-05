import {sleep} from '@core/utils/sleep.js'
import type {AppLogger} from '@infra/logger.js'
import type {Context} from 'grammy'
import {getRuntime} from '../../runtime.js'
import {deleteMessagesSafely} from './delete-message.js'

type ContextWithLog = Context & {log: AppLogger}

export async function replyWithTempMessage(
  ctx: ContextWithLog,
  text: string,
  options?: {
    delayMs?: number
    other?: Parameters<Context['reply']>[1]
  },
) {
  const message = await ctx.reply(text, options?.other)
  void sleep(options?.delayMs ?? getRuntime().config.TEMP_MESSAGE_DELAY_MS).then(() =>
    deleteMessagesSafely(ctx, [message.message_id]),
  )
}
