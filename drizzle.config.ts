import {defineConfig} from 'drizzle-kit'
import {config} from './src/config'

export default defineConfig({
  out: './drizzle',
  schema: './src/infra/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {url: config.DB_URL},
})
