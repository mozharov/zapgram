import {payPastedBackRoute, payPastedRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {createInvoiceCallback} from './telegram/handlers/create-invoice.js'
import {lnInvoiceHears} from './telegram/handlers/ln-invoice.js'
import {
  pastedPaymentText,
  payPastedBackCallback,
  payPastedCallback,
} from './telegram/handlers/pasted-payment.js'
import {payInvoiceCallback} from './telegram/handlers/pay-invoice.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  // createConversation(payingInvoice / creatingInvoice) live in telegram/composition.ts.
  privateChat.callbackQuery(staticCallback.payInvoice, payInvoiceCallback)
  privateChat.callbackQuery(staticCallback.createInvoice, createInvoiceCallback)
  privateChat.callbackQuery(payPastedRoute.pattern, payPastedCallback)
  privateChat.callbackQuery(payPastedBackRoute.pattern, payPastedBackCallback)
  // Whole-message bolt11 / address / LNURL before the substring hears, so
  // `LIGHTNING:LNBC…` reaches the same pay flow as a bare `lnbc…`. An address or
  // LNURL is offered Pay here; the amount step is payingLnurl.
  privateChat.on('message:text', pastedPaymentText)
  privateChat.hears(/(lnbc[a-z0-9]+)/).use(lnInvoiceHears)
}
