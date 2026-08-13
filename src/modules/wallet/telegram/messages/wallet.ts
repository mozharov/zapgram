import {msatsToSats} from '@core/money/sats.js'
import type {BotContext} from '@telegram/context.js'
import {type ConversationHost, disabledLinkPreview} from '@telegram/helpers/conversation-host.js'
import {type LivingMenuOptions, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixesForSats, usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'
import {buildWalletKeyboard} from '../keyboards/wallet.js'

export async function replyWithWallet(ctx: BotContext) {
  return renderWallet(ctx)
}

export async function replyWithWalletReplacingCallback(ctx: BotContext) {
  return renderWallet(ctx, {deleteCallbackMessage: true})
}

async function renderWallet(ctx: BotContext, options: LivingMenuOptions = {}) {
  const view = await loadLiveWalletBalanceView(ctx)
  return showLivingMenu(
    ctx,
    () =>
      ctx.replyWithRichMessage(
        {html: ctx.t('wallet', view)},
        {reply_markup: buildWalletKeyboard(ctx.t)},
      ),
    undefined,
    options,
  )
}

/**
 * Renders from `ctx.user.wallet.balance` already loaded by `lnbitsWallet` middleware.
 * Used by the error handler so a failed live balance read is not immediately repeated.
 * No-ops when the middleware never attached a wallet (failure was earlier in the chain).
 */
export async function replyWithCachedWallet(ctx: BotContext) {
  const wallet = ctx.user?.wallet
  if (!wallet) return
  const view = await buildWalletBalanceView(ctx, wallet.balance)
  return showLivingMenu(ctx, () =>
    ctx.replyWithRichMessage(
      {html: ctx.t('wallet', view)},
      {reply_markup: buildWalletKeyboard(ctx.t)},
    ),
  )
}

/** Replaces a callback menu using the balance already loaded by middleware. */
export async function editMessageWithWallet(ctx: BotContext) {
  const view = await buildWalletBalanceView(ctx, ctx.user.wallet.balance)
  return showLivingMenu(ctx, () =>
    ctx.replyWithRichMessage(
      {html: ctx.t('wallet', view)},
      {reply_markup: buildWalletKeyboard(ctx.t), ...disabledLinkPreview},
    ),
  )
}

export async function editHostWithWallet(ctx: BotContext, host: ConversationHost) {
  const view = await loadLiveWalletBalanceView(ctx)
  return ctx.api.editMessageText(
    host.chatId,
    host.messageId,
    {html: ctx.t('wallet', view)},
    {reply_markup: buildWalletKeyboard(ctx.t), ...disabledLinkPreview},
  )
}

async function loadLiveWalletBalanceView(ctx: BotContext) {
  return buildWalletBalanceView(ctx, await ctx.user.wallet.getBalance())
}

async function getNWCBalance(ctx: BotContext) {
  if (ctx.user.nwc) {
    return ctx.user.nwc.getBalance().catch(async (error: unknown) => {
      getRuntime().log.error({error}, 'Failed to get NWC balance')
      await ctx.reply(ctx.t('error.nwc-connection'))
      return null
    })
  }
  return null
}

async function buildWalletBalanceView(ctx: BotContext, balance: number) {
  const nwcBalance = await getNWCBalance(ctx)
  const balanceSats = msatsToSats(balance)
  if (nwcBalance === null) {
    return {
      balance: balanceSats,
      nwcBalance: 'no',
      usdSuffix: await usdSuffixForSats(balanceSats),
      nwcUsdSuffix: '',
    }
  }
  const nwcSats = msatsToSats(nwcBalance)
  const [usdSuffix = '', nwcUsdSuffix = ''] = await usdSuffixesForSats([balanceSats, nwcSats])
  return {
    balance: balanceSats,
    nwcBalance: nwcSats,
    usdSuffix,
    nwcUsdSuffix,
  }
}
