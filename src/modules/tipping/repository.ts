import type {AppDatabase} from '@infra/db/client.js'
import {tipCommandsTable} from '@infra/db/schema.js'

export function createTipCommandRepository(db: AppDatabase) {
  return {
    async claim(command: typeof tipCommandsTable.$inferInsert): Promise<boolean> {
      // Claim before any payment I/O. Never release: even a failed pay may have moved money.
      const rows = await db
        .insert(tipCommandsTable)
        .values(command)
        .onConflictDoNothing()
        .returning()
      return rows.length === 1
    },
  }
}

export type TipCommandRepository = ReturnType<typeof createTipCommandRepository>
