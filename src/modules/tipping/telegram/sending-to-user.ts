import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {waitForTransferConfirm} from '@modules/tipping/telegram/wait-for-transfer-confirm.js'
import {waitForUser} from '@modules/tipping/telegram/wait-for-user.js'
import {editHostWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
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
  const confirmed = await waitForTransferConfirm(conversation, ctx, {
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
  await ctx.replyWithChatAction('typing')

  const usedNwc = wallet !== 'internal'
  if (usedNwc && !ctx.user.nwc) throw new NWCConnectionError()
  // The nonce was taken before this wait, so a replay of the click and a second
  // process still holding the conversation reserve the same row. Fee and notice
  // failures stay inside that row: they do not pay the recipient again.
  const result = await conversation.external(() =>
    getRuntime().dmTransfers.settle({
      attemptId: confirmed.nonce,
      fromUserId: ctx.user.id,
      toUserId: toUser.id,
      sats,
      rail: usedNwc ? 'nwc' : 'internal',
    }),
  )
  if (result.outcome === 'rejected') throw new InsufficientFundsError()
  if (result.outcome === 'in_flight') {
    await closeLivingMenu(ctx, host.messageId, markup =>
      ctx.api.editMessageText(
        host.chatId,
        host.messageId,
        ctx.t('sending-to-user.still-confirming'),
        {
          reply_markup: markup,
          ...disabledLinkPreview,
        },
      ),
    )
    return
  }

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

  const reportHtml = ctx.t(
    result.fee === 'failed' || result.notice === 'failed'
      ? 'sending-to-user.completed-warning'
      : 'sending-to-user.completed',
    {
      amount: sats,
      usdSuffix,
      recipient: toUser.username ?? '',
    },
  )

  // The wizard's own screen becomes the report, so no extra message is sent, and it keeps the
  // open-menu row instead of vanishing under the wallet screen the next `showLivingMenu` would send.
  await closeLivingMenu(ctx, host.messageId, markup =>
    ctx.api.editMessageText(host.chatId, host.messageId, reportHtml, {
      reply_markup: markup,
      ...disabledLinkPreview,
    }),
  )
}
