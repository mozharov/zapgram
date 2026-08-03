import type {AppLogger} from '@infra/logger.js'

export type RunBatchOptions<T> = {
  name: string
  log: AppLogger
  /** Default 10. */
  batchSize?: number
  count: () => Promise<number>
  fetch: (limit: number, offset: number) => Promise<T[]>
  process: (item: T) => Promise<'done' | 'keep'>
}

/**
 * Walks a paginated work queue until empty.
 *
 * Settled / deleted rows shift the remaining ones left. Advancing `offset` by a fixed
 * `batchSize` would therefore skip exactly as many items as the batch removed — so offset
 * only increases by the number of survivors (`keep`). Items that return `done` were removed
 * from the underlying set (or no longer match the query) and must not advance offset.
 *
 * An error inside `process` is logged and treated as `keep` so one bad row cannot kill the job.
 */
export async function runBatch<T>(opts: RunBatchOptions<T>): Promise<{processed: number}> {
  const batchSize = opts.batchSize ?? 10
  const total = await opts.count()
  opts.log.info(`Found ${total} ${opts.name}.`)
  if (total === 0) return {processed: 0}

  let processed = 0
  let offset = 0

  while (true) {
    const items = await opts.fetch(batchSize, offset)
    if (items.length === 0) break

    opts.log.info(`Processing batch of ${items.length} ${opts.name}.`)

    let kept = 0
    for (const item of items) {
      try {
        const result = await opts.process(item)
        if (result === 'keep') kept++
      } catch (error) {
        opts.log.error({error}, `Error processing item in ${opts.name}`)
        kept++
      }
    }

    processed += items.length
    offset += kept
  }

  opts.log.info(`Finished processing ${processed} ${opts.name}.`)
  return {processed}
}
