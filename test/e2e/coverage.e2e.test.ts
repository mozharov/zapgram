import {expect, test} from 'bun:test'
import {readdirSync, readFileSync} from 'node:fs'
import {defaultJobDefinitions} from '@jobs/scheduler.js'
import {chatsCommands} from '@modules/chats/register.js'
import {donationCommands} from '@modules/donations/register.js'
import {subscriptionsCommands} from '@modules/subscriptions/register.js'
import {walletCommands} from '@modules/wallet/register.js'
import {parameterizedRoutes, staticCallback} from '@telegram/callback-data.js'
import {shellCommands} from '@telegram/composition.js'
import {errorTranslationKey} from '@telegram/errors/error-copy.js'
import {unhandledUpdateTypes} from './fixtures/updates.js'
import {type ScenarioCoverage, scenarioCoverage} from './scenarios/coverage.js'

const categories = ['routes', 'commands', 'updates', 'writes', 'jobs', 'errors'] as const
type Category = (typeof categories)[number]

const scenariosDirectory = new URL('./scenarios/', import.meta.url)
const scenarioFiles = readdirSync(scenariosDirectory)
  .filter(file => file.endsWith('.e2e.test.ts'))
  .sort()
const scenarioNames = scenarioFiles.map(file => file.replace(/\.e2e\.test\.ts$/, ''))
const registeredScenarioNames = Object.keys(scenarioCoverage).sort()
const coverageEntries: readonly ScenarioCoverage[] = Object.values(scenarioCoverage)

const handledUpdateTypes = [
  'my_chat_member',
  ':new_chat_title',
  'chat_join_request',
  'callback_query',
  'message',
  'hears',
] as const

const writeOperations = [
  'users.insert',
  'users.update',
  'chats.insert',
  'chats.update',
  'conversations.insert',
  'conversations.delete',
  'pending_invoices.insert',
  'pending_invoices.delete',
  'subscriptions.insert',
  'subscriptions.update',
  'subscriptions.delete',
  'subscription_intents.insert',
  'subscription_intents.update',
  'subscription_intents.delete',
  'subscription_payments.insert',
  'subscription_payments.update',
  'subscription_payments.delete',
  'onchain_chat_payments.insert',
  'onchain_chat_payments.update',
  'onchain_chat_payments.delete',
  'donations.insert',
  'donation_platform_stats.insert',
  'donation_platform_stats.update',
] as const

const inventory: Record<Category, readonly string[]> = {
  routes: [...parameterizedRoutes.map(route => route.name), ...Object.values(staticCallback)],
  commands: [
    ...shellCommands,
    ...walletCommands,
    ...chatsCommands,
    ...subscriptionsCommands,
    ...donationCommands,
  ].map(command => `/${command}`),
  updates: [...handledUpdateTypes, ...unhandledUpdateTypes],
  writes: writeOperations,
  jobs: defaultJobDefinitions().map(job => job.name),
  errors: Object.keys(errorTranslationKey),
}

test('coverage registry has one entry for every e2e scenario file', () => {
  expect(registeredScenarioNames).toEqual(scenarioNames)
})

for (const file of scenarioFiles) {
  test(`${file} exports COVERS`, () => {
    expect(readFileSync(new URL(file, scenariosDirectory), 'utf8')).toMatch(
      /export const COVERS = scenarioCoverage/,
    )
  })
}

for (const category of categories) {
  const expected = new Set(inventory[category])
  const covered = new Set(coverageEntries.flatMap(scenario => scenario[category]))

  for (const item of expected) {
    test(`coverage registry includes ${category}: ${item}`, () => {
      expect(covered.has(item)).toBe(true)
    })
  }

  test(`coverage registry only names registered ${category}`, () => {
    expect([...covered].filter(item => !expected.has(item)).sort()).toEqual([])
  })
}
