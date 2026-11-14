import {resolveAppLocale} from '@core/i18n/locale.js'
import {decodeInvoice} from '@core/lightning/decode-invoice.js'
import type {PendingInvoice} from '@infra/db/types.js'
import {editMessageWidgetData, isMessageNotModified} from '@infra/telegram/widget-api.js'
import {
  buildInvoiceWidgetChatData,
  type InvoiceWidgetStatus,
} from '@modules/invoices/telegram/invoice-widget.js'
import {getUserOrThrow} from '@modules/users/repository.js'
import {translate} from '@telegram/i18n/i18n.js'
import {getRuntime} from '../../runtime.js'

const STATUS_KEY: Record<InvoiceWidgetStatus, string> = {
  pending: 'invoice-widget-status.pending',
  paid: 'invoice-widget-status.paid',
  expired: 'invoice-widget-status.expired',
  cancelled: 'invoice-widget-status.cancelled',
}

/**
 * Push a new status into the invoice widget. No-op when the invoice was shown as a QR photo.
 * Failures are logged and swallowed: the payment notification must not depend on the widget.
 */
export async function syncInvoiceWidget(
  invoice: Pick<
    PendingInvoice,
    'paymentRequest' | 'paymentHash' | 'userId' | 'widgetChatId' | 'widgetMessageId'
  >,
  status: InvoiceWidgetStatus,
): Promise<void> {
  if (invoice.widgetChatId == null || invoice.widgetMessageId == null) return

  const log = getRuntime().log
  try {
    const user = await getUserOrThrow(invoice.userId)
    const locale = resolveAppLocale({storedLanguageCode: user.languageCode})
    const decoded = decodeInvoice(invoice.paymentRequest)
    const {chatData} = buildInvoiceWidgetChatData({
      status,
      amountSats: decoded.satoshi ?? 0,
      locale,
      label: translate(STATUS_KEY[status], user.languageCode ?? 'en'),
      bolt11: invoice.paymentRequest,
    })
    await editMessageWidgetData(getRuntime().bot.api, {
      chat_id: invoice.widgetChatId,
      message_id: invoice.widgetMessageId,
      chat_data: chatData,
    })
    log.info(
      {
        userId: invoice.userId,
        paymentHash: invoice.paymentHash,
        messageId: invoice.widgetMessageId,
        status,
      },
      'Invoice widget updated',
    )
  } catch (error) {
    if (isMessageNotModified(error)) return
    log.warn(
      {
        userId: invoice.userId,
        paymentHash: invoice.paymentHash,
        messageId: invoice.widgetMessageId,
        status,
        description: error instanceof Error ? error.message : String(error),
      },
      'Failed to update invoice widget',
    )
  }
}
