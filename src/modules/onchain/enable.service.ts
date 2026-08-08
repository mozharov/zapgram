import {validateMasterpub} from '@core/onchain/masterpub.js'
import type {Chat} from '@infra/db/types.js'
import type {WatchOnlyClient} from '@infra/lnbits/watchonly.js'
import type {AppLogger} from '@infra/logger.js'

export type EnableOnchainResult =
  | {
      status: 'enabled'
      chat: Chat
      fingerprint: string
      watchonlyWalletId: string
    }
  | {status: 'invalid_masterpub'; reason: 'empty' | 'too_short' | 'unknown_prefix'}
  | {status: 'watchonly_error'; message: string}

export type DisableOnchainResult = {status: 'disabled'; chat: Chat}

export type OnchainEnableServiceDeps = {
  watchOnly: Pick<WatchOnlyClient, 'createWallet' | 'deleteWallet' | 'listWallets'>
  updateChat: (id: number, data: Partial<Chat>) => Promise<Chat>
  network: 'Mainnet' | 'Testnet'
  log: AppLogger
}

export function createOnchainEnableService(deps: OnchainEnableServiceDeps) {
  return {
    async enable(chat: Chat, rawMasterpub: string): Promise<EnableOnchainResult> {
      const parsed = validateMasterpub(rawMasterpub)
      if (!parsed.ok) return {status: 'invalid_masterpub', reason: parsed.reason}

      const previousWalletId = chat.watchonlyWalletId

      try {
        // Reuse existing WO wallet with the same masterpub (Watch-Only rejects duplicates).
        const existing = (await deps.watchOnly.listWallets(deps.network)).find(
          w => w.masterpub === parsed.value,
        )
        const wallet =
          existing ??
          (await deps.watchOnly.createWallet({
            masterpub: parsed.value,
            title: `ZapGram ${chat.id}`.slice(0, 120),
            network: deps.network,
          }))

        const updated = await deps.updateChat(chat.id, {
          onchainEnabled: true,
          onchainMasterpub: parsed.value,
          watchonlyWalletId: wallet.id,
          onchainFingerprint: wallet.fingerprint,
        })

        if (previousWalletId && previousWalletId !== wallet.id) {
          try {
            await deps.watchOnly.deleteWallet(previousWalletId)
          } catch (error) {
            deps.log.warn(
              {error, previousWalletId},
              'Failed to delete previous Watch-Only wallet after xpub change',
            )
          }
        }

        return {
          status: 'enabled',
          chat: updated,
          fingerprint: wallet.fingerprint,
          watchonlyWalletId: wallet.id,
        }
      } catch (error) {
        deps.log.error({error, chatId: chat.id}, 'Watch-Only wallet create failed')
        const message = error instanceof Error ? error.message : 'watchonly_error'
        return {status: 'watchonly_error', message}
      }
    },

    async disable(chat: Chat, opts?: {deleteWallet?: boolean}): Promise<DisableOnchainResult> {
      const walletId = chat.watchonlyWalletId
      const updated = await deps.updateChat(chat.id, {
        onchainEnabled: false,
        // Keep masterpub/fingerprint for display; clear wallet id so pay is off.
        watchonlyWalletId: null,
      })

      if (opts?.deleteWallet && walletId) {
        try {
          await deps.watchOnly.deleteWallet(walletId)
        } catch (error) {
          deps.log.warn({error, walletId}, 'Failed to delete Watch-Only wallet on disable')
        }
      }

      return {status: 'disabled', chat: updated}
    },
  }
}

export type OnchainEnableService = ReturnType<typeof createOnchainEnableService>
