import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'
import {fundedWalletsForAmount, readWalletBalances} from './funded-wallets.js'

export type WalletSelectFlow = 'pay_invoice' | 'tip' | 'create_invoice'

export async function waitForWallet(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {requiredSats?: number; flow?: WalletSelectFlow},
): Promise<'internal' | 'nwc'> {
  const flow = opts?.flow ?? 'create_invoice'
  const requiredSats = opts?.requiredSats
  const posthog = getRuntime().posthog

  if (!ctx.user.nwc) {
    if (requiredSats !== undefined) {
      const internalMsats = await conversation.external(() => ctx.user.wallet.getBalance())
      const funded = fundedWalletsForAmount(
        {internalMsats, nwcMsats: null, nwcBalanceError: false},
        requiredSats,
      )
      if (!funded.internal) {
        captureBotEvent(posthog, 'wallet_resolved', {
          flow,
          selection: 'insufficient',
          required_sats: requiredSats,
          internal_funded: false,
          nwc_funded: false,
        })
        throw new InsufficientFundsError()
      }
    }
    captureBotEvent(posthog, 'wallet_resolved', {
      flow,
      selection: 'no_nwc',
      wallet_type: 'internal',
      required_sats: requiredSats,
    })
    return 'internal'
  }

  if (requiredSats !== undefined) {
    const balances = await conversation.external(async () => {
      const internalMsats = await ctx.user.wallet.getBalance()
      return readWalletBalances({
        internalBalanceMsats: internalMsats,
        nwc: ctx.user.nwc,
        log: getRuntime().log,
      })
    })
    const funded = fundedWalletsForAmount(balances, requiredSats)

    if (!funded.internal && !funded.nwc) {
      captureBotEvent(posthog, 'wallet_resolved', {
        flow,
        selection: 'insufficient',
        required_sats: requiredSats,
        internal_funded: false,
        nwc_funded: false,
        nwc_balance_error: funded.nwcBalanceError,
      })
      throw new InsufficientFundsError()
    }

    if (funded.internal !== funded.nwc) {
      const wallet = funded.internal ? 'internal' : 'nwc'
      const autoKey =
        wallet === 'internal'
          ? 'wait-for-wallet.auto-only-internal'
          : 'wait-for-wallet.auto-only-nwc'
      await ctx.reply(ctx.t(autoKey))
      captureBotEvent(posthog, 'wallet_resolved', {
        flow,
        selection: 'auto_only_funded',
        wallet_type: wallet,
        required_sats: requiredSats,
        internal_funded: funded.internal,
        nwc_funded: funded.nwc,
        nwc_balance_error: funded.nwcBalanceError,
      })
      return wallet
    }
  }

  const message = await replyWithWaitForWallet(ctx)
  const context = await conversation.waitForCallbackQuery(['internal', 'nwc'], {
    otherwise: async ctx => {
      await removeInlineKeyboard(message)
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))

  const wallet = context.callbackQuery.data === 'nwc' ? 'nwc' : 'internal'
  if (wallet === 'nwc') await ctx.reply(ctx.t('wait-for-wallet.nwc'))
  else await ctx.reply(ctx.t('wait-for-wallet.internal'))

  captureBotEvent(posthog, 'wallet_resolved', {
    flow,
    selection: 'manual',
    wallet_type: wallet,
    required_sats: requiredSats,
  })
  return wallet
}

function replyWithWaitForWallet(ctx: ConversationContext) {
  const keyboard = new InlineKeyboard()
    .row({
      callback_data: 'internal',
      text: ctx.t('button.internal-wallet'),
    })
    .add({
      callback_data: 'nwc',
      text: ctx.t('button.nwc-wallet'),
    })
    .row({callback_data: staticCallback.cancel, text: ctx.t('button.cancel')})
  return ctx.reply(ctx.t('wait-for-wallet'), {reply_markup: keyboard})
}
