import {expect, test} from 'bun:test'
import {type ChildProcess, spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const entrypoint = join(import.meta.dir, '../ops/lnbits/lnbits-restart-entrypoint.py')
const repoRoot = join(import.meta.dir, '..')
const upstreamCommand =
  "uv --offline run lnbits --port $LNBITS_PORT --host $LNBITS_HOST --forwarded-allow-ips='*'"

// Long-running fakes die if the wrapper is killed, so a timed-out test
// does not leave a sleeper in its own session behind.
const dieWithParent = `
import ctypes, signal
try:
    ctypes.CDLL(None).prctl(1, int(signal.SIGKILL))
except Exception:
    pass
`

type RunResult = {
  code: number | null
  stderr: string
}

function runEntrypoint(
  args: string[],
  env: Record<string, string>,
  options?: {signal?: NodeJS.Signals; signalAfterMs?: number; timeoutMs?: number},
): Promise<RunResult> {
  const timeoutMs = options?.timeoutMs ?? 8_000
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-u', entrypoint, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...env,
      },
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    const signalTimer =
      options?.signal != null && options.signalAfterMs != null
        ? setTimeout(() => {
            if (child.pid == null) return
            try {
              process.kill(child.pid, options.signal)
            } catch {
              // already exited
            }
          }, options.signalAfterMs)
        : undefined
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      if (signalTimer) clearTimeout(signalTimer)
      killTree(child)
      reject(error)
    }
    const killer = setTimeout(() => {
      fail(new Error(`entrypoint timed out\n${stderr}`))
    }, timeoutMs)
    child.on('error', error => {
      fail(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      if (signalTimer) clearTimeout(signalTimer)
      resolve({code, stderr})
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid == null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already exited
    }
  }
}

test('interval 0 runs the command and returns its exit code', async () => {
  const result = await runEntrypoint(['python3', '-c', 'import sys; sys.exit(3)'], {
    LNBITS_RESTART_INTERVAL_HOURS: '0',
  })
  expect(result.code).toBe(3)
  expect(result.stderr).toContain('planned restart disabled')
  expect(result.stderr).not.toContain('stopping LNbits')
})

test('an unset interval logs the 96h default and still returns the child status', async () => {
  const result = await runEntrypoint(['python3', '-c', 'import sys; sys.exit(0)'], {})
  expect(result.code).toBe(0)
  expect(result.stderr).toContain('planned restart in 96h')
})

test('a non-numeric interval refuses to start the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-restart-'))
  const marker = join(dir, 'started')
  try {
    const result = await runEntrypoint(
      ['python3', '-c', 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_text("x")', marker],
      {LNBITS_RESTART_INTERVAL_HOURS: 'soon'},
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('LNBITS_RESTART_INTERVAL_HOURS must be a number')
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})

test('a negative interval refuses to start the command', async () => {
  const result = await runEntrypoint(['python3', '-c', 'import sys; sys.exit(0)'], {
    LNBITS_RESTART_INTERVAL_HOURS: '-1',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('finite number >= 0')
})

test('a child that exits before the interval is not a planned restart', async () => {
  const result = await runEntrypoint(['python3', '-c', 'import sys; sys.exit(0)'], {
    LNBITS_RESTART_INTERVAL_HOURS: '96',
  })
  expect(result.code).toBe(0)
  expect(result.stderr).not.toContain('stopping LNbits')
})

test('the planned interval SIGTERMs the process group and exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-restart-'))
  const marker = join(dir, 'term')
  const child = `
import ctypes, os, signal, sys, time
def die_with_parent():
    try:
        ctypes.CDLL(None).prctl(1, int(signal.SIGKILL))
    except Exception:
        pass
die_with_parent()
marker = sys.argv[1]
pid = os.fork()
if pid == 0:
    die_with_parent()
    signal.signal(signal.SIGTERM, lambda *_: (open(marker, "w").write("term"), sys.exit(0)))
    time.sleep(60)
    sys.exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.waitpid(pid, 0)
sys.exit(0)
`
  try {
    const result = await runEntrypoint(['python3', '-c', child, marker], {
      LNBITS_RESTART_INTERVAL_HOURS: String(1.5 / 3600),
      LNBITS_RESTART_STOP_TIMEOUT_SECONDS: '5',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('interval elapsed, stopping LNbits')
    expect(result.stderr).not.toContain('sending SIGKILL')
    expect(readFileSync(marker, 'utf8')).toBe('term')
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}, 20_000)

test('a child that ignores SIGTERM is SIGKILLed and the wrapper exits 1', async () => {
  const child = `
${dieWithParent}
import signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
time.sleep(120)
`
  const result = await runEntrypoint(['python3', '-c', child], {
    LNBITS_RESTART_INTERVAL_HOURS: String(1 / 3600),
    LNBITS_RESTART_STOP_TIMEOUT_SECONDS: '0.4',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('sending SIGKILL')
  expect(result.stderr).toContain('exiting so the container restart policy')
}, 20_000)

test('SIGTERM from outside is forwarded and is not a planned restart', async () => {
  const child = `
${dieWithParent}
import signal, sys, time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(60)
`
  const result = await runEntrypoint(
    ['python3', '-c', child],
    {LNBITS_RESTART_INTERVAL_HOURS: '96'},
    {signal: 'SIGTERM', signalAfterMs: 200},
  )
  expect(result.code).toBe(0)
  expect(result.stderr).toContain('received SIGTERM')
  expect(result.stderr).not.toContain('stopping LNbits')
})

test('a missing command exits 127 without a planned restart', async () => {
  const result = await runEntrypoint(['/no/such/lnbits-command'], {
    LNBITS_RESTART_INTERVAL_HOURS: '0',
  })
  expect(result.code).toBe(127)
  expect(result.stderr).toContain('command not found')
  expect(result.stderr).not.toContain('stopping LNbits')
})

test('SIGINT from outside is forwarded', async () => {
  const child = `
${dieWithParent}
import signal, sys, time
signal.signal(signal.SIGINT, lambda *_: sys.exit(4))
time.sleep(60)
`
  const result = await runEntrypoint(
    ['python3', '-c', child],
    {LNBITS_RESTART_INTERVAL_HOURS: '0'},
    {signal: 'SIGINT', signalAfterMs: 200},
  )
  expect(result.code).toBe(4)
  expect(result.stderr).toContain('received SIGINT')
})

test('compose has no ofelia or docker.sock and lnbits restarts itself', () => {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yaml'), 'utf8')
  expect(compose).not.toContain('ofelia')
  expect(compose).not.toContain('docker.sock')

  const start = compose.indexOf('\n  lnbits:\n')
  const end = compose.indexOf('\n  landing:\n')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = compose.slice(start, end)
  expect(block).toContain('restart: unless-stopped')
  expect(block).toContain('context: ./ops/lnbits')
  expect(block).toContain('LNBITS_IMAGE: lnbits/lnbits:v1.5.6')
  expect(block).toContain(
    'LNBITS_RESTART_INTERVAL_HOURS: $' + '{LNBITS_RESTART_INTERVAL_HOURS:-96}',
  )
  expect(block).not.toContain('\n    command:')
  expect(block).toContain('lnbits-data:/app/data')
  expect(block).toContain('"5000"')
})

test('the image keeps the upstream LNbits command', () => {
  const dockerfile = readFileSync(join(repoRoot, 'ops/lnbits/Dockerfile'), 'utf8')
  const wrapper = readFileSync(entrypoint, 'utf8')
  expect(dockerfile).toContain('ARG LNBITS_IMAGE=lnbits/lnbits:v1.5.6')
  expect(dockerfile).toContain(
    'ENTRYPOINT ["python", "-u", "/usr/local/bin/lnbits-restart-entrypoint.py"]',
  )
  expect(dockerfile).toContain(upstreamCommand)
  expect(wrapper).toContain(upstreamCommand)
})
