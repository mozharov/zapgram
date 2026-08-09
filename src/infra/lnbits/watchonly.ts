import type {AppLogger} from '../logger.js'
import {LNBitsAPI} from './lnbits-api.js'
import {
  type WatchOnlyAddress,
  type WatchOnlyWallet,
  watchOnlyAddressSchema,
  watchOnlyWalletListSchema,
  watchOnlyWalletSchema,
} from './schemas.js'

export type CreateWatchOnlyWalletParams = {
  masterpub: string
  title: string
  network?: 'Mainnet' | 'Testnet'
  meta?: string
}

export class WatchOnlyClient extends LNBitsAPI {
  constructor({baseUrl, adminKey, log}: {baseUrl: string; adminKey: string; log?: AppLogger}) {
    super({baseUrl, adminKey, log})
  }

  async createWallet(params: CreateWatchOnlyWalletParams): Promise<WatchOnlyWallet> {
    return this.fetchWithSchema('/watchonly/api/v1/wallet', watchOnlyWalletSchema, {
      method: 'POST',
      body: JSON.stringify({
        masterpub: params.masterpub.trim(),
        title: params.title,
        network: params.network ?? 'Mainnet',
        meta: params.meta ?? '{}',
      }),
    })
  }

  async listWallets(network: 'Mainnet' | 'Testnet' = 'Mainnet'): Promise<WatchOnlyWallet[]> {
    return this.fetchWithSchema('/watchonly/api/v1/wallet', watchOnlyWalletListSchema, {
      searchParams: {network},
    })
  }

  async getWallet(walletId: string): Promise<WatchOnlyWallet> {
    return this.fetchWithSchema(`/watchonly/api/v1/wallet/${walletId}`, watchOnlyWalletSchema)
  }

  async deleteWallet(walletId: string): Promise<void> {
    await this.fetch(`/watchonly/api/v1/wallet/${walletId}`, {method: 'DELETE'})
  }

  async getFreshAddress(walletId: string): Promise<WatchOnlyAddress> {
    return this.fetchWithSchema(`/watchonly/api/v1/address/${walletId}`, watchOnlyAddressSchema)
  }
}

export function createWatchOnlyClient(cfg: {
  baseUrl: string
  adminKey: string
  log?: AppLogger
}): WatchOnlyClient {
  return new WatchOnlyClient(cfg)
}
