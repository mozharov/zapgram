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
 * run: the next page is still read. A row that leaves the set pulls the front
 * forward, so the following read starts at the beginning again.
 */
export async function runDmTransferRecovery(input: {
  list: (limit: number, offset: number) => Promise<{id: string}[]>
  reconcile: (id: string) => Promise<RecoveryResult>
  log: {error: (obj: unknown, msg: string) => void}
}): Promise<void> {
  let offset = 0
  for (let batch = 0; batch < PAGE; batch++) {
    const rows = await input.list(PAGE, offset)
    if (rows.length === 0) return
    let progressed = 0
    for (const row of rows) {
      try {
        const result = await input.reconcile(row.id)
        if (result === 'settled' || result === 'abandoned' || result === 'needs_review') {
          progressed += 1
        }
      } catch (error) {
        input.log.error({error, transferId: row.id}, 'DM transfer recovery failed')
      }
    }
    if (progressed === 0) offset += rows.length
    else offset = 0
    if (rows.length < PAGE && progressed === 0) return
  }
}

export async function recoverDmTransfers(): Promise<void> {
  const {dmTransfers, log} = getRuntime()
  await runDmTransferRecovery({
    list: (limit, offset) => dmTransfers.listActionable(limit, offset),
    reconcile: id => dmTransfers.reconcile(id),
    log,
  })
}
