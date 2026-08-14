import {msatsToSats} from '@core/money/sats.js'
import type {BotContext} from '@telegram/context.js'
import {type ConversationHost, disabledLinkPreview} from '@telegram/helpers/conversation-host.js'
import {editLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {replyWithTempMessage} from '@telegram/helpers/temp-message.js'
import {usdSuffixesForSats, usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'
import {buildWalletKeyboard} from '../keyboards/wallet.js'

export async function replyWithWallet(ctx: BotContext) {
  const view = await loadLiveWalletBalanceView(ctx)
  return showLivingMenu(ctx, () =>
    ctx.replyWithRichMessage(
      {html: ctx.t('wallet', view)},
      {reply_markup: buildWalletKeyboard(ctx.t)},
    ),
  )
}

export async function editMessageWithWallet(ctx: BotContext) {
  const view = await buildWalletBalanceView(ctx, ctx.user.wallet.balance)
  return editLivingMenu(ctx, () =>
    ctx.editMessageText(
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
      await replyWithTempMessage(ctx, ctx.t('error.nwc-connection'))
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
