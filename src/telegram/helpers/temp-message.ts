import {sleep} from '@core/utils/sleep.js'
import type {Context} from 'grammy'
import {getRuntime} from '../../runtime.js'

export async function replyWithTempMessage(
  ctx: Context,
  text: string,
  options?: {
    delayMs?: number
    other?: Parameters<Context['reply']>[1]
  },
) {
  const message = await ctx.reply(text, options?.other)
  void sleep(options?.delayMs ?? getRuntime().config.TEMP_MESSAGE_DELAY_MS).then(() =>
    ctx.deleteMessages([message.message_id]).catch(() => null),
  )
}
