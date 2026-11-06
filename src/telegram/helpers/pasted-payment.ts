import {createHash} from 'node:crypto'
import {type PaymentRequest, recognizePaymentRequest} from '@core/lightning/payment-request.js'
import {payPastedBackRoute, payPastedRoute} from '@telegram/callback-data.js'
import type {BotContext, BotConversation, ConversationContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {isMessageToDeleteNotFound} from '../errors/vanished-message.js'
import {disabledLinkPreview} from './conversation-host.js'
import {type ActivePrompt, cancelledPromptState, deactivatePrompt} from './conversation-prompt.js'

/** Which pasted payment requests a step should intercept. Free text uses `none`. */
export type PaymentIntercept = 'bolt11' | 'all' | 'none'

const TOKEN_HEX = 16

/**
 * Same-process dedupe of Pay clicks that overlap inside one handler. This does not
 * store the invoice and does not stick after the handler returns: a later paste of
 * the same bolt11 can pay again. While one click is inside the handler, a second
 * tap loses the race instead of opening another payment.
 */
const payStarting = new Set<string>()

function payKey(userId: number, token: string): string {
  return `${userId}:${token}`
}

/** True for the click that may open payment. Synchronous: call before any await. */
export function reservePastedPay(userId: number, token: string): boolean {
  const key = payKey(userId, token)
  if (payStarting.has(key)) return false
  payStarting.add(key)
  return true
}

export function releasePastedPay(userId: number, token: string): void {
  payStarting.delete(payKey(userId, token))
}

/**
 * Bound to the user and the canonical request, and stable across a conversation
 * replay: the same paste always rebuilds the same callback_data. Nothing about
 * the invoice is kept in process memory — after a restart the button reads it
 * back from the message it replies to.
 */
export function pastedPaymentToken(userId: number, value: string): string {
  return createHash('sha256').update(`${userId}\n${value}`).digest('hex').slice(0, TOKEN_HEX)
}

/**
 * The bolt11 the Pay button was built for, or undefined when the replied message
 * is missing, is not that invoice, or belongs to another user.
 */
export function bolt11MatchingToken(
  userId: number | undefined,
  token: string,
  text: string | undefined,
): string | undefined {
  if (userId === undefined || text === undefined) return undefined
  const request = recognizePaymentRequest(text)
  if (request?.kind !== 'bolt11') return undefined
  if (pastedPaymentToken(userId, request.value) !== token) return undefined
  return request.value
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
 * button: paying them is a later task.
 */
export async function replyWithUnsupportedPayment(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.t('pasted-payment-unsupported'), {...disabledLinkPreview})
}

/**
 * `conversation.wait()`, then a notice when the text is a payment request this step intercepts.
 *
 * `intercept: 'none'` returns the text unchanged and makes no extra API call, so a
 * free-text field (memo, feature text, custom message, broadcast source) accepts an
 * email, an address, an LNURL, or a bolt11 as ordinary input and replays like before.
 * `all` notices every recognized request. `bolt11` notices only an invoice.
 *
 * A bolt11 gets Pay and Back, sent as a reply to the paste so the invoice can be read
 * back from that reply after a restart. Pay deletes that offer first. Only a
 * successful delete leaves the step: the prompt is marked cancelled and the
 * button falls through to the existing pay-invoice flow. A delete Telegram did
 * not confirm (rate limit, 5xx, network, "can't be deleted", a lost response)
 * answers "try again" and keeps the step. "message to delete not found" means
 * another click already took the offer: no second payment. An address or LNURL
 * gets the unsupported note and Back only. Back returns undefined so the caller
 * waits again on the same step.
 *
 * A Pay or Back click on an offer this step is not showing gets a toast and is
 * ignored, so it cannot fall through and start a second payment.
 *
 * A step that already expects a payment request (the invoice field) must keep
 * calling `conversation.wait()` directly.
 */
export async function waitForStepInput(
  conversation: BotConversation,
  prompt: ActivePrompt,
  opts: {intercept: PaymentIntercept},
): Promise<ConversationContext | undefined> {
  let current = await conversation.wait()
  for (;;) {
    if (isOfferButton(current)) {
      await current.answerCallbackQuery({text: current.t('callback-answer.pasted-payment-stale')})
      current = await conversation.wait()
      continue
    }

    const userId = current.from?.id
    const request =
      userId === undefined ? null : recognizePaymentRequest(current.message?.text ?? '')
    if (!request || userId === undefined || !intercepts(opts.intercept, request)) return current

    const token = pastedPaymentToken(userId, request.value)
    const sourceId = current.message?.message_id
    const offer = await current.reply(noticeHtml(current, request), {
      ...(sourceId === undefined
        ? {}
        : {
            reply_parameters: {message_id: sourceId, allow_sending_without_reply: true},
          }),
      reply_markup:
        request.kind === 'bolt11' ? bolt11Keyboard(current, token) : backKeyboard(current, token),
      ...disabledLinkPreview,
    })
    let choice = await conversation.wait()
    for (;;) {
      const data = choice.callbackQuery?.data
      const fromOffer = callbackFromMessage(choice, offer.chat.id, offer.message_id)
      const payingThisOffer =
        fromOffer &&
        request.kind === 'bolt11' &&
        data === payPastedRoute.build({token}) &&
        bolt11MatchingToken(userId, token, repliedText(choice)) === request.value

      if (payingThisOffer) {
        const claim = await claimPastedOffer(choice)
        if (claim === 'claimed') {
          // The delete won. Only then leave the step. The handler opens payment
          // for this same click and must not treat our delete as a second claim.
          await deactivatePrompt(conversation, prompt, cancelledPromptState(choice, prompt))
          markPastedPayHandoff(choice)
          return conversation.halt({next: true})
        }
        await answerOfferClick(
          choice,
          choice.t(
            claim === 'already-gone'
              ? 'callback-answer.pasted-payment-stale'
              : 'callback-answer.pasted-payment-retry',
          ),
        )
        choice = await conversation.wait()
        continue
      }
      if (fromOffer && data === payPastedRoute.build({token})) {
        await answerOfferClick(choice, choice.t('callback-answer.pasted-payment-missing'))
        await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
        return undefined
      }
      if (fromOffer && data === payPastedBackRoute.build({token})) {
        await answerOfferClick(choice)
        await choice.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
        return undefined
      }

      await current.api.deleteMessage(offer.chat.id, offer.message_id).catch(() => undefined)
      current = choice
      break
    }
  }
}

function intercepts(mode: PaymentIntercept, request: PaymentRequest): boolean {
  if (mode === 'none') return false
  if (mode === 'bolt11') return request.kind === 'bolt11'
  return true
}

function noticeHtml(ctx: Pick<ConversationContext, 't'>, request: PaymentRequest): string {
  if (request.kind === 'bolt11') return ctx.t('pasted-payment')
  return ctx.t('pasted-payment-unsupported')
}

function isOfferButton(ctx: ConversationContext): boolean {
  const data = ctx.callbackQuery?.data
  if (!data) return false
  return payPastedRoute.pattern.test(data) || payPastedBackRoute.pattern.test(data)
}

function callbackFromMessage(ctx: ConversationContext, chatId: number, messageId: number): boolean {
  const message = ctx.callbackQuery?.message
  return (
    message !== undefined &&
    'message_id' in message &&
    message.message_id === messageId &&
    message.chat.id === chatId
  )
}

export function repliedText(ctx: {
  callbackQuery?: {message?: {reply_to_message?: {text?: string}}}
}): string | undefined {
  const replied = ctx.callbackQuery?.message?.reply_to_message
  return typeof replied?.text === 'string' ? replied.text : undefined
}

/** Same-click handoff: the conversation already deleted the offer, the handler opens payment. */
const payHandoff = new Set<number>()

export function markPastedPayHandoff(ctx: {update: {update_id: number}}): void {
  payHandoff.add(ctx.update.update_id)
}

export function takePastedPayHandoff(ctx: {update: {update_id: number}}): boolean {
  const hit = payHandoff.has(ctx.update.update_id)
  payHandoff.delete(ctx.update.update_id)
  return hit
}

export type PastedOfferClaim = 'claimed' | 'already-gone' | 'retry'

type OfferClick = {
  api: {deleteMessage: (chatId: number, messageId: number) => Promise<boolean>}
  chat?: {id: number}
  callbackQuery?: {message?: unknown}
  log: {warn: (bindings: object, message?: string) => void}
  answerCallbackQuery: (extra?: {text: string}) => Promise<unknown>
  reply: (text: string, extra?: object) => Promise<unknown>
}

/**
 * One delete of the offer message. `claimed` is only `true` from Telegram.
 * `already-gone` is only "message to delete not found". Everything else, including
 * a lost or unreadable response, is `retry`: the step stays, and a later click
 * can try the same button. No invoice is stored here.
 */
export async function claimPastedOffer(ctx: OfferClick): Promise<PastedOfferClaim> {
  const message = ctx.callbackQuery?.message
  if (!message || !hasMessageId(message) || ctx.chat?.id === undefined) return 'retry'
  try {
    const deleted = await ctx.api.deleteMessage(ctx.chat.id, message.message_id)
    if (deleted === true) return 'claimed'
    ctx.log.warn({messageId: message.message_id}, 'Pasted offer delete was not confirmed')
    return 'retry'
  } catch (error) {
    if (isMessageToDeleteNotFound(error)) return 'already-gone'
    ctx.log.warn({error, messageId: message.message_id}, 'Pasted offer delete failed')
    return 'retry'
  }
}

function hasMessageId(message: object): message is {message_id: number} {
  return 'message_id' in message && typeof message.message_id === 'number'
}

/** Toast the click. A failed answer must not decide whether the offer was claimed. */
export async function answerOfferClick(ctx: OfferClick, text?: string): Promise<void> {
  try {
    await (text === undefined ? ctx.answerCallbackQuery() : ctx.answerCallbackQuery({text}))
  } catch (error) {
    ctx.log.warn({error}, 'Failed to answer pasted payment button')
    if (text === undefined) return
    await ctx.reply(text, disabledLinkPreview).catch((replyError: unknown) => {
      ctx.log.warn({error: replyError}, 'Failed to reply about pasted payment button')
    })
  }
}
