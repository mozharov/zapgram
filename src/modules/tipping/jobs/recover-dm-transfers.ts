import {getRuntime} from '../../../runtime.js'

/**
 * Finish DM transfers the wizard could not. Never pays a `pay_unknown` row again.
 * An invoice that was only saved is abandoned once it is old enough. A recipient
 * notice whose lease expired is sent from here, without the conversation.
 */
const PAGE = 20

type RecoveryResult = 'settled' | 'abandoned' | 'in_flight' | 'needs_review'

/**
 * Walk the actionable rows. A page that only stays in flight does not end the
 * run: the next page is still read. Each selected row is reconciled once per run.
 */
export async function runDmTransferRecovery(input: {
  list: (limit: number, offset: number) => Promise<{id: string}[]>
  reconcile: (id: string) => Promise<RecoveryResult>
  log: {error: (obj: unknown, msg: string) => void}
}): Promise<void> {
  // Snapshot the bounded batch before reconciling: review and failed notices stay
  // actionable, while settled rows may disappear or move in the ordering.
  const pending = new Set<string>()
  for (let batch = 0; batch < PAGE; batch++) {
    const rows = await input.list(PAGE, batch * PAGE)
    for (const row of rows) pending.add(row.id)
    if (rows.length < PAGE) break
  }
  for (const id of pending) {
    try {
      await input.reconcile(id)
    } catch (error) {
      input.log.error({error, transferId: id}, 'DM transfer recovery failed')
    }
  }
}

export async function recoverDmTransfers(): Promise<void> {
  const {dmTransfers, lnurlPays, log} = getRuntime()
  await runDmTransferRecovery({
    list: (limit, offset) => dmTransfers.listActionable(limit, offset),
    reconcile: id => dmTransfers.reconcile(id),
    log,
  })
  await runDmTransferRecovery({
    list: (limit, offset) => lnurlPays.listActionable(limit, offset),
    reconcile: id => lnurlPays.reconcile(id),
    log,
  })
}
