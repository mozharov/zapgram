import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {notifySatsReceived} from '@modules/tipping/notify-sats-received.js'
import {waitForUser} from '@modules/tipping/telegram/wait-for-user.js'
import {internalTransfer} from '@modules/tipping/transfer.service.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../runtime.js'

export async function sendingToUser(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('sending-to-user'))
  const toUser = await waitForUser(conversation, ctx)
  const sats = await waitForSats(conversation, ctx)
  const wallet = await waitForWallet(conversation, ctx, {requiredSats: sats, flow: 'tip'})
  await ctx.replyWithChatAction('typing')

  const usedNwc = wallet !== 'internal'
  if (!usedNwc) await internalTransfer(ctx.user.id, toUser.id, sats)
  else {
    const toUserWallet = await getUserWallet(toUser.id)
    const invoice = await toUserWallet.createInvoice({sats})
    if (!ctx.user.nwc) throw new NWCConnectionError()
    await ctx.user.nwc.payInvoice(invoice.bolt11)
  }

  // Best-effort voluntary platform donation — never blocks the transfer.
  await getRuntime().donationCollect.tryCollect({
    userId: ctx.user.id,
    baseAmountSats: sats,
    kind: 'tip',
    preferredRail: usedNwc ? 'nwc' : 'internal',
    nwc: usedNwc ? ctx.user.nwc : undefined,
    nwcUrl: ctx.user.nwcUrl,
    user: ctx.user,
  })

  await notifySatsReceived(toUser.id, sats, ctx.user.username)
  await ctx.reply(
    ctx.t('sending-to-user.completed', {
      amount: sats,
      usdSuffix: await conversation.external(() => usdSuffixForSats(sats)),
      recipient: toUser.username,
    }),
  )

  await replyWithWallet(ctx)
}
