import {satsToMsats} from '@core/money/sats.js'
import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'

export type WalletBalances = {
  internalMsats: number
  nwcMsats: number | null
  nwcBalanceError: boolean
}

export type FundedWallets = {
  internal: boolean
  nwc: boolean
  nwcBalanceError: boolean
}

export function fundedWalletsForAmount(
  balances: WalletBalances,
  requiredSats: number,
): FundedWallets {
  const need = satsToMsats(requiredSats)
  return {
    internal: balances.internalMsats >= need,
    nwc: balances.nwcMsats !== null && balances.nwcMsats >= need,
    nwcBalanceError: balances.nwcBalanceError,
  }
}

export async function readWalletBalances(input: {
  internalBalanceMsats: number
  nwc: NostrWallet | null | undefined
  log?: AppLogger
}): Promise<WalletBalances> {
  if (!input.nwc) {
    return {internalMsats: input.internalBalanceMsats, nwcMsats: null, nwcBalanceError: false}
  }
  try {
    const nwcMsats = await input.nwc.getBalance()
    return {internalMsats: input.internalBalanceMsats, nwcMsats, nwcBalanceError: false}
  } catch (error) {
    input.log?.error({error}, 'Failed to get NWC balance for wallet selection')
    return {internalMsats: input.internalBalanceMsats, nwcMsats: null, nwcBalanceError: true}
  }
}
