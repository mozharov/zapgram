import {describe, expect, test} from 'bun:test'
import type {NewOnchainChatPayment, OnchainChatPayment} from '@infra/db/types.js'
import type {CreateSatsPayChargeParams} from '@infra/lnbits/satspay.js'
import {createOnchainJoinPaymentService, ONCHAIN_CHARGE_TIME_MINUTES} from './payment.service.js'

describe('createOnchainJoinPaymentService', () => {
  test('creates SatsPay charge with zeroconf and chat price', async () => {
    const created: CreateSatsPayChargeParams[] = []
    const service = createOnchainJoinPaymentService({
      onchainPayments: {
        findOpenForUserChat: async () => null,
        create: async (data: NewOnchainChatPayment): Promise<OnchainChatPayment> =>
          ({
            id: 'oc-1',
            chatId: data.chatId,
            userId: data.userId,
            satspayChargeId: data.satspayChargeId,
            address: data.address,
            amountSats: data.amountSats,
            status: data.status ?? 'pending',
            expiresAt: data.expiresAt,
            watchUntil: data.watchUntil,
            paidAt: null,
            txid: null,
            telegramChatId: null,
            telegramMessageId: null,
            subscriptionPaymentId: null,
            createdAt: new Date(),
          }) as OnchainChatPayment,
      } as never,
      satsPay: {
        createCharge: async (params: CreateSatsPayChargeParams) => {
          created.push(params)
          return {
            id: 'ch-1',
            user: 'u',
            amount: params.amount,
            time: params.time,
            timestamp: new Date(),
            balance: 0,
            pending: 0,
            zeroconf: params.zeroconf ?? false,
            fasttrack: false,
            paid: false,
            onchainwallet: params.onchainwallet,
            onchainaddress: 'bc1qtest',
          }
        },
      },
      host: 'https://bot.example',
      webhookSecret: 'sec',
      log: {info: () => {}, error: () => {}, warn: () => {}, debug: () => {}},
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const result = await service.createOrReuse({
      chat: {
        id: -100,
        price: 1000,
        title: 'Paid',
        watchonlyWalletId: 'wo-1',
        onchainEnabled: true,
      },
      userId: 2,
    })

    expect(result.status).toBe('created')
    expect(created).toEqual([
      {
        onchainwallet: 'wo-1',
        amount: 1000,
        time: ONCHAIN_CHARGE_TIME_MINUTES,
        description: 'ZapGram access: Paid',
        webhook: 'https://bot.example/satspay/webhook/sec',
        name: 'chat:-100:user:2',
        zeroconf: true,
      },
    ])
  })
})
