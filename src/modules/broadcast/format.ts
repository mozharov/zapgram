import type {AppLocale} from '@core/i18n/locale.js'
import type {Broadcast} from '@infra/db/types.js'

export function formatBroadcastStarted(locale: AppLocale, totalCount: number): string {
  const lang = locale === 'ru' ? 'Russian' : 'English'
  return `📣 Broadcast started (${lang}): <b>${totalCount}</b> recipient(s). You will get a report when it finishes.`
}

export function formatBroadcastReport(broadcast: Broadcast): string {
  const lang = broadcast.locale === 'ru' ? 'Russian' : 'English'
  return [
    `✅ Broadcast finished (${lang})`,
    `Total: <b>${broadcast.totalCount}</b>`,
    `Sent: <b>${broadcast.sentCount}</b>`,
    `Failed: <b>${broadcast.failedCount}</b>`,
    `Skipped (blocked): <b>${broadcast.skippedCount}</b>`,
  ].join('\n')
}

export function formatBroadcastConfirm(locale: AppLocale, totalCount: number): string {
  const lang = locale === 'ru' ? 'Russian' : 'English'
  return `Send this message to <b>${totalCount}</b> ${lang} user(s)?`
}
