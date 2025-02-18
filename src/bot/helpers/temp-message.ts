import type {Context} from 'grammy'
import {sleep} from '../../utils/sleep.js'

const defaultDelayMs = 60000

export async function replyWithTempMessage(
  ctx: Context,
  text: string,
  options?: {
    delayMs?: number
    other?: Parameters<Context['reply']>[1]
  },
) {
  const message = await ctx.reply(text, options?.other)
  void sleep(options?.delayMs ?? defaultDelayMs).then(() =>
    ctx.deleteMessages([message.message_id]).catch(() => null),
  )
}
