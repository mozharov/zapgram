import {defineConfig} from 'drizzle-kit'
import {config} from './src/config'

export default defineConfig({
  out: './drizzle',
  schema: './src/lib/database/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {url: config.DB_URL},
})
