import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {notifySatsReceived} from '@modules/tipping/notify-sats-received.js'
import {waitForTransferConfirm} from '@modules/tipping/telegram/wait-for-transfer-confirm.js'
import {waitForUser} from '@modules/tipping/telegram/wait-for-user.js'
import {internalTransfer} from '@modules/tipping/transfer.service.js'
import {editHostWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  disabledLinkPreview,
  ensureHost,
  joinWizardHtml,
} from '@telegram/helpers/conversation-host.js'
import {closeLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../runtime.js'

type ResolvedRecipient = {id: number; username: string | null}

/** Overlapping confirms for the same send must not mint a second recipient invoice. */
const userTransfers = new Set<string>()

function reserveUserTransfer(fromId: number, toId: number, sats: number): string | undefined {
  const key = `${fromId}:${toId}:${sats}`
  if (userTransfers.has(key)) return undefined
  userTransfers.add(key)
  return key
}

export async function sendingToUser(conversation: BotConversation, ctx: ConversationContext) {
  const title = ctx.t('sending-to-user')
  const host = await ensureHost(ctx, title)
  const restoreWallet = () => editHostWithWallet(ctx, host)

  const toUser = await waitForUser(conversation, ctx, {
    host,
    html: joinWizardHtml(title, ctx.t('wait-for-user')),
    deleteInput: true,
    onCancel: restoreWallet,
  })
  await payResolvedUser(conversation, ctx, toUser, {host, title, onCancel: restoreWallet})
}

/**
 * Amount, wallet, then an explicit confirm. The recipient invoice (NWC) and the debit
 * both happen only after that confirm. Recipient identity is the user already resolved.
 */
export async function payResolvedUser(
  conversation: BotConversation,
  ctx: ConversationContext,
  toUser: ResolvedRecipient,
  opts: {
    host: ConversationHost
    title: string
    onCancel: (host: ConversationHost) => Promise<unknown>
  },
) {
  const {host, title} = opts
  const selectedUser = ctx.t('wait-for-user.selected', {username: toUser.username ?? ''})
  const sats = await waitForSats(conversation, ctx, {
    host,
    html: joinWizardHtml(title, selectedUser, ctx.t('wait-for-sats')),
    deleteInput: true,
    onCancel: opts.onCancel,
  })
  const {wallet} = await waitForWallet(conversation, ctx, {
    requiredSats: sats,
    flow: 'tip',
    host,
    html: joinWizardHtml(title, selectedUser, ctx.t('wait-for-wallet')),
    onCancel: opts.onCancel,
  })
  const usdSuffix = await conversation.external(() => usdSuffixForSats(sats))
  await waitForTransferConfirm(conversation, ctx, {
    host,
    html: joinWizardHtml(
      title,
      ctx.t('sending-to-user.confirm', {
        username: toUser.username ?? '',
        amount: sats,
        usdSuffix,
        wallet,
      }),
    ),
    onCancel: opts.onCancel,
  })
  const claim = reserveUserTransfer(ctx.user.id, toUser.id, sats)
  if (!claim) return
  try {
    await settleConfirmedTransfer()
  } finally {
    userTransfers.delete(claim)
  }

  async function settleConfirmedTransfer(): Promise<void> {
    await ctx.replyWithChatAction('typing')

    const usedNwc = wallet !== 'internal'
    if (usedNwc && !ctx.user.nwc) throw new NWCConnectionError()
    // Cached across replays: a finished wizard must not mint a second recipient invoice.
    await conversation.external(async () => {
      if (!usedNwc) {
        await internalTransfer(ctx.user.id, toUser.id, sats)
        return
      }
      const toUserWallet = await getUserWallet(toUser.id)
      const invoice = await toUserWallet.createInvoice({sats})
      if (!ctx.user.nwc) throw new NWCConnectionError()
      await ctx.user.nwc.payInvoice(invoice.bolt11)
    })

    // Cached across replays, and a capture failure must not unwind a settled transfer.
    await conversation.external(() => {
      try {
        captureBotEvent(
          getRuntime().posthog,
          'dm_transfer_sent',
          {
            amount_sats: sats,
            payment_method: usedNwc ? 'nwc' : 'internal',
          },
          {distinctId: String(ctx.user.id)},
        )
      } catch {
        // Analytics must never throw into the money path.
      }
    })

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
      usdSuffix,
      recipient: toUser.username ?? '',
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
}
