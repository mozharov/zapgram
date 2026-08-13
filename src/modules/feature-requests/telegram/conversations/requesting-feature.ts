import {isValidDonationAmountSats} from '@core/money/donation.js'
import {
  isValidFeatureRequestText,
  normalizeFeatureRequestText,
} from '@core/money/feature-request.js'
import type {FeatureRequestSourceMessage} from '@modules/feature-requests/submit.service.js'
import {buildFeatureFundKeyboard} from '@modules/feature-requests/telegram/keyboards/fund.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {disabledLinkPreview} from '@telegram/helpers/conversation-host.js'
import {
  type ActivePrompt,
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
  isCallbackFromPrompt,
} from '@telegram/helpers/conversation-prompt.js'
import {deleteMessageSafely, deleteMessagesSafely} from '@telegram/helpers/delete-message.js'
import {closeLivingMenu, showLivingMenu} from '@telegram/helpers/living-menu.js'
import {replyWithConversationTempMessage} from '@telegram/helpers/temp-message.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/** Main-menu feature request → optional fund sats → admin meta DM + copyMessage + PostHog. */
export async function requestingFeature(conversation: BotConversation, ctx: ConversationContext) {
  captureBotEvent(getRuntime().posthog, 'feature_request_started', {
    feature: 'feature_requests',
  })

  const source = await waitForFeatureText(conversation, ctx)
  if (!source) return

  const fundHtml = ctx.t('feature.fund-prompt')
  const fundMessage = await showLivingMenu(ctx, () =>
    ctx.reply(fundHtml, {
      reply_markup: buildFeatureFundKeyboard(ctx.t),
    }),
  )
  const fundPrompt = createActivePrompt(fundMessage, {
    kind: 'text',
    html: fundHtml,
    actionLabel: ctx.t('conversation-action.feature-fund'),
  })

  const fundChoice = await waitForFundChoice(conversation, ctx, fundPrompt)
  if (fundChoice.kind === 'cancel') {
    // Nothing is submitted, so the idea message has no reader left — drop it with the prompt and
    // leave the user on a plain wallet menu.
    await deleteMessagesSafely(ctx, [source.messageId])
    await replyWithWallet(ctx)
    return conversation.halt()
  }

  await clearPromptControls(conversation, fundPrompt)

  const amountSats = fundChoice.kind === 'amount' ? fundChoice.amountSats : 0

  if (amountSats > 0) {
    await ctx.replyWithChatAction('typing').catch(() => null)
  }

  const {featureRequests, posthog} = getRuntime()
  const result = await conversation.external(() =>
    featureRequests.submit({
      userId: ctx.user.id,
      username: ctx.user.username,
      firstName: ctx.user.firstName,
      source,
      amountSats,
      nwc: ctx.user.nwc,
      nwcUrl: ctx.user.nwcUrl,
    }),
  )

  const usdSuffix =
    result.amountPaidSats > 0
      ? await conversation.external(() => usdSuffixForSats(result.amountPaidSats))
      : ''

  if (result.fundStatus === 'pay_failed') {
    captureBotEvent(posthog, 'feature_request_fund_failed_ui', {
      feature: 'feature_requests',
      amount_requested_sats: amountSats,
    })
  }

  const reportHtml =
    result.fundStatus === 'paid'
      ? ctx.t('feature.submitted-funded', {sats: result.amountPaidSats, usdSuffix})
      : result.fundStatus === 'pay_failed'
        ? ctx.t('feature.fund-failed-submitted')
        : ctx.t('feature.submitted')

  // The wizard's own screen becomes the report, so no extra message is sent. It keeps the open-menu
  // button and stays put; the user's feature message stays too — it is the `copyMessage` source.
  await closeLivingMenu(ctx, fundMessage.message_id, markup =>
    ctx.api.editMessageText(fundMessage.chat.id, fundMessage.message_id, reportHtml, {
      reply_markup: markup,
      ...disabledLinkPreview,
    }),
  )
}

async function waitForFeatureText(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<FeatureRequestSourceMessage | null> {
  const html = ctx.t('feature.prompt')
  const message = await showLivingMenu(ctx, () =>
    ctx.reply(html, {
      reply_markup: new InlineKeyboard([
        [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
      ]),
    }),
  )
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.feature-text'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  while (true) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      await replyWithWallet(ctx)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const message = next.message
    const raw = message?.text ?? ''
    const text = normalizeFeatureRequestText(raw)
    if (!message || !isValidFeatureRequestText(text)) {
      await replyWithConversationTempMessage(conversation, next, next.t('feature.invalid-text'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return {
      chatId: message.chat.id,
      messageId: message.message_id,
      text,
    }
  }
}

type FundChoice = {kind: 'skip'} | {kind: 'amount'; amountSats: number} | {kind: 'cancel'}

/**
 * Presets and Skip come from the board; any other amount is simply typed into the chat. Accepting it
 * here rather than in a follow-up prompt is what keeps the whole wizard inside one message.
 */
async function waitForFundChoice(
  conversation: BotConversation,
  ctx: ConversationContext,
  prompt: ActivePrompt,
): Promise<FundChoice> {
  const cancelled = cancelledPromptState(ctx, prompt)
  while (true) {
    const next = await conversation.wait()

    const data = next.callbackQuery?.data
    if (data === staticCallback.cancel && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return {kind: 'cancel'}
    }
    if (data === staticCallback.featureFundSkip && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      return {kind: 'skip'}
    }
    if (data && featureFundAmountRoute.pattern.test(data) && isCallbackFromPrompt(next, prompt)) {
      const {amountSats} = featureFundAmountRoute.parse(data)
      await next.answerCallbackQuery()
      if (!isValidDonationAmountSats(amountSats)) {
        await replyWithConversationTempMessage(conversation, next, next.t('feature.invalid-amount'))
        continue
      }
      return {kind: 'amount', amountSats}
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const text = next.message?.text?.trim()
    const sats = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(sats) || !isValidDonationAmountSats(sats)) {
      // Keep the chooser in place and remove the rejected input with its temporary hint.
      await replyWithConversationTempMessage(conversation, next, next.t('feature.invalid-amount'))
      continue
    }
    // The report echoes the accepted amount, so the typed number itself is noise.
    await deleteMessageSafely(next)
    return {kind: 'amount', amountSats: sats}
  }
}
