import {payingInvoice} from '@modules/invoices/telegram/conversations/paying-invoice.js'
import {payingLnurl} from '@modules/invoices/telegram/conversations/paying-lnurl.js'
import {payResolvedUser} from '@modules/tipping/telegram/sending-to-user.js'
import {snapshotSendTarget} from '@modules/tipping/telegram/snapshot-send-target.js'
import {editHostWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {ensureHost, showHostOrReply} from '@telegram/helpers/conversation-host.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../runtime.js'

/**
 * Wallet Send. One prompt classifies the paste, then the existing pay engines run.
 * `@username` is only handled here: outside this wizard it stays ordinary text.
 */
export async function sendingPayment(conversation: BotConversation, ctx: ConversationContext) {
  const html = ctx.t('send-menu')
  const host = await ensureHost(ctx, html)
  const restoreWallet = () => editHostWithWallet(ctx, host)
  const message = await showHostOrReply(
    ctx,
    html,
    new InlineKeyboard([[{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}]]),
    host,
  )
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.enter-send-target'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await waitForStepInput(conversation, prompt, {intercept: 'none'})
    if (!next) continue
    const updateKind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (updateKind === 'cancel') {
      await next.answerCallbackQuery()
      await restoreWallet()
      return conversation.halt()
    }
    if (updateKind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    // One snapshot for this text. Replay returns it instead of resolving @username again.
    const result = await snapshotSendTarget(conversation, next, next.message?.text ?? '')
    if (result.kind === 'invalid' || result.kind === 'self' || result.kind === 'unknown') {
      const key =
        result.kind === 'self'
          ? 'error.to-yourself'
          : result.kind === 'unknown'
            ? 'error.user-does-not-have-wallet'
            : 'send-menu.invalid'
      await replyWithConversationTempMessage(conversation, next, next.t(key))
      continue
    }

    await clearPromptControls(conversation, prompt)
    await deleteMessageSafely(next)
    const targetKind = result.kind === 'user' ? 'username' : result.kind
    // After the last wait of this step. Replay returns the cached call and does not log twice.
    await conversation.external(() => {
      ctx.log.info({kind: targetKind}, 'Send target accepted')
      try {
        captureBotEvent(
          getRuntime().posthog,
          'send_target_accepted',
          {kind: targetKind},
          {distinctId: String(ctx.user.id)},
        )
      } catch {
        // Analytics must never throw into the money path.
      }
    })

    if (result.kind === 'bolt11') {
      await payingInvoice(conversation, next, result.value, {host})
      return
    }
    if (result.kind === 'lightning-address' || result.kind === 'lnurl') {
      await payingLnurl(conversation, next, result.value, {host, onCancel: restoreWallet})
      return
    }
    if (result.kind !== 'user') return
    await payResolvedUser(
      conversation,
      next,
      {id: result.userId, username: result.username},
      {
        host,
        title: ctx.t('sending-to-user'),
        onCancel: restoreWallet,
      },
    )
    // The receipt is this screen now. Staying in the loop would take the next
    // message — including Open wallet — as another send and paint over the receipt.
    return
  }
}
