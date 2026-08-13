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
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'
import {type FundedWallets, fundedWalletsForAmount, readWalletBalances} from './funded-wallets.js'

export type WalletSelectFlow = 'pay_invoice' | 'tip' | 'create_invoice'

export type WalletSelection = {
  wallet: 'internal' | 'nwc'
  nwcBalanceError: boolean
  host?: ConversationHost
}

export async function waitForWallet(
  conversation: BotConversation,
  ctx: ConversationContext,
  opts?: {
    requiredSats?: number
    flow?: WalletSelectFlow
    host?: ConversationHost
    html?: string
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
      return pickWallet(conversation, ctx, {
        ...opts,
        flow,
        requiredSats,
        nwcBalanceError: false,
        html: opts?.html ?? ctx.t('wait-for-wallet.pay-invoice'),
        keyboard: walletKeyboard(ctx, {
          copyText: opts?.copyText,
          funded: {internal: true, nwc: false, nwcBalanceError: false},
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

    return pickWallet(conversation, ctx, {
      ...opts,
      flow,
      requiredSats,
      nwcBalanceError: funded.nwcBalanceError,
      html: joinWizardHtml(
        opts?.html ?? ctx.t('wait-for-wallet'),
        funded.nwcBalanceError ? ctx.t('wait-for-wallet.nwc-unreachable') : undefined,
      ),
      keyboard: walletKeyboard(ctx, {
        copyText: opts?.copyText,
        funded,
      }),
    })
  }

  return pickWallet(conversation, ctx, {
    ...opts,
    flow,
    requiredSats,
    nwcBalanceError: false,
    html: opts?.html ?? ctx.t('wait-for-wallet'),
    keyboard: walletKeyboard(ctx, {copyText: opts?.copyText}),
  })
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
    onCancel?: (host: ConversationHost) => Promise<unknown>
  },
): Promise<WalletSelection> {
  const message = await showHostOrReply(ctx, opts.html, opts.keyboard, opts.host)
  const pickedHost = {chatId: message.chat.id, messageId: message.message_id}
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html: opts.html,
    actionLabel: ctx.t('conversation-action.select-wallet'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  let wallet: 'internal' | 'nwc'
  for (;;) {
    const next = await conversation.wait()
    const data = next.callbackQuery?.data
    if ((data === 'internal' || data === 'nwc') && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await clearPromptControls(conversation, prompt)
      wallet = data
      break
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

function walletKeyboard(
  ctx: ConversationContext,
  opts?: {
    copyText?: string
    funded?: FundedWallets
  },
) {
  const keyboard = new InlineKeyboard()
  if (opts?.copyText) keyboard.copyText(ctx.t('button.copy-invoice'), opts.copyText)

  const offerInternal = opts?.funded?.internal ?? true
  const offerNwc = opts?.funded?.nwc ?? true
  const internalText = ctx.t('button.internal-wallet')
  const nwcText = ctx.t('button.nwc-wallet')

  if (offerInternal && offerNwc) {
    keyboard.row(
      {callback_data: 'internal', text: internalText},
      {callback_data: 'nwc', text: nwcText},
    )
  } else if (offerInternal) {
    keyboard.row({callback_data: 'internal', text: internalText})
  } else if (offerNwc) {
    keyboard.row({callback_data: 'nwc', text: nwcText})
  }

  keyboard.row({callback_data: staticCallback.cancel, text: ctx.t('button.cancel')})
  return keyboard
}
