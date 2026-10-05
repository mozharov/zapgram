import {looksLikeOnchainAddress} from '@core/onchain/looks-like-address.js'
import {getConversation} from '@modules/conversations/repository.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../runtime.js'

/** Product event for private text no other handler claimed. Never carries the message body. */
export const DM_UNRECOGNIZED_TEXT_EVENT = 'dm_unrecognized_text' as const

export function dmUnrecognizedTextProperties(text: string): {
  text_length: number
  looks_like_onchain: boolean
} {
  return {
    text_length: text.length,
    looks_like_onchain: looksLikeOnchainAddress(text),
  }
}

/**
 * Private text (and any other private message) that no command, hears, or conversation took.
 * Reopening the wallet alone reads as silence, so text gets a short hint first. The wallet
 * living menu still follows, with the same buttons as `/wallet`.
 */
export async function unrecognizedPrivateMessage(ctx: BotContext) {
  const text = ctx.message?.text
  // A conversation that halted with `{ next: true }` already handled this update (it finalized
  // an invoice, for example) and forwarded it so the wallet or a payment can open. grammY
  // deletes that row only after downstream middleware returns, so the row is still here.
  // Those handoffs stay wallet-only. The hint is for text no conversation touched.
  if (typeof text === 'string' && !(await handedOffByConversation(ctx))) {
    const properties = dmUnrecognizedTextProperties(text)
    // `properties` is only length + the on-chain flag. Do not add `text` here.
    captureBotEvent(getRuntime().posthog, DM_UNRECOGNIZED_TEXT_EVENT, properties)
    await ctx.reply(
      ctx.t(properties.looks_like_onchain ? 'dm-unrecognized-onchain' : 'dm-unrecognized'),
    )
  }
  return replyWithWallet(ctx)
}

async function handedOffByConversation(ctx: BotContext): Promise<boolean> {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return false
  const open = await getConversation(String(chatId))
  return open !== undefined
}
