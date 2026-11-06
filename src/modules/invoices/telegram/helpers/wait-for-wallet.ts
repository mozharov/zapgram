import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  type ConversationHost,
  joinWizardHtml,
  showHostOrReply,
} from '@telegram/helpers/conversation-host.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {waitForStepInput} from '@telegram/helpers/pasted-payment.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'
import {type FundedWallets, fundedWalletsForAmount, readWalletBalances} from './funded-wallets.js'

export type WalletSelectFlow = 'pay_invoice' | 'tip' | 'create_invoice'

export type WalletSelection = {
  wallet: 'internal' | 'nwc'
  nwcBalanceError: boolean
  host?: ConversationHost
}

/**
 * One usable wallet is not a choice. Flows that pass this turn the picker into a confirmation
 * naming the paying wallet, instead of offering a single wallet button.
 */
export type SoleWalletPrompt = {
  html: (wallet: 'internal' | 'nwc') => string
  buttonText: string
  actionLabel: string
}

export async function waitForWallet(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    requiredSats?: number
    flow?: WalletSelectFlow
    host?: ConversationHost
    html?: string
    soleWallet?: SoleWalletPrompt
    copyText?: string
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
): Promise<WalletSelection> {
  const flow = opts?.flow ?? 'create_invoice'
  const requiredSats = opts?.requiredSats
  const posthog = getRuntime().posthog

  if (!ctx.user.nwc) {
    if (requiredSats !== undefined) {
      const internalMsats = await conversation.external(() => ctx.user.wallet.getBalance())
      const funded = fundedWalletsForAmount(
        {internalMsats, nwcMsats: null, nwcBalanceError: false},
        requiredSats,
      )
      if (!funded.internal) {
        captureBotEvent(posthog, 'wallet_resolved', {
          flow,
          selection: 'insufficient',
          required_sats: requiredSats,
          internal_funded: false,
          nwc_funded: false,
        })
        throw new InsufficientFundsError()
      }
    }
    if (flow === 'pay_invoice') {
      const nonce = await conversation.external(() => crypto.randomUUID())
      return pickWallet(conversation, ctx, {
        ...opts,
        flow,
        requiredSats,
        nwcBalanceError: false,
        nonce,
        ...walletPrompt(ctx, {
          funded: {internal: true, nwc: false, nwcBalanceError: false},
          html: opts?.html ?? ctx.t('wait-for-wallet.pay-invoice'),
          copyText: opts?.copyText,
          sole: opts?.soleWallet,
          nonce,
        }),
      })
    }
    captureBotEvent(posthog, 'wallet_resolved', {
      flow,
      selection: 'no_nwc',
      wallet_type: 'internal',
      required_sats: requiredSats,
    })
    return {wallet: 'internal', nwcBalanceError: false}
  }

  if (requiredSats !== undefined) {
    const balances = await conversation.external(async () => {
      const internalMsats = await ctx.user.wallet.getBalance()
      return readWalletBalances({
        internalBalanceMsats: internalMsats,
        nwc: ctx.user.nwc,
        log: getRuntime().log,
      })
    })
    const funded = fundedWalletsForAmount(balances, requiredSats)

    if (!funded.internal && !funded.nwc) {
      captureBotEvent(posthog, 'wallet_resolved', {
        flow,
        selection: 'insufficient',
        required_sats: requiredSats,
        internal_funded: false,
        nwc_funded: false,
        nwc_balance_error: funded.nwcBalanceError,
      })
      throw new InsufficientFundsError()
    }

    // Pay-invoice keeps the picker so the invoice analysis stays on screen.
    // Tips still skip a one-wallet choice.
    if (funded.internal !== funded.nwc && flow !== 'pay_invoice') {
      const wallet = funded.internal ? 'internal' : 'nwc'
      const autoKey =
        wallet === 'internal'
          ? 'wait-for-wallet.auto-only-internal'
          : 'wait-for-wallet.auto-only-nwc'
      if (!opts?.host) await ctx.reply(ctx.t(autoKey))
      captureBotEvent(posthog, 'wallet_resolved', {
        flow,
        selection: 'auto_only_funded',
        wallet_type: wallet,
        required_sats: requiredSats,
        internal_funded: funded.internal,
        nwc_funded: funded.nwc,
        nwc_balance_error: funded.nwcBalanceError,
      })
      return {wallet, nwcBalanceError: funded.nwcBalanceError}
    }

    const nonce = await conversation.external(() => crypto.randomUUID())
    return pickWallet(conversation, ctx, {
      ...opts,
      flow,
      requiredSats,
      nwcBalanceError: funded.nwcBalanceError,
      nonce,
      ...walletPrompt(ctx, {
        funded,
        html: opts?.html ?? ctx.t('wait-for-wallet'),
        note: funded.nwcBalanceError ? ctx.t('wait-for-wallet.nwc-unreachable') : undefined,
        copyText: opts?.copyText,
        sole: opts?.soleWallet,
        nonce,
      }),
    })
  }

  const nonce = await conversation.external(() => crypto.randomUUID())
  return pickWallet(conversation, ctx, {
    ...opts,
    flow,
    requiredSats,
    nwcBalanceError: false,
    nonce,
    html: opts?.html ?? ctx.t('wait-for-wallet'),
    keyboard: walletKeyboard(ctx, {copyText: opts?.copyText, nonce}),
  })
}

/** The screen and buttons for the wallet step: a picker, or a confirmation of the only wallet. */
function walletPrompt(
  ctx: ConversationContext,
  opts: {
    funded: FundedWallets
    html: string
    note?: string
    copyText?: string
    sole?: SoleWalletPrompt
    nonce: string
  },
): {html: string; keyboard: InlineKeyboard; actionLabel?: string} {
  const soleWallet = soleFundedWallet(opts.funded)
  if (soleWallet && opts.sole) {
    return {
      html: joinWizardHtml(opts.sole.html(soleWallet), opts.note),
      keyboard: confirmWalletKeyboard(ctx, {
        wallet: soleWallet,
        text: opts.sole.buttonText,
        copyText: opts.copyText,
        nonce: opts.nonce,
      }),
      actionLabel: opts.sole.actionLabel,
    }
  }
  return {
    html: joinWizardHtml(opts.html, opts.note),
    keyboard: walletKeyboard(ctx, {
      copyText: opts.copyText,
      funded: opts.funded,
      nonce: opts.nonce,
    }),
  }
}

/** The wallet left when exactly one of the two can pay, undefined when both or neither can. */
function soleFundedWallet(funded: FundedWallets): 'internal' | 'nwc' | undefined {
  if (funded.internal === funded.nwc) return undefined
  return funded.internal ? 'internal' : 'nwc'
}

async function pickWallet(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts: {
    flow: WalletSelectFlow
    requiredSats?: number
    nwcBalanceError: boolean
    host?: ConversationHost
    html: string
    keyboard: InlineKeyboard
    nonce: string
    actionLabel?: string
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
): Promise<WalletSelection> {
  const message = await showHostOrReply(ctx, opts.html, opts.keyboard, opts.host)
  const pickedHost = {chatId: message.chat.id, messageId: message.message_id}
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html: opts.html,
    actionLabel: opts.actionLabel ?? ctx.t('conversation-action.select-wallet'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let wallet: 'internal' | 'nwc'
  for (;;) {
    const next = await waitForStepInput(conversation, prompt, {intercept: 'all'})
    if (!next) continue
    const data = next.callbackQuery?.data
    // Same message as this attempt. A bare `internal`/`nwc`, or another attempt's
    // nonce, is the button from the invoice that used to be on this host.
    if (isWalletChoice(data) && isCallbackFromPrompt(next, prompt)) {
      const picked = walletFromChoice(data, opts.nonce)
      if (picked) {
        await next.answerCallbackQuery()
        await clearPromptControls(conversation, prompt)
        wallet = picked
        break
      }
      await next.answerCallbackQuery({text: next.t('callback-answer.confirm-stale')})
      continue
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      if (opts.onCancel) await opts.onCancel(opts.host ?? pickedHost)
      else await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    if (opts.onCancel) await opts.onCancel(opts.host ?? pickedHost)
    else await deactivatePrompt(conversation, prompt, cancelled)
    if (next.message) await deleteMessageSafely(next)
    return conversation.halt()
  }

  captureBotEvent(getRuntime().posthog, 'wallet_resolved', {
    flow: opts.flow,
    selection: 'manual',
    wallet_type: wallet,
    required_sats: opts.requiredSats,
    nwc_balance_error: opts.nwcBalanceError,
  })
  return {wallet, nwcBalanceError: opts.nwcBalanceError, host: pickedHost}
}

/** This attempt only. Replay of the step keeps the nonce; cancel and a new invoice do not. */
function walletChoiceData(wallet: 'internal' | 'nwc', nonce: string): string {
  return `${wallet}:${nonce}`
}

function isWalletChoice(data: string | undefined): data is string {
  return (
    data === 'internal' ||
    data === 'nwc' ||
    Boolean(data && (/^internal:[0-9a-f-]{36}$/i.test(data) || /^nwc:[0-9a-f-]{36}$/i.test(data)))
  )
}

function walletFromChoice(data: string, nonce: string): 'internal' | 'nwc' | undefined {
  if (data === walletChoiceData('internal', nonce)) return 'internal'
  if (data === walletChoiceData('nwc', nonce)) return 'nwc'
  return undefined
}

function walletKeyboard(
  ctx: ConversationContext,
  opts: {
    nonce: string
    copyText?: string
    funded?: FundedWallets
  },
) {
  const keyboard = new InlineKeyboard()
  if (opts.copyText) keyboard.copyText(ctx.t('button.copy-invoice'), opts.copyText)

  const offerInternal = opts.funded?.internal ?? true
  const offerNwc = opts.funded?.nwc ?? true
  const internalText = ctx.t('button.internal-wallet')
  const nwcText = ctx.t('button.nwc-wallet')

  if (offerInternal && offerNwc) {
    keyboard.row(
      {callback_data: walletChoiceData('internal', opts.nonce), text: internalText},
      {callback_data: walletChoiceData('nwc', opts.nonce), text: nwcText},
    )
  } else if (offerInternal) {
    keyboard.row({callback_data: walletChoiceData('internal', opts.nonce), text: internalText})
  } else if (offerNwc) {
    keyboard.row({callback_data: walletChoiceData('nwc', opts.nonce), text: nwcText})
  }

  keyboard.row({callback_data: staticCallback.cancel, text: ctx.t('button.cancel')})
  return keyboard
}

function confirmWalletKeyboard(
  ctx: ConversationContext,
  opts: {wallet: 'internal' | 'nwc'; text: string; nonce: string; copyText?: string},
) {
  const keyboard = new InlineKeyboard()
  if (opts.copyText) keyboard.copyText(ctx.t('button.copy-invoice'), opts.copyText)
  // Same shape as the picker, plus this attempt's nonce. The button still resolves to a wallet.
  keyboard.row({callback_data: walletChoiceData(opts.wallet, opts.nonce), text: opts.text})
  keyboard.row({callback_data: staticCallback.cancel, text: ctx.t('button.cancel')})
  return keyboard
}
