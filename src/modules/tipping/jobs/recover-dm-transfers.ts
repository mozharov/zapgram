import {getRuntime} from '../../../runtime.js'

/**
 * Finish DM transfers the wizard could not. Never pays a `pay_unknown` row again.
 * An invoice that was only saved is abandoned once it is old enough. A recipient
 * notice whose lease expired is sent from here, without the conversation.
 */
export async function recoverDmTransfers(): Promise<void> {
  const {dmTransfers, log} = getRuntime()
  for (let batch = 0; batch < 20; batch++) {
    const rows = await dmTransfers.listActionable(20, 0)
    if (rows.length === 0) return
    let progressed = false
    for (const row of rows) {
      try {
        const result = await dmTransfers.reconcile(row.id)
        if (result === 'settled' || result === 'abandoned') progressed = true
      } catch (error) {
        log.error({error, transferId: row.id}, 'DM transfer recovery failed')
      }
    }
    if (!progressed) return
  }
}
