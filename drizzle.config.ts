import {defineConfig} from 'drizzle-kit'
import {createConfig} from './src/config/index.ts'

const config = createConfig()

export default defineConfig({
  out: './drizzle',
  schema: './src/infra/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {url: config.DB_URL},
})
