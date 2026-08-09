/**
 * Typed callback_data routes: one definition builds keyboard strings and parses
 * grammY callbackQuery matches, so they cannot drift apart.
 */

export type CallbackRoute<T extends Record<string, unknown>> = {
  readonly name: string
  readonly pattern: RegExp
  parse: (match: string | RegExpMatchArray) => T
  build: (params: T) => string
}

export function defineCallback<T extends Record<string, unknown>>(
  name: string,
  pattern: RegExp,
  parse: (match: RegExpMatchArray) => T,
  build: (params: T) => string,
): CallbackRoute<T> {
  return {
    name,
    pattern,
    parse(match) {
      if (typeof match === 'string') {
        const m = pattern.exec(match)
        if (!m) throw new Error(`Invalid callback data for ${name}: ${match}`)
        return parse(m)
      }
      return parse(match)
    },
    build,
  }
}

function requireGroup(match: RegExpMatchArray, index: number, name: string): string {
  const value = match[index]
  if (value === undefined) throw new Error(`Invalid callback match for ${name}`)
  return value
}

// --- Chat list / detail ---

export const chatsPageRoute = defineCallback(
  'chats-page',
  /^chats:(\d+)$/,
  match => {
    const page = parseInt(requireGroup(match, 1, 'chats-page'), 10)
    if (Number.isNaN(page) || page <= 0) return {page: 1}
    return {page}
  },
  ({page}) => `chats:${page}`,
)

export const chatRoute = defineCallback(
  'chat',
  /^chat:(-?\d+)$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat'), 10)}),
  ({chatId}) => `chat:${chatId}`,
)

export const chatPaidAccessRoute = defineCallback(
  'chat-paid-access',
  /^chat:(-?\d+):(on|off)-paid$/,
  match => {
    const chatId = parseInt(requireGroup(match, 1, 'chat-paid-access'), 10)
    const action = requireGroup(match, 2, 'chat-paid-access')
    if (action !== 'on' && action !== 'off') throw new Error('Invalid paid-access action')
    return {chatId, status: (action === 'on' ? 'active' : 'inactive') as 'active' | 'inactive'}
  },
  ({chatId, status}) => `chat:${chatId}:${status === 'active' ? 'on' : 'off'}-paid`,
)

export const chatPaymentTypeRoute = defineCallback(
  'chat-payment-type',
  /^chat:(-?\d+):turn-(one_time|monthly)$/,
  match => {
    const chatId = parseInt(requireGroup(match, 1, 'chat-payment-type'), 10)
    const paymentType = requireGroup(match, 2, 'chat-payment-type')
    if (paymentType !== 'one_time' && paymentType !== 'monthly') {
      throw new Error('Invalid payment type')
    }
    return {chatId, paymentType: paymentType as 'one_time' | 'monthly'}
  },
  ({chatId, paymentType}) => `chat:${chatId}:turn-${paymentType}`,
)

export const chatChangePriceRoute = defineCallback(
  'chat-change-price',
  /^chat:(-?\d+):change-price$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-change-price'), 10)}),
  ({chatId}) => `chat:${chatId}:change-price`,
)

export const chatCustomMessageRoute = defineCallback(
  'chat-custom-message',
  /^chat:(-?\d+):custom-message$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-custom-message'), 10)}),
  ({chatId}) => `chat:${chatId}:custom-message`,
)

export const chatEditCustomMessageRoute = defineCallback(
  'chat-edit-custom-message',
  /^chat:(-?\d+):edit-custom-message$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-edit-custom-message'), 10)}),
  ({chatId}) => `chat:${chatId}:edit-custom-message`,
)

export const chatRemoveCustomMessageRoute = defineCallback(
  'chat-remove-custom-message',
  /^chat:(-?\d+):remove-custom-message$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-remove-custom-message'), 10)}),
  ({chatId}) => `chat:${chatId}:remove-custom-message`,
)

export const chatOnchainEnableRoute = defineCallback(
  'chat-onchain-enable',
  /^chat:(-?\d+):onchain-enable$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-onchain-enable'), 10)}),
  ({chatId}) => `chat:${chatId}:onchain-enable`,
)

export const chatOnchainDisableRoute = defineCallback(
  'chat-onchain-disable',
  /^chat:(-?\d+):onchain-disable$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'chat-onchain-disable'), 10)}),
  ({chatId}) => `chat:${chatId}:onchain-disable`,
)

// --- Subscriptions ---

export const subscriptionsPageRoute = defineCallback(
  'subscriptions-page',
  /^subscriptions:(\d+)$/,
  match => {
    const page = parseInt(requireGroup(match, 1, 'subscriptions-page'), 10)
    if (Number.isNaN(page) || page <= 0) return {page: 1}
    return {page}
  },
  ({page}) => `subscriptions:${page}`,
)

export const subscriptionRoute = defineCallback(
  'subscription',
  /^subscription:([a-f0-9-]+)$/,
  match => ({subscriptionId: requireGroup(match, 1, 'subscription')}),
  ({subscriptionId}) => `subscription:${subscriptionId}`,
)

export const subscriptionRenewRoute = defineCallback(
  'subscription-renew',
  /^subscription:([a-f0-9-]+):renew$/,
  match => ({subscriptionId: requireGroup(match, 1, 'subscription-renew')}),
  ({subscriptionId}) => `subscription:${subscriptionId}:renew`,
)

export const paySubscriptionRoute = defineCallback(
  'pay-subscription',
  /^pay-sub:([a-f0-9-]+):(wallet|nwc)$/,
  match => {
    const paymentId = requireGroup(match, 1, 'pay-subscription')
    const from = requireGroup(match, 2, 'pay-subscription')
    if (from !== 'wallet' && from !== 'nwc') throw new Error('Invalid pay-subscription source')
    return {paymentId, from: from as 'wallet' | 'nwc'}
  },
  ({paymentId, from}) => `pay-sub:${paymentId}:${from}`,
)

/** Member chooses on-chain rail for a paid chat join. */
export const payOnchainRoute = defineCallback(
  'pay-onchain',
  /^pay-onchain:(-?\d+)$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'pay-onchain'), 10)}),
  ({chatId}) => `pay-onchain:${chatId}`,
)

/** Member switches join invoice view back to Lightning from on-chain. */
export const payLightningRoute = defineCallback(
  'pay-lightning',
  /^pay-lightning:(-?\d+)$/,
  match => ({chatId: parseInt(requireGroup(match, 1, 'pay-lightning'), 10)}),
  ({chatId}) => `pay-lightning:${chatId}`,
)

// --- Donations ---

export const donationPercentRoute = defineCallback(
  'donation-percent',
  /^donation:percent:(\d+)$/,
  match => ({percent: parseInt(requireGroup(match, 1, 'donation-percent'), 10)}),
  ({percent}) => `donation:percent:${percent}`,
)

export const donationScopeRoute = defineCallback(
  'donation-scope',
  /^donation:scope:(tips|all)$/,
  match => {
    const scope = requireGroup(match, 1, 'donation-scope')
    if (scope !== 'tips' && scope !== 'all') throw new Error('Invalid donation scope')
    return {scope: scope as 'tips' | 'all'}
  },
  ({scope}) => `donation:scope:${scope}`,
)

export const donateAmountRoute = defineCallback(
  'donate-amount',
  /^donate:amount:(\d+)$/,
  match => ({amountSats: parseInt(requireGroup(match, 1, 'donate-amount'), 10)}),
  ({amountSats}) => `donate:amount:${amountSats}`,
)

export const donateMonthlyAmountRoute = defineCallback(
  'donate-monthly-amount',
  /^donate:monthly:(\d+)$/,
  match => ({amountSats: parseInt(requireGroup(match, 1, 'donate-monthly-amount'), 10)}),
  ({amountSats}) => `donate:monthly:${amountSats}`,
)

/** All parameterized routes — used by tests for round-trip coverage. */
export const parameterizedRoutes = [
  chatsPageRoute,
  chatRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatChangePriceRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatRemoveCustomMessageRoute,
  chatOnchainEnableRoute,
  chatOnchainDisableRoute,
  subscriptionsPageRoute,
  subscriptionRoute,
  subscriptionRenewRoute,
  paySubscriptionRoute,
  payOnchainRoute,
  payLightningRoute,
  donationPercentRoute,
  donationScopeRoute,
  donateAmountRoute,
  donateMonthlyAmountRoute,
] as const

/** Static callback_data strings (no parse params). */
export const staticCallback = {
  wallet: 'wallet',
  settings: 'settings',
  help: 'help',
  cancel: 'cancel',
  sendMenu: 'send-menu',
  sendToUser: 'send-to-user',
  payInvoice: 'pay-invoice',
  createInvoice: 'create-invoice',
  addInvoiceMemo: 'add-invoice-memo',
  connectNwc: 'connect-nwc',
  disconnectNwc: 'disconnect-nwc',
  toggleNwcTips: 'toggle-nwc-tips',
  groupSettings: 'group-settings',
  donationSettings: 'donation-settings',
  donationCustomPercent: 'donation-custom-percent',
  donate: 'donate',
  donateCustom: 'donate-custom',
  donateMonthlyMenu: 'donate-monthly-menu',
  donateMonthlyDisable: 'donate-monthly-disable',
  donateMonthlyCustom: 'donate-monthly-custom',
} as const
