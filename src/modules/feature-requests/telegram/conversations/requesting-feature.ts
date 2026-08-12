import {isValidDonationAmountSats} from '@core/money/donation.js'
import {
  isValidFeatureRequestText,
  normalizeFeatureRequestText,
} from '@core/money/feature-request.js'
import type {FeatureRequestSourceMessage} from '@modules/feature-requests/submit.service.js'
import {buildFeatureFundKeyboard} from '@modules/feature-requests/telegram/keyboards/fund.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {featureFundAmountRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
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
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/**
 * /feature [text] → optional fund sats → admin meta DM + copyMessage + PostHog.
 */
export async function requestingFeature(
  conversation: BotConversation,
  ctx: ConversationContext,
  initialText = '',
) {
  captureBotEvent(getRuntime().posthog, 'feature_request_started', {
    feature: 'feature_requests',
    has_initial_text: initialText.trim().length > 0,
  })

  const source = await resolveSourceMessage(conversation, ctx, initialText)
  if (!source) return

  const fundHtml = ctx.t('feature.fund-prompt')
  const fundMessage = await ctx.reply(fundHtml, {
    reply_markup: buildFeatureFundKeyboard(ctx.t),
  })
  const fundPrompt = createActivePrompt(fundMessage, {
    kind: 'text',
    html: fundHtml,
    actionLabel: ctx.t('conversation-action.feature-fund'),
  })

  const fundChoice = await waitForFundChoice(conversation, ctx, fundPrompt)
  if (fundChoice.kind === 'cancel') {
    return conversation.halt()
  }

  await clearPromptControls(conversation, fundPrompt)

  let amountSats = 0
  if (fundChoice.kind === 'amount') {
    amountSats = fundChoice.amountSats
  } else if (fundChoice.kind === 'custom') {
    amountSats = await waitForCustomFundAmount(conversation, ctx)
  }

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

  if (result.fundStatus === 'paid') {
    await ctx.reply(
      ctx.t('feature.submitted-funded', {
        sats: result.amountPaidSats,
        usdSuffix,
      }),
    )
  } else if (result.fundStatus === 'pay_failed') {
    captureBotEvent(posthog, 'feature_request_fund_failed_ui', {
      feature: 'feature_requests',
      amount_requested_sats: amountSats,
    })
    await ctx.reply(ctx.t('feature.fund-failed-submitted'))
  } else {
    await ctx.reply(ctx.t('feature.submitted'))
  }
}

/**
 * Prefer the command message when `/feature …` already has body text.
 * Otherwise wait for one plain text message (Telegram length limit applies).
 */
async function resolveSourceMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  initialText: string,
): Promise<FeatureRequestSourceMessage | null> {
  const fromCommand = normalizeFeatureRequestText(initialText)
  if (fromCommand && ctx.message && ctx.chat) {
    return {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      // Analytics: body after /feature; admin still gets a full copy of the command message.
      text: fromCommand,
    }
  }

  return waitForFeatureText(conversation, ctx)
}

async function waitForFeatureText(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<FeatureRequestSourceMessage | null> {
  const html = ctx.t('feature.prompt')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
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
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const message = next.message
    const raw = message?.text ?? ''
    const text = normalizeFeatureRequestText(raw)
    if (!message || !isValidFeatureRequestText(text)) {
      await next.reply(next.t('feature.invalid-text'))
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

type FundChoice =
  | {kind: 'skip'}
  | {kind: 'amount'; amountSats: number}
  | {kind: 'custom'}
  | {kind: 'cancel'}

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
    if (data === staticCallback.featureFundCustom && isCallbackFromPrompt(next, prompt)) {
      await next.answerCallbackQuery()
      return {kind: 'custom'}
    }
    if (data && featureFundAmountRoute.pattern.test(data) && isCallbackFromPrompt(next, prompt)) {
      const {amountSats} = featureFundAmountRoute.parse(data)
      await next.answerCallbackQuery()
      if (!isValidDonationAmountSats(amountSats)) {
        await next.reply(next.t('feature.invalid-amount'))
        continue
      }
      return {kind: 'amount', amountSats}
    }

    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)
    await next.reply(next.t('conversation-state.use-buttons'))
  }
}

async function waitForCustomFundAmount(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<number> {
  const html = ctx.t('feature.custom-amount')
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t('conversation-action.feature-fund-amount'),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)
    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') return interruptConversation(conversation, prompt, cancelled)

    const text = next.message?.text?.trim()
    const sats = text && /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(sats) || !isValidDonationAmountSats(sats)) {
      await next.reply(next.t('feature.invalid-amount'))
      continue
    }
    await clearPromptControls(conversation, prompt)
    return sats
  }
}
