import {createHash} from 'node:crypto'
import {type PaymentRequest, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../runtime.js'
import {disabledLinkPreview} from './conversation-host.js'
import {removeInlineKeyboardById} from './keyboard.js'

type StepPrompt = {chatId: number; messageId: number}

const TOKEN_HEX = 16

type Pending = {userId: number; request: PaymentRequest}

const byToken = new Map<string, Pending>()
const tokenByUser = new Map<number, string>()

/**
 * Stable for a user and a request, so a conversation replay rebuilds the same
 * callback_data the offer was sent with. A random token would miss the replay log.
 */
function tokenFor(userId: number, value: string): string {
  return createHash('sha256').update(`${userId}\n${value}`).digest('hex').slice(0, TOKEN_HEX)
}

export function rememberPastedPayment(userId: number, request: PaymentRequest): string {
  const token = tokenFor(userId, request.value)
  const previous = tokenByUser.get(userId)
  if (previous && previous !== token) byToken.delete(previous)
  byToken.set(token, {userId, request})
  tokenByUser.set(userId, token)
  return token
}

export function takePastedPayment(userId: number, token: string): PaymentRequest | undefined {
  const pending = byToken.get(token)
  if (!pending || pending.userId !== userId) return undefined
  byToken.delete(token)
  if (tokenByUser.get(userId) === token) tokenByUser.delete(userId)
  return pending.request
}

function forgetPastedPayment(userId: number, token: string): void {
  const pending = byToken.get(token)
  if (!pending || pending.userId !== userId) return
  byToken.delete(token)
  if (tokenByUser.get(userId) === token) tokenByUser.delete(userId)
}

function bolt11Keyboard(ctx: ConversationContext, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('button.pay-pasted'), payPastedRoute.build({token}))
    .row()
    .text(ctx.t('button.pasted-payment-back'), payPastedBackRoute.build({token}))
}

function backKeyboard(ctx: ConversationContext, token: string): InlineKeyboard {
  return new InlineKeyboard().text(
    ctx.t('button.pasted-payment-back'),
    payPastedBackRoute.build({token}),
  )
}

/**
 * Outside a wizard there is no step to return to. Address and LNURL have no pay
 * button: paying them is a later task, and Pay used to open an invoice dialog
 * that then rejected the same paste.
 */
export async function replyWithUnsupportedPayment(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.t('pasted-payment-unsupported'), {...disabledLinkPreview})
}

/**
 * `conversation.wait()`, then a notice when the text is a BOLT11, Lightning address, or LNURL.
 *
 * A bolt11 gets Pay and Back. Pay never returns: the conversation halts and the button
 * falls through to the existing pay-invoice flow. An address or LNURL gets the
 * unsupported note and Back only — paying those is a later task.
 * Back returns undefined so the caller waits again on the same step. Any other update
 * is returned as-is.
 *
 * A step that already expects a payment request (the invoice field) must keep
 * calling `conversation.wait()` directly. Normal input makes no extra API call,
 * so an in-progress wizard replays the same way it did before this check existed.
 */
export async function waitForStepInput(
  conversation: BotConversation,
  prompt: StepPrompt,
): Promise<ConversationContext | undefined> {
  let current = await conversation.wait()
  for (;;) {
    const userId = current.from?.id
    const request =
      userId === undefined ? null : recognizePaymentRequest(current.message?.text ?? '')
    if (!request || userId === undefined) return current

    const token = tokenFor(userId, request.value)
    if (request.kind === 'bolt11') rememberPastedPayment(userId, request)
    const offer = await current.reply(noticeHtml(current, request), {
      reply_markup:
        request.kind === 'bolt11' ? bolt11Keyboard(current, token) : backKeyboard(current, token),
      ...disabledLinkPreview,
    })
    const choice = await conversation.wait()
    const data = choice.callbackQuery?.data
    const message = choice.callbackQuery?.message
    const fromOffer =
      message !== undefined &&
      'message_id' in message &&
      message.message_id === offer.message_id &&
      message.chat.id === offer.chat.id

    if (fromOffer && request.kind === 'bolt11' && data === payPastedRoute.build({token})) {
      // Drop the step's buttons before the wizard ends. Pay can still fail inside the
      // existing flow (bad bolt11, not enough balance) before that flow has a screen of
      // its own. The step must not stay tappable with no conversation behind it.
      await conversation.external(() => clearPromptKeyboard(prompt))
      return conversation.halt({next: true})
    }
    if (fromOffer && data === payPastedBackRoute.build({token})) {
      await choice.answerCallbackQuery()
      await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
      forgetPastedPayment(userId, token)
      return undefined
    }

    await current.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
    forgetPastedPayment(userId, token)
    current = choice
  }
}

function noticeHtml(ctx: Pick<ConversationContext, 't'>, request: PaymentRequest): string {
  if (request.kind === 'bolt11') return ctx.t('pasted-payment')
  return ctx.t('pasted-payment-unsupported')
}

/** Clears the step keyboard only. The message stays until a later screen replaces it. */
async function clearPromptKeyboard(prompt: StepPrompt): Promise<void> {
  await removeInlineKeyboardById(prompt.chatId, prompt.messageId).catch((error: unknown) => {
    getRuntime().log.warn(
      {error, chatId: prompt.chatId, messageId: prompt.messageId},
      'Failed to clear wizard prompt before pay',
    )
  })
}
