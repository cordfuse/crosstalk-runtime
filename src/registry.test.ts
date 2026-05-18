import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRegistry, getPoolInstances, listRoles, resolveAddress } from './registry.js'

// ── Per-test transport directory ────────────────────────────────────────────
// Each test creates its own tmpdir to avoid any shared-state pollution.
// Returns the transport root + a writeActor helper bound to it. The tmpdir
// is intentionally NOT cleaned up automatically; bun's test runner is fast
// enough that test isolation matters more than disk hygiene.

function freshTransport(): {
  root: string
  writeActor: (name: string, opts?: { agent?: string; command?: string; layer?: 'custom' | 'framework' }) => void
} {
  const root = mkdtempSync(join(tmpdir(), 'crosstalk-reg-'))
  mkdirSync(join(root, 'manifest', 'custom', 'actors'), { recursive: true })
  mkdirSync(join(root, "manifest", "framework", "actors"), { recursive: true })
  mkdirSync(join(root, "empty-local"), { recursive: true })

  return {
    root,
    writeActor(name, opts = {}) {
      const layer = opts.layer ?? 'custom'
      const fmKey = opts.agent ? 'agent' : 'command'
      const fmValue = opts.agent ?? opts.command ?? 'echo'
      const content = `---
name: ${name}
type: machine
role: test
${fmKey}: ${fmValue}
---

Test actor ${name}
`
      writeFileSync(join(root, 'manifest', layer, 'actors', `${name}.md`), content)
    },
  }
}

describe('loadRegistry — single-operator mode (no operator config)', () => {
  it('uses bare names as addresses', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    t.writeActor('bob', { agent: 'gemini' })

    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 2)
    assert.ok(registry.has('alice'))
    assert.ok(registry.has('bob'))
    assert.equal(registry.get('alice')!.address, 'alice')
    assert.equal(registry.get('alice')!.operator, undefined)
    assert.equal(registry.get('alice')!.role, 'alice')
  })

  it('preserves all v1.2 ActorConfig fields (backward compat)', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    const alice = registry.get('alice')!
    assert.equal(alice.name, 'alice')
    assert.equal(alice.agent, 'claude')
    assert.deepEqual(alice.args, [])
  })

  it('skips actors with neither agent nor command', async () => {
    const t = freshTransport()
    const content = `---\nname: incomplete\ntype: human\n---\n\nBody\n`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'incomplete.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 0)
  })

  it('rejects non-kebab-case filenames', async () => {
    const t = freshTransport()
    const content = `---\nname: AliceCapital\nagent: claude\n---\n\nBody\n`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'AliceCapital.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 0)
  })
})

describe('loadRegistry — multi-operator mode (operator handle set)', () => {
  it('qualifies addresses with @operator suffix', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    t.writeActor('bob', { agent: 'gemini' })

    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.equal(registry.size, 2)
    assert.ok(registry.has('alice@steve'))
    assert.ok(registry.has('bob@steve'))
    assert.equal(registry.has('alice'), false, 'bare name should not be a key in multi-op mode')
    assert.equal(registry.get('alice@steve')!.address, 'alice@steve')
    assert.equal(registry.get('alice@steve')!.operator, 'steve')
    assert.equal(registry.get('alice@steve')!.role, 'alice')
  })
})

describe('loadRegistry — pool semantics (hyphen-integer migration)', () => {
  it('treats dart-thrower-1 ... dart-thrower-3 as 3 instances of one pool', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })
    t.writeActor('dart-thrower-3', { agent: 'opencode' })

    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 3)

    const pool = getPoolInstances(registry, 'dart-thrower')
    assert.equal(pool.length, 3)
    assert.deepEqual(pool.map(a => a.instance), [1, 2, 3])
    assert.equal(pool[0].role, 'dart-thrower')
    assert.equal(pool[0].name, 'dart-thrower-1')
    assert.equal(pool[0].address, 'dart-thrower-1')  // bare in single-op mode
  })

  it('qualifies instance addresses in multi-op mode', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })

    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.equal(registry.get('dart-thrower-1@steve')!.address, 'dart-thrower-1@steve')
    assert.equal(registry.get('dart-thrower-1@steve')!.instance, 1)
    assert.equal(registry.get('dart-thrower-1@steve')!.role, 'dart-thrower')
    assert.equal(registry.get('dart-thrower-1@steve')!.operator, 'steve')
  })

  it('mixes singletons and pools cleanly', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })       // singleton
    t.writeActor('dart-thrower-1', { agent: 'opencode' })  // pool instance 1
    t.writeActor('dart-thrower-2', { agent: 'opencode' })  // pool instance 2

    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 3)
    assert.equal(getPoolInstances(registry, 'alice').length, 1)
    assert.equal(getPoolInstances(registry, 'dart-thrower').length, 2)
  })

  it('handles 20-actor Monte Carlo style migration', async () => {
    const t = freshTransport()
    for (let i = 1; i <= 20; i++) {
      t.writeActor(`dart-thrower-${i}`, { agent: 'opencode' })
    }
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.size, 20)
    const pool = getPoolInstances(registry, 'dart-thrower')
    assert.equal(pool.length, 20)
    assert.deepEqual(pool.map(a => a.instance), Array.from({ length: 20 }, (_, i) => i + 1))
  })
})

describe('listRoles', () => {
  it('deduplicates pool instances', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })

    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    const roles = listRoles(registry)
    assert.deepEqual(roles, ['alice', 'dart-thrower'])
  })
})

describe('getPoolInstances', () => {
  it('filters by operator when provided', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')

    assert.equal(getPoolInstances(registry, 'alice', 'steve').length, 1)
    assert.equal(getPoolInstances(registry, 'alice', 'bob').length, 0)
  })

  it('returns empty for unknown roles', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(getPoolInstances(registry, 'nonexistent').length, 0)
  })
})

describe('resolveAddress — address resolution against registry', () => {
  it('resolves pool address to all instances', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })
    t.writeActor('dart-thrower-3', { agent: 'opencode' })

    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const matches = resolveAddress(registry, 'dart-thrower@steve')
    assert.equal(matches.length, 3)
    assert.deepEqual(matches.map(a => a.instance).sort((a, b) => a! - b!), [1, 2, 3])
  })

  it('resolves specific instance to single match', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })

    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const matches = resolveAddress(registry, 'dart-thrower-2@steve')
    assert.equal(matches.length, 1)
    assert.equal(matches[0].instance, 2)
  })

  it('returns empty for nonexistent instance', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.equal(resolveAddress(registry, 'dart-thrower-99@steve').length, 0)
  })

  it('returns empty for malformed addresses', async () => {
    const t = freshTransport()
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(resolveAddress(registry, '@invalid').length, 0)
    assert.equal(resolveAddress(registry, 'INVALID').length, 0)
  })

  it('resolves singleton in single-op mode by bare name', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'claude' })
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    const matches = resolveAddress(registry, 'alice')
    assert.equal(matches.length, 1)
    assert.equal(matches[0].name, 'alice')
  })
})

describe('loadRegistry — three-layer merging', () => {
  it('custom layer overrides framework layer on collision', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'framework-agent', layer: 'framework' })
    t.writeActor('alice', { agent: 'custom-agent', layer: 'custom' })
    const registry = await loadRegistry(t.root, undefined, t.root + "/empty-local")
    assert.equal(registry.get('alice')!.agent, 'custom-agent')
  })
})
