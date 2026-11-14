import {AppError} from '@core/errors/app-error.js'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {resolveAppLocale} from '@core/i18n/locale.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {satsToMsats} from '@core/money/sats.js'
import {editMessageWidgetData, sendWidget} from '@infra/telegram/widget-api.js'
import {
  clearInvoiceWidgetMessage,
  createPendingInvoice,
  getPendingInvoiceBy,
  moveInvoiceWidgetMessage,
  setInvoiceWidgetMessage,
} from '@modules/invoices/repository.js'
import {waitForMemoText} from '@modules/invoices/telegram/helpers/wait-for-memo.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
import {
  buildInvoiceWidgetDocument,
  type InvoiceWidgetDocument,
  invoiceWidgetNeedsNewMessage,
} from '@modules/invoices/telegram/invoice-widget.js'
import {editHostWithWallet, replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  ensureHost,
  joinWizardHtml,
  promptMessageFromHost,
} from '@telegram/helpers/conversation-host.js'
import {
  clearPromptControls,
  createActivePrompt,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {copyableText} from '@telegram/helpers/copy-text.js'
import {closeLivingMenu} from '@telegram/helpers/living-menu.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard, InputFile} from 'grammy'
import QRCode from 'qrcode'
import {getRuntime} from '../../../../runtime.js'

export async function creatingInvoice(conversation: BotConversation, ctx: ConversationContext) {
  const title = ctx.t('creating-invoice')
  const host = await ensureHost(ctx, title)
  const restoreWallet = () => editHostWithWallet(ctx, host)

  const {wallet} = await waitForWallet(conversation, ctx, {
    flow: 'create_invoice',
    host,
    html: joinWizardHtml(title, ctx.t('wait-for-wallet')),
    onCancel: restoreWallet,
  })
  const selectedWallet = ctx.user.nwc ? selectedWalletHtml(ctx, wallet) : undefined
  const sats = await waitForSats(conversation, ctx, {
    host,
    html: joinWizardHtml(title, selectedWallet, ctx.t('wait-for-sats')),
    deleteInput: true,
    onCancel: restoreWallet,
  })
  const usdSuffix = await conversation.external(() => usdSuffixForSats(sats))

  await ctx.replyWithChatAction('typing')
  // LNbits + DB must not re-run when the conversation replays after later waits.
  // Errors are returned as data: conversation.external structuredClones throws and drops AppError.
  let paymentRequest = await mintInvoiceOnce(conversation, () => createInvoice(ctx, wallet, sats))
  captureInvoiceCreated({sats, wallet, hasMemo: false, isReplacement: false})

  const invoiceView = await renderInvoice(conversation, ctx, host, paymentRequest, {
    wallet,
    usdSuffix,
    offerAddMemo: true,
  })
  const qrPrompt = createActivePrompt(invoiceView.message, {
    kind: 'caption',
    html: invoiceView.html,
    actionLabel: ctx.t('conversation-action.invoice-memo-options'),
  })

  const next = await conversation.wait()
  if (
    next.callbackQuery?.data === staticCallback.addInvoiceMemo &&
    isCallbackFromPrompt(next, qrPrompt)
  ) {
    await next.answerCallbackQuery()
    await clearPromptControls(conversation, qrPrompt)
  } else if (
    next.callbackQuery?.data === staticCallback.wallet &&
    isCallbackFromPrompt(next, qrPrompt)
  ) {
    // Invoice is already live. Open Wallet as a new message and drop the invoice buttons — but
    // retire the QR message first, or the wallet send below would delete it as a superseded menu.
    // Do not fall through: the global wallet handler would replace this invoice.
    await next.answerCallbackQuery()
    await closeLivingMenu(ctx, qrPrompt.messageId, markup =>
      ctx.api.editMessageReplyMarkup(qrPrompt.chatId, qrPrompt.messageId, {reply_markup: markup}),
    )
    await replyWithWallet(ctx)
    return conversation.halt()
  } else {
    // Invoice is already live. Any other update (command, bolt11, leftover text)
    // drops the memo buttons so the update can open Wallet or start payment. The invoice itself
    // keeps living, so re-render its terminal state instead of annotating it as cancelled.
    // Pasted-payment intercept is off here: a bolt11 already starts the pay flow via this
    // handoff, and offering first would add a confirmation the paste does not have today.
    await renderFinalInvoice(conversation, ctx, invoiceView, paymentRequest, {wallet, usdSuffix})
    return conversation.halt({next: true})
  }

  captureBotEvent(getRuntime().posthog, 'invoice_memo_add_tapped', {
    amount_sats: sats,
    wallet_type: wallet,
  })

  const memoHtml = joinWizardHtml(invoiceView.html, ctx.t('wait-for-memo'))
  const memoResult = await waitForMemoText(conversation, ctx, {
    host: {chatId: invoiceView.message.chat.id, messageId: invoiceView.message.message_id},
    html: memoHtml,
    kind: 'caption',
  })
  if (memoResult.status !== 'ok') {
    captureBotEvent(getRuntime().posthog, 'invoice_memo_add_cancelled', {
      reason: memoResult.reason,
      amount_sats: sats,
      wallet_type: wallet,
    })
    // Both an explicit cancel and an interrupting update (new invoice, command, ...) leave the
    // invoice itself unchanged, so re-render its terminal state either way.
    await renderFinalInvoice(conversation, ctx, invoiceView, paymentRequest, {wallet, usdSuffix})
    if (memoResult.status === 'cancelled') return conversation.halt()
    return conversation.halt({next: true})
  }

  await ctx.replyWithChatAction('typing')
  // Keep the no-memo pending row: the old BOLT11 stays payable until expiry.
  paymentRequest = await mintInvoiceOnce(conversation, () =>
    createInvoice(ctx, wallet, sats, memoResult.memo),
  )
  captureInvoiceCreated({sats, wallet, hasMemo: true, isReplacement: true})
  await renderFinalInvoice(conversation, ctx, invoiceView, paymentRequest, {wallet, usdSuffix})
}

/**
 * Run mint/DB work once across conversation replays. Return failures as plain data so
 * AppError subclasses survive `structuredClone` inside `conversation.external`.
 */
async function mintInvoiceOnce(
  conversation: BotConversation,
  task: () => Promise<string>,
): Promise<string> {
  const result = await conversation.external(async () => {
    try {
      return {ok: true as const, paymentRequest: await task()}
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error'
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof AppError ? error.code : undefined
      return {ok: false as const, name, message, code}
    }
  })
  if (result.ok) return result.paymentRequest
  if (result.code === 'invoice_generation_failed' || result.name === InvoiceGenerationError.name) {
    throw new InvoiceGenerationError({message: result.message})
  }
  if (result.code === 'nwc_connection' || result.name === NWCConnectionError.name) {
    throw new NWCConnectionError({message: result.message})
  }
  throw new Error(result.message)
}

function captureInvoiceCreated(props: {
  sats: number
  wallet: 'internal' | 'nwc'
  hasMemo: boolean
  isReplacement: boolean
}) {
  captureBotEvent(getRuntime().posthog, 'invoice_created', {
    amount_sats: props.sats,
    wallet_type: props.wallet,
    has_memo: props.hasMemo,
    memo_path: props.hasMemo ? 'added_after' : 'none',
    is_replacement: props.isReplacement,
  })
}

async function createInvoice(
  ctx: ConversationContext,
  wallet: 'internal' | 'nwc',
  sats: number,
  memo?: string,
): Promise<string> {
  const msats = satsToMsats(sats)
  let paymentRequest: string
  if (wallet === 'internal') {
    const invoice = await ctx.user.wallet.createInvoice({sats, memo})
    await createPendingInvoice({
      userId: ctx.user.id,
      paymentRequest: invoice.bolt11,
      paymentHash: invoice.payment_hash,
      expiresAt: invoice.expiry ?? undefined,
    })
    paymentRequest = invoice.bolt11
    // Called through `mintInvoiceOnce` → `conversation.external`, so this logs once per mint
    // instead of once per conversation replay.
    ctx.log.info(
      {sats, source: wallet, paymentHash: invoice.payment_hash, hasMemo: Boolean(memo)},
      'Invoice created',
    )
  } else {
    if (!ctx.user.nwc) throw new NWCConnectionError()
    const invoice = await ctx.user.nwc.createInvoice(msats, memo)
    paymentRequest = invoice.invoice
    ctx.log.info({sats, source: wallet, hasMemo: Boolean(memo)}, 'Invoice created')
  }
  return paymentRequest
}

function selectedWalletHtml(ctx: ConversationContext, wallet: 'internal' | 'nwc'): string {
  return wallet === 'nwc' ? ctx.t('wait-for-wallet.nwc') : ctx.t('wait-for-wallet.internal')
}

type ShownInvoice = {
  message: {chat: {id: number}; message_id: number}
  html: string
  mode: 'widget' | 'photo'
  paymentRequest: string
}

async function renderInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  host: ConversationHost,
  paymentRequest: string,
  opts: {wallet: 'internal' | 'nwc'; usdSuffix: string; offerAddMemo: boolean},
): Promise<ShownInvoice> {
  const caption = await buildInvoiceCaption(ctx, paymentRequest, opts)
  const keyboard = invoiceKeyboard(ctx, paymentRequest, opts.offerAddMemo)
  const widget = await trySendInvoiceWidget(
    conversation,
    ctx,
    host,
    paymentRequest,
    caption,
    keyboard,
    opts.wallet,
  )
  if (widget) {
    return {
      message: {chat: {id: widget.chatId}, message_id: widget.messageId},
      html: caption.html,
      mode: 'widget',
      paymentRequest,
    }
  }

  await ctx.api.editMessageMedia(
    host.chatId,
    host.messageId,
    {type: 'photo', media: new InputFile(caption.buffer), caption: caption.html},
    {reply_markup: keyboard},
  )
  return {message: promptMessageFromHost(host), html: caption.html, mode: 'photo', paymentRequest}
}

/**
 * The invoice's terminal state (no more memo decision left): the QR/caption message becomes the
 * receipt in place, so no extra message is sent and it keeps a self-disappearing "Open wallet" row
 * instead of vanishing under a fresh wallet screen. That row replaces `invoiceKeyboard`'s own wallet
 * button, so the keyboard underneath carries only the copy-invoice button.
 */
async function renderFinalInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  shown: ShownInvoice,
  paymentRequest: string,
  opts: {wallet: 'internal' | 'nwc'; usdSuffix: string},
): Promise<void> {
  const caption = await buildInvoiceCaption(ctx, paymentRequest, opts)
  const keyboard = invoiceKeyboard(ctx, paymentRequest, false, {includeWalletButton: false})
  if (shown.mode === 'widget') {
    await renderFinalWidget(
      conversation,
      ctx,
      shown,
      paymentRequest,
      caption,
      keyboard,
      opts.wallet,
    )
    return
  }
  await closeLivingMenu(
    ctx,
    shown.message.message_id,
    markup =>
      ctx.api.editMessageMedia(
        shown.message.chat.id,
        shown.message.message_id,
        {type: 'photo', media: new InputFile(caption.buffer), caption: caption.html},
        {reply_markup: markup},
      ),
    keyboard,
  )
}

async function trySendInvoiceWidget(
  conversation: BotConversation,
  ctx: ConversationContext,
  host: ConversationHost,
  paymentRequest: string,
  caption: {html: string; amountSats: number},
  keyboard: InlineKeyboard,
  wallet: 'internal' | 'nwc',
): Promise<{chatId: number; messageId: number} | undefined> {
  if (ctx.chat?.type !== 'private') return undefined
  let document: InvoiceWidgetDocument
  try {
    document = buildInvoiceWidgetDocument({
      status: 'pending',
      amountSats: caption.amountSats,
      locale: invoiceLocale(ctx),
      label: ctx.t('invoice-widget-status.pending'),
      bolt11: paymentRequest,
    })
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Invoice widget does not fit, sending QR photo')
    })
    return undefined
  }

  let sent: {message_id: number; chat: {id: number | string}}
  try {
    sent = await sendWidget(ctx.api, {
      chat_id: host.chatId,
      html: document.html,
      chat_data: document.chatData,
      caption: caption.html,
      parse_mode: 'HTML',
      height: 300,
      reply_markup: keyboard,
    })
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Invoice widget send failed, sending QR photo')
    })
    return undefined
  }

  const chatId = typeof sent.chat.id === 'number' ? sent.chat.id : host.chatId
  // The message id does not exist until sendWidget returns, so the pointer cannot be written
  // earlier. This external() is the whole remaining gap: a payment that lands inside it will not
  // find the widget. Persist before any further API call so the gap is only that one write.
  await conversation.external(async () => {
    if (wallet === 'internal') {
      await setInvoiceWidgetMessage(paymentRequest, chatId, sent.message_id)
    }
    ctx.log.info(
      {
        sats: caption.amountSats,
        messageId: sent.message_id,
        source: wallet,
        bolt11InData: document.bolt11InData,
      },
      'Invoice widget sent',
    )
  })
  let removedPrompt = false
  try {
    await ctx.api.deleteMessage(host.chatId, host.messageId)
    removedPrompt = true
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Failed to remove the invoice prompt')
    })
  }
  if (removedPrompt) {
    await conversation.external(async () => {
      const user = await getRuntime().users.findById(ctx.user.id)
      if (user?.lastMenuMessageId === host.messageId) {
        await getRuntime().users.update(ctx.user.id, {lastMenuMessageId: null})
      }
    })
  }
  return {chatId, messageId: sent.message_id}
}

async function renderFinalWidget(
  conversation: BotConversation,
  ctx: ConversationContext,
  shown: ShownInvoice,
  paymentRequest: string,
  caption: {html: string; buffer: Buffer; amountSats: number},
  keyboard: InlineKeyboard,
  wallet: 'internal' | 'nwc',
): Promise<void> {
  const chatId = shown.message.chat.id
  const messageId = shown.message.message_id
  // The conversation is still waiting on the next update. Rewriting chat_data here would
  // put "pending" back over a status the webhook or cron already wrote (paid, expired).
  if (shown.paymentRequest === paymentRequest) {
    await closeWidget(ctx, chatId, messageId, caption.html, keyboard)
    return
  }

  let document: InvoiceWidgetDocument
  try {
    document = buildInvoiceWidgetDocument({
      status: 'pending',
      amountSats: caption.amountSats,
      locale: invoiceLocale(ctx),
      label: ctx.t('invoice-widget-status.pending'),
      bolt11: paymentRequest,
    })
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Replacement invoice widget does not fit')
    })
    await handOffReplacement(conversation, ctx, shown, caption, keyboard, wallet)
    return
  }

  if (!invoiceWidgetNeedsNewMessage(document.bolt11InData, shown.paymentRequest, paymentRequest)) {
    // Move the pointer before rewriting chat_data. A payment of A that already claimed the row
    // keeps this message; writing B's QR onto it would put A's paid status on B.
    if (wallet === 'internal') {
      const move = await takeWidgetMessage(
        conversation,
        ctx,
        shown,
        paymentRequest,
        caption,
        keyboard,
      )
      if (move !== 'moved') return
    }
    try {
      await editMessageWidgetData(ctx.api, {
        chat_id: chatId,
        message_id: messageId,
        chat_data: document.chatData,
      })
    } catch (error) {
      const description = errorText(error)
      await conversation.external(() => {
        ctx.log.warn({description}, 'Failed to update invoice widget')
      })
      // The bubble still shows A's QR. Give the pointer back to A, then hand B over as a photo
      // so this caption is not left describing the previous invoice.
      if (wallet === 'internal') {
        await conversation.external(async () => {
          try {
            const restored = await moveInvoiceWidgetMessage(
              paymentRequest,
              shown.paymentRequest,
              chatId,
              messageId,
            )
            if (!restored) await clearInvoiceWidgetMessage(paymentRequest)
          } catch (restoreError) {
            ctx.log.warn(
              {description: errorText(restoreError)},
              'Failed to restore the invoice widget pointer',
            )
            await clearInvoiceWidgetMessage(paymentRequest)
          }
        })
      }
      await handOffReplacement(conversation, ctx, shown, caption, keyboard, wallet)
      return
    }
    await closeWidget(ctx, chatId, messageId, caption.html, keyboard)
    return
  }

  let sent: {message_id: number; chat: {id: number | string}}
  try {
    sent = await sendWidget(ctx.api, {
      chat_id: chatId,
      html: document.html,
      chat_data: document.chatData,
      caption: caption.html,
      parse_mode: 'HTML',
      height: 300,
      reply_markup: keyboard,
    })
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Replacement invoice widget send failed, sending QR photo')
    })
    await handOffReplacement(conversation, ctx, shown, caption, keyboard, wallet)
    return
  }
  const sentChatId = typeof sent.chat.id === 'number' ? sent.chat.id : chatId
  if (wallet === 'internal') {
    await conversation.external(() =>
      setInvoiceWidgetMessage(paymentRequest, sentChatId, sent.message_id),
    )
  }
  await closeWidget(ctx, sentChatId, sent.message_id, caption.html, keyboard)
}

type WidgetMove = 'moved' | 'claimed' | 'failed'

/**
 * Attach the live message to the reminted invoice. `claimed` means A was already taken, so the
 * caller must not edit that message. `failed` already sent B as a photo and retired A's caption
 * only when A still owns it.
 *
 * The photo send stays outside the move's try. A throw from `sendPhotoFallback` after a claim
 * must not be handled as a failed move: that path rewrites the caption, and the message is
 * already the paid receipt.
 */
async function takeWidgetMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  shown: ShownInvoice,
  paymentRequest: string,
  caption: {html: string; buffer: Buffer},
  keyboard: InlineKeyboard,
): Promise<WidgetMove> {
  let moved = false
  try {
    moved = await conversation.external(() =>
      moveInvoiceWidgetMessage(
        shown.paymentRequest,
        paymentRequest,
        shown.message.chat.id,
        shown.message.message_id,
      ),
    )
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Failed to move invoice widget')
    })
    await handOffReplacement(conversation, ctx, shown, caption, keyboard, 'internal')
    return 'failed'
  }
  if (!moved) {
    await conversation.external(() => {
      ctx.log.info({messageId: shown.message.message_id}, 'Invoice widget stayed with invoice A')
    })
    await sendPhotoFallback(ctx, shown.message.chat.id, caption, keyboard)
    return 'claimed'
  }
  return 'moved'
}

async function handOffReplacement(
  conversation: BotConversation,
  ctx: ConversationContext,
  shown: ShownInvoice,
  caption: {html: string; buffer: Buffer},
  keyboard: InlineKeyboard,
  wallet: 'internal' | 'nwc',
): Promise<void> {
  await sendPhotoFallback(ctx, shown.message.chat.id, caption, keyboard)
  // A claim during memo entry already turned this bubble into the paid receipt. Captioning it
  // "replaced" would hide that. NWC invoices are not pending rows, so nothing else updates them.
  if (wallet === 'internal') {
    const stillOwns = await conversation.external(() => originalInvoiceStillOwnsWidget(shown))
    if (!stillOwns) return
  }
  await retireReplacedInvoice(conversation, ctx, shown)
}

async function originalInvoiceStillOwnsWidget(shown: ShownInvoice): Promise<boolean> {
  const row = await getPendingInvoiceBy({paymentRequest: shown.paymentRequest})
  return (
    row?.widgetChatId === shown.message.chat.id && row?.widgetMessageId === shown.message.message_id
  )
}

async function retireReplacedInvoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  shown: ShownInvoice,
): Promise<void> {
  const keyboard = invoiceKeyboard(ctx, shown.paymentRequest, false, {includeWalletButton: false})
  try {
    await ctx.api.editMessageCaption(shown.message.chat.id, shown.message.message_id, {
      caption: ctx.t('invoice-replaced'),
      reply_markup: keyboard,
    })
  } catch (error) {
    const description = errorText(error)
    await conversation.external(() => {
      ctx.log.warn({description}, 'Failed to retire the replaced invoice')
    })
  }
}

async function closeWidget(
  ctx: ConversationContext,
  chatId: number,
  messageId: number,
  html: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  await closeLivingMenu(
    ctx,
    messageId,
    markup => ctx.api.editMessageCaption(chatId, messageId, {caption: html, reply_markup: markup}),
    keyboard,
  )
}

async function sendPhotoFallback(
  ctx: ConversationContext,
  chatId: number,
  caption: {html: string; buffer: Buffer},
  keyboard: InlineKeyboard,
): Promise<void> {
  const sent = await ctx.api.sendPhoto(chatId, new InputFile(caption.buffer), {
    caption: caption.html,
  })
  // The photo is already on the message. Attaching the keyboard with editMessageMedia would
  // upload the same PNG again.
  await closeLivingMenu(
    ctx,
    sent.message_id,
    markup => ctx.api.editMessageReplyMarkup(chatId, sent.message_id, {reply_markup: markup}),
    keyboard,
  )
}

function invoiceLocale(ctx: ConversationContext): 'en' | 'ru' {
  return resolveAppLocale({
    telegramLanguageCode: ctx.from?.language_code,
    storedLanguageCode: ctx.user.languageCode,
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invoiceKeyboard(
  ctx: ConversationContext,
  paymentRequest: string,
  offerAddMemo: boolean,
  opts: {includeWalletButton: boolean} = {includeWalletButton: true},
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const copyText = copyableText(paymentRequest)
  if (copyText) {
    keyboard.copyText(ctx.t('button.copy-invoice'), copyText)
  }
  if (offerAddMemo) {
    keyboard.row({
      callback_data: staticCallback.addInvoiceMemo,
      text: ctx.t('button.add-invoice-memo'),
    })
  }
  if (opts.includeWalletButton) {
    keyboard.row({callback_data: staticCallback.wallet, text: ctx.t('button.open-wallet')})
  }
  return keyboard
}

async function buildInvoiceCaption(
  ctx: ConversationContext,
  paymentRequest: string,
  opts: {wallet: 'internal' | 'nwc'; usdSuffix: string},
): Promise<{html: string; buffer: Buffer; amountSats: number}> {
  const invoice = decodeInvoice(paymentRequest)
  const expiresAt = invoice.expiryDate ?? 0
  const buffer = await QRCode.toBuffer(invoice.paymentRequest)
  const memo = sanitizeMemo(invoice.description ?? '', getRuntime().config.memoFooter)
  const html = ctx.t('creating-invoice.created', {
    amount: invoice.satoshi,
    usdSuffix: opts.usdSuffix,
    wallet: opts.wallet,
    hasDescription: (!!memo).toString(),
    description: memo,
    expiresAt,
    invoice: paymentRequest,
  })
  return {html, buffer, amountSats: invoice.satoshi ?? 0}
}
