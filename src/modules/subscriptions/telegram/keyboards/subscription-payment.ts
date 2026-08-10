import type {SubscriptionPayment} from '@infra/db/types.js'
import {
  payJoinBalanceRoute,
  payLightningRoute,
  payOnchainRoute,
  paySubscriptionRoute,
} from '@telegram/callback-data.js'
import {InlineKeyboard} from 'grammy'
import type {JoinBalanceAvailability} from '../join-balance.js'

/** Join entry: method chooser before any invoice/address is created. */
export function buildJoinMethodKeyboard(
  t: (key: string) => string,
  {
    chatId,
    showOnchain = false,
    balanceAvailability,
  }: {
    chatId: number
    showOnchain?: boolean
    /** Independent wallet / NWC buttons when each covers the price. */
    balanceAvailability?: JoinBalanceAvailability | null
  },
) {
  const keyboard = new InlineKeyboard()
  // Row 1: Lightning | Bitcoin (Bitcoin only when on-chain is enabled).
  keyboard.text(t('button.pay-lightning'), payLightningRoute.build({chatId}))
  if (showOnchain) {
    keyboard.text(t('button.pay-onchain'), payOnchainRoute.build({chatId}))
  }
  appendJoinBalanceRows(keyboard, t, chatId, balanceAvailability)
  return keyboard
}

/**
 * Lightning invoice view (join after method pick, or renewal).
 * Join uses independent pay-join-balance buttons; renewal uses pay-subscription.
 */
export function buildSubscriptionPaymentKeyboard(
  t: (key: string) => string,
  {
    payNWC = false,
    payWallet = false,
    paymentId,
    onchainChatId,
    balanceAvailability,
    chatIdForBalancePay,
  }: Args,
) {
  const keyboard = new InlineKeyboard()

  if (onchainChatId !== undefined) {
    keyboard.text(t('button.pay-onchain'), payOnchainRoute.build({chatId: onchainChatId}))
  }

  if (balanceAvailability && chatIdForBalancePay !== undefined) {
    appendJoinBalanceRows(keyboard, t, chatIdForBalancePay, balanceAvailability)
  } else if (payWallet || payNWC) {
    // Renewal: one button per funded rail (no combined fallback).
    if (payWallet) {
      keyboard.row().text(
        t('button.pay-subcription-with-wallet'),
        paySubscriptionRoute.build({paymentId, from: 'wallet'}),
      )
    }
    if (payNWC) {
      keyboard.row().text(
        t('button.pay-subcription-with-nwc'),
        paySubscriptionRoute.build({paymentId, from: 'nwc'}),
      )
    }
  }

  return keyboard
}

/** On-chain join view: switch back to Lightning. */
export function buildOnchainPaymentKeyboard(t: (key: string) => string, chatId: number) {
  return new InlineKeyboard().text(t('button.pay-lightning'), payLightningRoute.build({chatId}))
}

function appendJoinBalanceRows(
  keyboard: InlineKeyboard,
  t: (key: string) => string,
  chatId: number,
  availability: JoinBalanceAvailability | null | undefined,
): void {
  if (!availability) return
  if (availability.walletCovers) {
    keyboard.row().text(
      t('button.pay-subcription-with-wallet'),
      payJoinBalanceRoute.build({chatId, from: 'wallet'}),
    )
  }
  if (availability.nwcCovers) {
    keyboard.row().text(
      t('button.pay-subcription-with-nwc'),
      payJoinBalanceRoute.build({chatId, from: 'nwc'}),
    )
  }
}

interface Args {
  payNWC?: boolean
  payWallet?: boolean
  paymentId: SubscriptionPayment['id']
  /** When set, show Bitcoin for this chat. */
  onchainChatId?: number
  /** Join invoice view: independent ZapGram / NWC buttons. */
  balanceAvailability?: JoinBalanceAvailability | null
  chatIdForBalancePay?: number
}
