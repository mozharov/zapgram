import {
  donateAmountRoute,
  donateMonthlyAmountRoute,
  donationPercentRoute,
  donationScopeRoute,
  staticCallback,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {customDonateAmount} from './telegram/conversations/custom-donate-amount.js'
import {customDonationPercent} from './telegram/conversations/custom-donation-percent.js'
import {customMonthlyAmount} from './telegram/conversations/custom-monthly-amount.js'
import {donateAmountCallback} from './telegram/handlers/donate-amount.js'
import {donateCommand, donateHubCallback} from './telegram/handlers/donate-command.js'
import {
  donateMonthlyAmountCallback,
  donateMonthlyDisableCallback,
  donateMonthlyMenuCallback,
} from './telegram/handlers/donate-monthly.js'
import {
  donationPercentCallback,
  donationScopeCallback,
  donationSettingsCallback,
} from './telegram/handlers/donation-settings.js'

export const donationCommands = ['donate'] as const

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  // createConversation plugins live in telegram/composition.ts.
  privateChat.command(donationCommands[0], donateCommand)
  privateChat.callbackQuery(staticCallback.donate, donateHubCallback)
  privateChat.callbackQuery(staticCallback.donationSettings, donationSettingsCallback)
  privateChat.callbackQuery(donationPercentRoute.pattern, donationPercentCallback)
  privateChat.callbackQuery(donationScopeRoute.pattern, donationScopeCallback)
  privateChat.callbackQuery(donateAmountRoute.pattern, donateAmountCallback)
  privateChat.callbackQuery(staticCallback.donateMonthlyMenu, donateMonthlyMenuCallback)
  privateChat.callbackQuery(staticCallback.donateMonthlyDisable, donateMonthlyDisableCallback)
  privateChat.callbackQuery(donateMonthlyAmountRoute.pattern, donateMonthlyAmountCallback)

  privateChat.callbackQuery(staticCallback.donateCustom, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.conversation.enter(customDonateAmount.name)
  })
  privateChat.callbackQuery(staticCallback.donationCustomPercent, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.conversation.enter(customDonationPercent.name)
  })
  privateChat.callbackQuery(staticCallback.donateMonthlyCustom, async ctx => {
    await ctx.answerCallbackQuery()
    await ctx.conversation.enter(customMonthlyAmount.name)
  })
}
