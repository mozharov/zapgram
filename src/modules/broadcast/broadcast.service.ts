import type {AppLocale} from '@core/i18n/locale.js'
import {sleep} from '@core/utils/sleep.js'
import type {Broadcast} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {BroadcastRepository} from '@modules/broadcast/repository.js'
import {
  isTelegramUserUnreachableError,
  telegramErrorMessage,
} from '@modules/broadcast/telegram-errors.js'
import type {UserRepository} from '@modules/users/repository.js'

/** Headroom under Telegram’s ~30 msg/s bulk ceiling so interactive traffic can share the budget. */
export const BROADCAST_MIN_INTERVAL_MS = 50

export const BROADCAST_HEADER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const PENDING_BATCH = 50

export type CopyMessageOutcome = 'sent' | 'blocked' | 'failed'

export type BroadcastServiceDeps = {
  broadcasts: BroadcastRepository
  users: Pick<UserRepository, 'listBroadcastRecipientIds' | 'setBotBlocked'>
  copyMessage: (
    toUserId: number,
    fromChatId: number,
    messageId: number,
  ) => Promise<CopyMessageOutcome>
  notifyAdmin: (adminUserId: number, text: string) => Promise<boolean>
  formatStarted: (locale: AppLocale, totalCount: number) => string
  formatReport: (broadcast: Broadcast) => string
  log: AppLogger
  minIntervalMs?: number
  now?: () => Date
}

export function createBroadcastService(deps: BroadcastServiceDeps) {
  const minIntervalMs = deps.minIntervalMs ?? BROADCAST_MIN_INTERVAL_MS
  const now = () => deps.now?.() ?? new Date()

  async function countRecipients(locale: AppLocale, adminUserId: number): Promise<number> {
    const ids = await deps.users.listBroadcastRecipientIds({
      locale,
      excludeUserId: adminUserId,
    })
    return ids.length
  }

  /**
   * Snapshot recipients and mark campaign sending. Caller should reply with formatStarted.
   * Empty audience still creates a completed-ready campaign (job finishes immediately).
   */
  async function startBroadcast(input: {
    adminUserId: number
    locale: AppLocale
    sourceChatId: number
    sourceMessageId: number
  }): Promise<{broadcast: Broadcast; totalCount: number}> {
    const recipientUserIds = await deps.users.listBroadcastRecipientIds({
      locale: input.locale,
      excludeUserId: input.adminUserId,
    })

    const broadcast = await deps.broadcasts.createSending({
      adminUserId: input.adminUserId,
      locale: input.locale,
      sourceChatId: input.sourceChatId,
      sourceMessageId: input.sourceMessageId,
      recipientUserIds,
      now: now(),
    })

    deps.log.info(
      {
        broadcastId: broadcast.id,
        locale: input.locale,
        totalCount: recipientUserIds.length,
        adminUserId: input.adminUserId,
      },
      'Broadcast started',
    )

    return {broadcast, totalCount: recipientUserIds.length}
  }

  async function deliverOne(broadcast: Broadcast, userId: number): Promise<void> {
    let outcome: CopyMessageOutcome
    try {
      outcome = await deps.copyMessage(userId, broadcast.sourceChatId, broadcast.sourceMessageId)
    } catch (error) {
      // copyMessage dep should not throw; defensive
      outcome = isTelegramUserUnreachableError(error) ? 'blocked' : 'failed'
      deps.log.error({error, userId, broadcastId: broadcast.id}, 'Broadcast copy threw')
    }

    if (outcome === 'sent') {
      await deps.broadcasts.markRecipient(broadcast.id, userId, 'sent', null, now())
      return
    }

    if (outcome === 'blocked') {
      await deps.users.setBotBlocked(userId, true)
      await deps.broadcasts.markRecipient(broadcast.id, userId, 'skipped', 'bot_blocked', now())
      return
    }

    await deps.broadcasts.markRecipient(broadcast.id, userId, 'failed', 'copy_failed', now())
  }

  async function processBroadcast(broadcastId: string): Promise<void> {
    const broadcast = await deps.broadcasts.findById(broadcastId)
    if (broadcast?.status !== 'sending') return

    // Drain pending in batches until empty.
    for (;;) {
      const pending = await deps.broadcasts.listPendingRecipients(broadcastId, PENDING_BATCH)
      if (pending.length === 0) break

      for (const {userId} of pending) {
        const current = await deps.broadcasts.findById(broadcastId)
        if (current?.status !== 'sending') return

        await deliverOne(current, userId)
        if (minIntervalMs > 0) await sleep(minIntervalMs)
      }
    }

    const remaining = await deps.broadcasts.countPending(broadcastId)
    if (remaining > 0) return

    const completed = await deps.broadcasts.markCompleted(broadcastId, now())
    if (!completed) return

    const fresh = (await deps.broadcasts.findById(broadcastId)) ?? completed
    const reportText = deps.formatReport(fresh)
    const sent = await deps.notifyAdmin(fresh.adminUserId, reportText)
    if (sent) {
      await deps.broadcasts.markReportSent(broadcastId, now())
    } else {
      deps.log.warn({broadcastId}, 'Failed to send broadcast report to admin')
    }

    await deps.broadcasts.deleteRecipients(broadcastId)
    deps.log.info(
      {
        broadcastId,
        sent: fresh.sentCount,
        failed: fresh.failedCount,
        skipped: fresh.skippedCount,
        total: fresh.totalCount,
      },
      'Broadcast completed',
    )
  }

  async function processQueue(): Promise<void> {
    const ids = await deps.broadcasts.listSendingIds()
    for (const id of ids) {
      try {
        await processBroadcast(id)
      } catch (error) {
        deps.log.error({error, broadcastId: id}, 'Broadcast processing failed')
      }
    }

    const cutoff = new Date(now().getTime() - BROADCAST_HEADER_RETENTION_MS)
    const purged = await deps.broadcasts.deleteCompletedOlderThan(cutoff)
    if (purged > 0) {
      deps.log.info({purged}, 'Purged old broadcast headers')
    }
  }

  return {
    countRecipients,
    startBroadcast,
    processQueue,
    processBroadcast,
    /** Test helper: wrap api errors into outcomes without going through Telegram. */
    classifyCopyError: (error: unknown): CopyMessageOutcome => {
      if (isTelegramUserUnreachableError(error)) return 'blocked'
      return 'failed'
    },
    formatError: telegramErrorMessage,
  }
}

export type BroadcastService = ReturnType<typeof createBroadcastService>
