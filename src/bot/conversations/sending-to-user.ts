import type {ConversationContext} from '../context.js'
import type {BotConversation} from '../context.js'
import {waitForSats} from '../helpers/conversations/wait-for-sats.js'
import {waitForUser} from '../helpers/conversations/wait-for-user.js'
import {waitForWallet} from '../helpers/conversations/wait-for-wallet.js'
import {replyWithWallet} from '../helpers/messages/wallet.js'
import {notifySatsReceived} from '../services/notify-sats-recceived.js'
import {getUserWallet, internalTransfer} from '../../services/lnbits-user-wallet.js'

export async function sendingToUser(conversation: BotConversation, ctx: ConversationContext) {
  await ctx.reply(ctx.t('sending-to-user'))
  const toUser = await waitForUser(conversation, ctx)
  const sats = await waitForSats(conversation, ctx)
  const wallet = await waitForWallet(conversation, ctx)
  await ctx.replyWithChatAction('typing')

  if (wallet === 'internal') await internalTransfer(ctx.user.id, toUser.id, sats)
  else {
    const toUserWallet = await getUserWallet(toUser.id)
    const invoice = await toUserWallet.createInvoice({sats})
    await ctx.user.nwc!.payInvoice(invoice.bolt11)
  }

  await notifySatsReceived(toUser.id, sats, ctx.user.username)
  await ctx.reply(ctx.t('sending-to-user.completed', {amount: sats, recipient: toUser.username}))

  await replyWithWallet(ctx)
}
