import {AppError} from '@core/errors/app-error.js'
import {InvoiceGenerationError} from '@core/errors/invoice-generation.js'
import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import {sanitizeMemo} from '@core/lightning/memo.js'
import {satsToMsats} from '@core/money/sats.js'
import {createPendingInvoice} from '@modules/invoices/repository.js'
import {waitForMemoText} from '@modules/invoices/telegram/helpers/wait-for-memo.js'
import {waitForSats} from '@modules/invoices/telegram/helpers/wait-for-sats.js'
import {waitForWallet} from '@modules/invoices/telegram/helpers/wait-for-wallet.js'
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
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  inactivePromptState,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {copyableText} from '@telegram/helpers/copy-text.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard, InputFile} from 'grammy'
import QRCode from 'qrcode'
import {getRuntime} from '../../../../runtime.js'

export async function creatingInvoice(conversation: BotConversation, ctx: ConversationContext) {
  const title = ctx.t('creating-invoice')
  const host = await ensureHost(ctx, title)
  const restoreWallet = () => editHostWithWallet(ctx, host)

  const wallet = await waitForWallet(conversation, ctx, {
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

  const invoiceView = await renderInvoice(ctx, host, paymentRequest, {
    wallet,
    usdSuffix,
    offerAddMemo: true,
  })
  const qrPrompt = createActivePrompt(invoiceView.message, {
    kind: 'caption',
    html: invoiceView.html,
    actionLabel: ctx.t('conversation-action.invoice-memo-options'),
  })
  const inactive = inactivePromptState(
    ctx,
    qrPrompt,
    ctx.t('conversation-state.invoice-memo-inactive'),
  )

  for (;;) {
    const next = await conversation.wait()
    if (
      next.callbackQuery?.data === staticCallback.addInvoiceMemo &&
      isCallbackFromPrompt(next, qrPrompt)
    ) {
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, qrPrompt)
      break
    }

    if (
      next.callbackQuery?.data === staticCallback.wallet &&
      isCallbackFromPrompt(next, qrPrompt)
    ) {
      // Invoice is already live. Open Wallet as a new message and drop the invoice buttons.
      // Do not fall through: the global wallet handler would replace this invoice.
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, qrPrompt)
      await replyWithWallet(ctx)
      return conversation.halt()
    }

    const kind = classifyPromptUpdate(next, qrPrompt, staticCallback.cancel)
    if (kind === 'interrupt') {
      return interruptConversation(conversation, qrPrompt, inactive)
    }

    await next.reply(next.t('conversation-state.use-buttons'))
  }

  captureBotEvent(getRuntime().posthog, 'invoice_memo_add_tapped', {
    amount_sats: sats,
    wallet_type: wallet,
  })

  const memoHtml = joinWizardHtml(invoiceView.html, ctx.t('wait-for-memo'))
  const memoResult = await waitForMemoText(conversation, ctx, {
    host,
    html: memoHtml,
    kind: 'caption',
  })
  if (memoResult.status !== 'ok') {
    captureBotEvent(getRuntime().posthog, 'invoice_memo_add_cancelled', {
      reason: memoResult.reason,
      amount_sats: sats,
      wallet_type: wallet,
    })
    if (memoResult.status === 'cancelled') {
      await renderInvoice(ctx, host, paymentRequest, {wallet, usdSuffix, offerAddMemo: false})
      await replyWithWallet(ctx)
      return conversation.halt()
    }
    return conversation.halt({next: true})
  }

  await ctx.replyWithChatAction('typing')
  // Keep the no-memo pending row: the old BOLT11 stays payable until expiry.
  paymentRequest = await mintInvoiceOnce(conversation, () =>
    createInvoice(ctx, wallet, sats, memoResult.memo),
  )
  captureInvoiceCreated({sats, wallet, hasMemo: true, isReplacement: true})
  await renderInvoice(ctx, host, paymentRequest, {wallet, usdSuffix, offerAddMemo: false})
  await replyWithWallet(ctx)
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

async function renderInvoice(
  ctx: ConversationContext,
  host: ConversationHost,
  paymentRequest: string,
  opts: {wallet: 'internal' | 'nwc'; usdSuffix: string; offerAddMemo: boolean},
): Promise<{message: {chat: {id: number}; message_id: number}; html: string}> {
  const {html, buffer} = await buildInvoiceCaption(ctx, paymentRequest, opts)
  const keyboard = invoiceKeyboard(ctx, paymentRequest, opts.offerAddMemo)
  await ctx.api.editMessageMedia(
    host.chatId,
    host.messageId,
    {
      type: 'photo',
      media: new InputFile(buffer),
      caption: html,
    },
    {reply_markup: keyboard},
  )
  return {message: promptMessageFromHost(host), html}
}

function invoiceKeyboard(
  ctx: ConversationContext,
  paymentRequest: string,
  offerAddMemo: boolean,
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
  keyboard.row({callback_data: staticCallback.wallet, text: ctx.t('button.open-wallet')})
  return keyboard
}

async function buildInvoiceCaption(
  ctx: ConversationContext,
  paymentRequest: string,
  opts: {wallet: 'internal' | 'nwc'; usdSuffix: string},
): Promise<{html: string; buffer: Buffer}> {
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
  return {html, buffer}
}
