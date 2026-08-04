import {createApp} from '@bootstrap/app.js'
import {createContainer} from '@bootstrap/container.js'

const container = await (async () => {
  try {
    return await createContainer()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
})()

const {log, posthog} = container
const app = createApp(container)

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true

  log.info(`Received ${signal}, shutting down...`)

  const forceTimer = setTimeout(() => {
    log.error('Could not close connections in time, forcefully shutting down')
    process.exit(1)
  }, 15_000)
  forceTimer.unref?.()

  try {
    await app.stop()
    await posthog?.shutdown()
    process.exit(0)
  } catch (error) {
    log.error({error}, 'Failed to shut down cleanly')
    await posthog?.shutdown()
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.start()
} catch (error) {
  log.error({error}, 'Failed to start application')
  process.exit(1)
}
