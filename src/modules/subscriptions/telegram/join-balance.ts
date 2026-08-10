import {satsToMsats} from '@core/money/sats.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../runtime.js'

export type JoinBalanceAvailability = {
  /** ZapGram internal wallet covers the price. */
  walletCovers: boolean
  /**
   * Connected NWC wallet covers the price.
   * False when NWC is missing, balance is short, or getBalance failed
   * (failed NWC never blocks the rest of the chooser UI).
   */
  nwcCovers: boolean
}

/**
 * Which balance rails can cover the join price right now.
 * NWC getBalance errors never throw — treated as "NWC does not cover".
 */
export async function getJoinBalanceAvailability(
  ctx: Pick<BotContext, 'user'>,
  priceSats: number,
): Promise<JoinBalanceAvailability> {
  const priceMsats = satsToMsats(priceSats)
  const walletCovers = ctx.user.wallet.balance >= priceMsats
  const nwcMsats = await safeNwcBalanceMsats(ctx)
  const nwcCovers = nwcMsats >= priceMsats
  return {walletCovers, nwcCovers}
}

/** NWC getBalance must not break join UI — unreachable NWC is "no NWC funds". */
export async function safeNwcBalanceMsats(ctx: Pick<BotContext, 'user'>): Promise<number> {
  if (!ctx.user.nwc) return 0
  try {
    return await ctx.user.nwc.getBalance()
  } catch (error) {
    getRuntime().log.warn(
      {error, userId: ctx.user.id},
      'NWC balance unavailable for join payment UI',
    )
    return 0
  }
}
