import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'

// loadConfig uses process.env.CROSSTALK_CONFIG to pick the config file
// path, so each test writes a tmpdir config + sets the env. The
// transport field is required but the path doesn't have to exist on
// disk for parse-time tests.
function writeTmpConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crosstalk-cfg-test-'))
  const path = join(dir, 'config.toml')
  writeFileSync(path, toml, 'utf-8')
  return path
}

describe('loadConfig — [agent-environment] table (v1.6.0-alpha.1+)', () => {
  it('absent table → agentEnv is empty object', async () => {
    const path = writeTmpConfig(`
transport = "/tmp/x"
[relay]
mode = "disabled"
`)
    process.env.CROSSTALK_CONFIG = path
    const config = await loadConfig()
    assert.deepEqual(config.agentEnv, {})
  })

  it('flat KEY = "value" entries populate agentEnv', async () => {
    const path = writeTmpConfig(`
transport = "/tmp/x"
[relay]
mode = "disabled"
[agent-environment]
HOME = "/home/realuser"
GEMINI_API_KEY = "sk-abc"
NODE_OPTIONS = "--max-old-space-size=4096"
`)
    process.env.CROSSTALK_CONFIG = path
    const config = await loadConfig()
    assert.equal(config.agentEnv.HOME, '/home/realuser')
    assert.equal(config.agentEnv.GEMINI_API_KEY, 'sk-abc')
    assert.equal(config.agentEnv.NODE_OPTIONS, '--max-old-space-size=4096')
  })

  it('values are taken literally — no "~" expansion', async () => {
    // Rationale: homedir() reads $HOME at process start. In sandboxed
    // multi-operator deployments that's the daemon's sandbox, NOT the
    // operator's real home. ~ expansion would silently resolve to the
    // wrong path. Operators must spell out absolute paths.
    const path = writeTmpConfig(`
transport = "/tmp/x"
[relay]
mode = "disabled"
[agent-environment]
HOME = "/home/realuser"
GEMINI_CONFIG = "~/.gemini"
`)
    process.env.CROSSTALK_CONFIG = path
    const config = await loadConfig()
    assert.equal(config.agentEnv.HOME, '/home/realuser')
    assert.equal(config.agentEnv.GEMINI_CONFIG, '~/.gemini',
      'tilde stays literal — operator chose to write it')
  })

  it('non-string values get skipped with a warning', async () => {
    const path = writeTmpConfig(`
transport = "/tmp/x"
[relay]
mode = "disabled"
[agent-environment]
HOME = "/home/realuser"
TIMEOUT = 30
DEBUG = true
`)
    process.env.CROSSTALK_CONFIG = path
    const config = await loadConfig()
    // Only the string entry survives
    assert.equal(config.agentEnv.HOME, '/home/realuser')
    assert.equal(config.agentEnv.TIMEOUT, undefined,
      'integer values should be skipped (env vars are strings)')
    assert.equal(config.agentEnv.DEBUG, undefined,
      'boolean values should be skipped (env vars are strings)')
  })

  it('empty table is fine', async () => {
    const path = writeTmpConfig(`
transport = "/tmp/x"
[relay]
mode = "disabled"
[agent-environment]
`)
    process.env.CROSSTALK_CONFIG = path
    const config = await loadConfig()
    assert.deepEqual(config.agentEnv, {})
  })
})
