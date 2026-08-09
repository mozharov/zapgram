import {getRuntime} from '../../../runtime.js'

/** Drain in-flight admin broadcasts and purge old headers. */
export async function processBroadcasts(): Promise<void> {
  await getRuntime().broadcastService.processQueue()
}
