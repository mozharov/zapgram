import type {AppConfig} from '@config'
import type {Listener} from '@ngrok/ngrok'
import type {AppLogger} from './logger.js'

let tunnel: Listener | undefined
export let tunnelUrl: string | null = null

export async function startTunnel(config: AppConfig, log: AppLogger): Promise<string> {
  log.info('Starting tunnel...')
  const ngrok = await import('@ngrok/ngrok')
  tunnel = await ngrok.connect({port: config.PORT, authtoken: config.NGROK_TOKEN})
  tunnelUrl = tunnel.url()
  if (!tunnelUrl) throw new Error(`Failed to get tunnel URL`)
  log.info(`Tunnel started: ${tunnelUrl}`)
  return tunnelUrl
}

export async function stopTunnel(log?: AppLogger): Promise<void> {
  if (!tunnel) return
  log?.info('Stopping tunnel...')
  await tunnel.close()
}
