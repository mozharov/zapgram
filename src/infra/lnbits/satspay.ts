import type {AppLogger} from '../logger.js'
import {LNBitsAPI} from './lnbits-api.js'
import {type SatsPayCharge, satsPayChargeSchema} from './schemas.js'

export type CreateSatsPayChargeParams = {
  /** Watch-Only wallet id that receives on-chain funds. */
  onchainwallet: string
  /** Amount in satoshis. */
  amount: number
  /** Charge lifetime in minutes. */
  time: number
  description: string
  webhook?: string
  name?: string
  /** If true, unconfirmed balance counts toward paid. Default false. */
  zeroconf?: boolean
}

export class SatsPayClient extends LNBitsAPI {
  constructor({baseUrl, adminKey, log}: {baseUrl: string; adminKey: string; log?: AppLogger}) {
    super({baseUrl, adminKey, log})
  }

  /**
   * Create an on-chain-only charge. Omits `lnbitswallet` so SatsPay only watches the address.
   */
  async createCharge(params: CreateSatsPayChargeParams): Promise<SatsPayCharge> {
    return this.fetchWithSchema('/satspay/api/v1/charge', satsPayChargeSchema, {
      method: 'POST',
      body: JSON.stringify({
        onchainwallet: params.onchainwallet,
        amount: params.amount,
        time: params.time,
        description: params.description,
        zeroconf: params.zeroconf ?? false,
        ...(params.webhook ? {webhook: params.webhook} : {}),
        ...(params.name ? {name: params.name} : {}),
      }),
    })
  }

  async getCharge(chargeId: string): Promise<SatsPayCharge> {
    return this.fetchWithSchema(`/satspay/api/v1/charge/${chargeId}`, satsPayChargeSchema)
  }

  /** Re-check on-chain balance / LN status; may mark paid and fire webhook. */
  async checkChargeBalance(chargeId: string): Promise<SatsPayCharge> {
    return this.fetchWithSchema(`/satspay/api/v1/charge/balance/${chargeId}`, satsPayChargeSchema, {
      method: 'PUT',
    })
  }

  async deleteCharge(chargeId: string): Promise<void> {
    await this.fetch(`/satspay/api/v1/charge/${chargeId}`, {method: 'DELETE'})
  }
}

export function createSatsPayClient(cfg: {
  baseUrl: string
  adminKey: string
  log?: AppLogger
}): SatsPayClient {
  return new SatsPayClient(cfg)
}
