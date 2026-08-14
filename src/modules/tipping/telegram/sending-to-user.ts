import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {notifySatsReceived} from '@modules/tipping/notify-sats-received.js'
import {waitForUser} from '@modules/tipping/telegram/wait-for-user.js'
import {internalTransfer} from '@modules/tipping/transfer.service.js'
import {editHostWithSendMenu} from '@modules/wallet/telegram/messages/send-menu.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  disabledLinkPreview,
  ensureHost,
  joinWizardHtml,
} from '@telegram/helpers/conversation-host.js'
import {closeLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../runtime.js'

export async function sendingToUser(conversation: BotConversation, ctx: ConversationContext) {
  const title = ctx.t('sending-to-user')
  const host = await ensureHost(ctx, title)
  const restoreSendMenu = () => editHostWithSendMenu(ctx, host)

  const toUser = await waitForUser(conversation, ctx, {
    host,
    html: joinWizardHtml(title, ctx.t('wait-for-user')),
    deleteInput: true,
    onCancel: restoreSendMenu,
  })
  const selectedUser = ctx.t('wait-for-user.selected', {username: toUser.username ?? ''})
  const sats = await waitForSats(conversation, ctx, {
    host,
    html: joinWizardHtml(title, selectedUser, ctx.t('wait-for-sats')),
    deleteInput: true,
    onCancel: restoreSendMenu,
  })
  const {wallet} = await waitForWallet(conversation, ctx, {
    requiredSats: sats,
    flow: 'tip',
    host,
    html: joinWizardHtml(title, selectedUser, ctx.t('wait-for-wallet')),
    onCancel: restoreSendMenu,
  })
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
  // The final report drops the wizard's title/breadcrumb lines: the send already happened, so only
  // the confirmation itself is worth keeping.
  const reportHtml = ctx.t('sending-to-user.completed', {
    amount: sats,
    usdSuffix: await conversation.external(() => usdSuffixForSats(sats)),
    recipient: toUser.username,
  })

  // The wizard's own screen becomes the report, so no extra message is sent, and it keeps the
  // open-menu row instead of vanishing under the wallet screen the next `showLivingMenu` would send.
  await closeLivingMenu(ctx, host.messageId, markup =>
    ctx.api.editMessageText(host.chatId, host.messageId, reportHtml, {
      reply_markup: markup,
      ...disabledLinkPreview,
    }),
  )
}
