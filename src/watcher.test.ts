import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRegistry } from './registry.js'
import { resolveTargets } from './watcher.js'

// Per-test transport directory — same shape as registry.test.ts, smaller
// helper because we only need to write actors and load the registry.
function freshTransport(): {
  root: string
  writeActor: (name: string, opts?: { agent?: string; layer?: 'custom' | 'framework' }) => void
} {
  const root = mkdtempSync(join(tmpdir(), 'crosstalk-watcher-'))
  mkdirSync(join(root, 'manifest', 'custom', 'actors'), { recursive: true })
  mkdirSync(join(root, 'manifest', 'framework', 'actors'), { recursive: true })
  mkdirSync(join(root, 'empty-local'), { recursive: true })

  return {
    root,
    writeActor(name, opts = {}) {
      const layer = opts.layer ?? 'custom'
      const agent = opts.agent ?? 'claude'
      const content = `---\nname: ${name}\ntype: machine\nrole: test\nagent: ${agent}\n---\n\nTest ${name}\n`
      writeFileSync(join(root, 'manifest', layer, 'actors', `${name}.md`), content)
    },
  }
}

describe('resolveTargets — single-operator mode', () => {
  it('all → every actor', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    t.writeActor('bob')
    const reg = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.equal(resolveTargets(reg, 'all').length, 2)
  })

  it('bare name → singleton (v1.2 back-compat)', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    t.writeActor('bob')
    const reg = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].address, 'alice')
  })

  it('unknown bare name → empty', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.equal(resolveTargets(reg, 'mallory').length, 0)
  })
})

describe('resolveTargets — multi-operator mode', () => {
  it('qualified address → exact actor', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    t.writeActor('bob')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice@steve')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].address, 'alice@steve')
  })

  it('cross-operator address → empty (different daemon owns it)', async () => {
    // This daemon is operator=steve. A message addressed to alice@bob
    // must NOT resolve here — bob's daemon is responsible. Cross-operator
    // routing falls out of registry partitioning: each daemon's registry
    // only contains its own operator's actors.
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.equal(resolveTargets(reg, 'alice@bob').length, 0)
  })

  it('pool address (no instance) → all instances of the pool', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })
    t.writeActor('dart-thrower-3', { agent: 'opencode' })
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'dart-thrower@steve')
    assert.equal(targets.length, 3)
    assert.deepEqual(targets.map(a => a.instance).sort((a, b) => a! - b!), [1, 2, 3])
  })

  it('specific pool instance → one actor', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'dart-thrower-2@steve')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].instance, 2)
  })

  it('all → every actor on this daemon (does NOT cross operators)', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    t.writeActor('bob')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'all')
    assert.equal(targets.length, 2)
    // Every target should belong to this daemon's operator
    for (const a of targets) assert.equal(a.operator, 'steve')
  })
})

describe('resolveTargets — CSV multi-target', () => {
  it('comma-separated addresses → union, deduplicated', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    t.writeActor('bob')
    t.writeActor('carol')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice@steve, bob@steve, carol@steve')
    assert.equal(targets.length, 3)
    assert.deepEqual(
      targets.map(a => a.address).sort(),
      ['alice@steve', 'bob@steve', 'carol@steve'],
    )
  })

  it('dedupes when the same actor is named twice', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice@steve, alice@steve')
    assert.equal(targets.length, 1)
  })

  it('dedupes when a pool address overlaps a specific instance', async () => {
    const t = freshTransport()
    t.writeActor('dart-thrower-1', { agent: 'opencode' })
    t.writeActor('dart-thrower-2', { agent: 'opencode' })
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    // pool@steve expands to {1, 2}; -1@steve is already in that set
    const targets = resolveTargets(reg, 'dart-thrower@steve, dart-thrower-1@steve')
    assert.equal(targets.length, 2)
  })

  it('mixes hits + misses cleanly (cross-op address dropped)', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice@steve, alice@bob, mallory@steve')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].address, 'alice@steve')
  })
})

describe('resolveTargets — robustness', () => {
  it('malformed addresses → empty (no throw)', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.equal(resolveTargets(reg, '@nope').length, 0)
    assert.equal(resolveTargets(reg, 'UPPER').length, 0)
    assert.equal(resolveTargets(reg, '').length, 0)
  })

  it('empty CSV fragments are skipped', async () => {
    const t = freshTransport()
    t.writeActor('alice')
    const reg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    const targets = resolveTargets(reg, 'alice@steve,,,')
    assert.equal(targets.length, 1)
  })
})
