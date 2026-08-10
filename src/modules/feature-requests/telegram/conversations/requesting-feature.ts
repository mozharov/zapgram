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
import {removeInlineKeyboard} from '@telegram/helpers/keyboard.js'
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

  const fundMessage = await ctx.reply(ctx.t('feature.fund-prompt'), {
    reply_markup: buildFeatureFundKeyboard(ctx.t),
  })

  const fundChoice = await waitForFundChoice(conversation, ctx)
  if (fundChoice.kind === 'cancel') {
    await conversation.external(() => removeInlineKeyboard(fundMessage))
    await ctx.reply(ctx.t('canceled'))
    return
  }

  await conversation.external(() => removeInlineKeyboard(fundMessage))

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
  const prompt = await ctx.reply(ctx.t('feature.prompt'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })

  while (true) {
    const next = await conversation.waitFor(['message:text', 'callback_query:data'], {
      otherwise: async otherwiseCtx => {
        await conversation.external(() => removeInlineKeyboard(prompt))
        await otherwiseCtx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      },
    })

    if (next.callbackQuery?.data === staticCallback.cancel) {
      await next.answerCallbackQuery()
      await conversation.external(() => removeInlineKeyboard(prompt))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt()
    }

    const message = next.message
    const raw = message?.text ?? ''
    const text = normalizeFeatureRequestText(raw)
    if (!message || !isValidFeatureRequestText(text)) {
      await ctx.reply(ctx.t('feature.invalid-text'))
      continue
    }

    await conversation.external(() => removeInlineKeyboard(prompt))
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
): Promise<FundChoice> {
  while (true) {
    const next = await conversation.waitFor('callback_query:data', {
      otherwise: async otherwiseCtx => {
        await otherwiseCtx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      },
    })

    const data = next.callbackQuery?.data
    if (!data) continue

    if (data === staticCallback.cancel) {
      await next.answerCallbackQuery()
      return {kind: 'cancel'}
    }
    if (data === staticCallback.featureFundSkip) {
      await next.answerCallbackQuery()
      return {kind: 'skip'}
    }
    if (data === staticCallback.featureFundCustom) {
      await next.answerCallbackQuery()
      return {kind: 'custom'}
    }
    if (featureFundAmountRoute.pattern.test(data)) {
      const {amountSats} = featureFundAmountRoute.parse(data)
      await next.answerCallbackQuery()
      if (!isValidDonationAmountSats(amountSats)) {
        await ctx.reply(ctx.t('feature.invalid-amount'))
        continue
      }
      return {kind: 'amount', amountSats}
    }

    await next.answerCallbackQuery()
    await ctx.reply(ctx.t('canceled'))
    return {kind: 'cancel'}
  }
}

async function waitForCustomFundAmount(
  conversation: BotConversation,
  ctx: ConversationContext,
): Promise<number> {
  const message = await ctx.reply(ctx.t('feature.custom-amount'), {
    reply_markup: new InlineKeyboard([
      [{callback_data: staticCallback.cancel, text: ctx.t('button.cancel')}],
    ]),
  })

  const sats = await conversation.form.int({
    otherwise: async otherwiseCtx => {
      await removeInlineKeyboard(message)
      if (otherwiseCtx.update.message?.text)
        await otherwiseCtx.reply(ctx.t('feature.invalid-amount'))
      await otherwiseCtx.reply(ctx.t('canceled'))
      return conversation.halt({next: true})
    },
  })
  await conversation.external(() => removeInlineKeyboard(message))

  if (!isValidDonationAmountSats(sats)) {
    await ctx.reply(ctx.t('feature.invalid-amount'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }
  return sats
}
