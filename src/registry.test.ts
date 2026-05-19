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
  writeActor: (name: string, opts?: { agent?: string; command?: string; layer?: 'custom' | 'framework' | { operator: string } }) => void
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
      let dir: string
      if (typeof layer === 'object') {
        // v1.4.0-alpha.1+ operator-scoped layer
        dir = join(root, 'manifest', 'operators', layer.operator, 'actors')
        mkdirSync(dir, { recursive: true })
      } else {
        dir = join(root, 'manifest', layer, 'actors')
      }
      writeFileSync(join(dir, `${name}.md`), content)
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

describe('loadRegistry — frontmatter name authoritative (v1.11.0-alpha.1+)', () => {
  it('UPPERCASE filename + frontmatter name → actor loads under frontmatter name', async () => {
    // The exact Mac UAT case: filename violates kebab grammar but
    // frontmatter `name:` is valid. Pre-v1.11 this was silently skipped;
    // post-v1.11 the frontmatter name wins, filename is cosmetic.
    const root = mkdtempSync(join(tmpdir(), 'crosstalk-reg-frontmatter-'))
    mkdirSync(join(root, 'manifest', 'custom', 'actors'), { recursive: true })
    mkdirSync(join(root, 'empty-local'), { recursive: true })
    const content = `---
name: alice-1
type: machine
role: test
agent: claude
---

Test
`
    writeFileSync(join(root, 'manifest', 'custom', 'actors', 'ALICE-1.md'), content)
    const registry = await loadRegistry(root, undefined, root + '/empty-local')
    assert.ok(registry.has('alice-1'), 'frontmatter name should win over UPPERCASE filename')
    assert.equal(registry.get('alice-1')!.name, 'alice-1')
  })

  it('frontmatter name takes precedence over filename when they disagree', async () => {
    const t = freshTransport()
    const content = `---
name: alice
type: machine
role: test
agent: claude
---

Body
`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'something-else.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.ok(registry.has('alice'), 'frontmatter name="alice" should win over filename "something-else"')
    assert.equal(registry.has('something-else'), false, 'filename should NOT be the registry key when frontmatter overrides')
  })

  it('no frontmatter name → filename is fallback (v1.10 back-compat)', async () => {
    const t = freshTransport()
    // Don't include `name:` field
    const content = `---
type: machine
role: test
agent: claude
---

Body
`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'fallback-name.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.ok(registry.has('fallback-name'))
  })

  it('invalid frontmatter name (UPPERCASE) → skipped with error (no silent fallback to filename)', async () => {
    const t = freshTransport()
    const content = `---
name: ALICE-1
type: machine
role: test
agent: claude
---
`
    // Filename is valid; frontmatter is not. Frontmatter is authoritative
    // when present — invalid frontmatter rejects rather than silently
    // demoting to filename (otherwise operators who typo'd would see
    // unexpected actor names appear).
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'alice-1.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.equal(registry.has('alice-1'), false, 'invalid frontmatter name should NOT silent-demote to filename')
    assert.equal(registry.has('ALICE-1'), false, 'invalid frontmatter name should also not be registered')
  })

  it('multi-op: UPPERCASE filename + frontmatter name → qualified canonical address', async () => {
    const t = freshTransport()
    const content = `---
name: dart-thrower-7
type: machine
role: test
agent: opencode
---
`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'DART-THROWER-07.md'), content)
    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.ok(registry.has('dart-thrower-7@steve'), 'frontmatter name canonicalises to dart-thrower-7@steve')
    assert.equal(registry.get('dart-thrower-7@steve')!.role, 'dart-thrower')
    assert.equal(registry.get('dart-thrower-7@steve')!.instance, 7)
  })

  it('empty frontmatter name (just whitespace) → filename fallback', async () => {
    const t = freshTransport()
    const content = `---
name: "  "
type: machine
role: test
agent: claude
---
`
    writeFileSync(join(t.root, 'manifest', 'custom', 'actors', 'fall-back.md'), content)
    const registry = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.ok(registry.has('fall-back'))
  })
})

describe('loadRegistry — operator-scoped layer (v1.4.0-alpha.1+)', () => {
  it('operator-scoped profiles load when operator handle matches', async () => {
    const t = freshTransport()
    t.writeActor('only-on-steve', { agent: 'claude', layer: { operator: 'steve' } })
    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.ok(registry.has('only-on-steve@steve'), 'steve should see operator-scoped profile')
  })

  it('operator-scoped profiles are INVISIBLE to a different operator', async () => {
    const t = freshTransport()
    // steve stages a profile under his operator scope; bob's daemon should not see it
    t.writeActor('steve-secret', { agent: 'claude', layer: { operator: 'steve' } })
    const registry = await loadRegistry(t.root, 'bob', t.root + '/empty-local')
    assert.equal(registry.has('steve-secret@bob'), false,
      'bob must not register steve-scoped profile under his own handle')
    assert.equal(registry.size, 0, 'bob sees an empty registry, not a leak from steve')
  })

  it('operator-scoped layer is skipped entirely in single-op mode', async () => {
    const t = freshTransport()
    t.writeActor('legacy', { agent: 'claude', layer: { operator: 'steve' } })
    const registry = await loadRegistry(t.root, undefined, t.root + '/empty-local')
    assert.equal(registry.size, 0,
      'single-op mode has no operator handle, so the scoped layer never loads')
  })

  it('operator-scoped layer overrides custom on the same name', async () => {
    const t = freshTransport()
    t.writeActor('alice', { agent: 'custom-agent', layer: 'custom' })
    t.writeActor('alice', { agent: 'op-scoped-agent', layer: { operator: 'steve' } })
    const registry = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.equal(registry.get('alice@steve')!.agent, 'op-scoped-agent',
      'operator-scoped layer is between custom and local; should win over custom')
  })

  it('coexists with shared custom — steve sees both shared + own scoped', async () => {
    const t = freshTransport()
    t.writeActor('shared', { agent: 'claude', layer: 'custom' })
    t.writeActor('only-steve', { agent: 'claude', layer: { operator: 'steve' } })
    t.writeActor('only-bob',   { agent: 'claude', layer: { operator: 'bob' } })

    const steveReg = await loadRegistry(t.root, 'steve', t.root + '/empty-local')
    assert.ok(steveReg.has('shared@steve'),     'steve sees shared profile qualified to @steve')
    assert.ok(steveReg.has('only-steve@steve'), 'steve sees own scoped profile')
    assert.equal(steveReg.has('only-bob@steve'),  false, 'steve must not see bob-scoped profile')
    assert.equal(steveReg.has('only-bob@bob'),    false, 'steve must not see bob qualified at all')
    assert.equal(steveReg.size, 2)

    const bobReg = await loadRegistry(t.root, 'bob', t.root + '/empty-local')
    assert.ok(bobReg.has('shared@bob'),       'bob also sees shared profile qualified to @bob')
    assert.ok(bobReg.has('only-bob@bob'),     'bob sees own scoped profile')
    assert.equal(bobReg.has('only-steve@bob'),  false, 'bob must not see steve-scoped profile')
    assert.equal(bobReg.size, 2)
  })
})
