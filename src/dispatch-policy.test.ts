import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDispatchPolicy,
  applyDispatchPolicy,
} from './dispatch-policy.js'
import type { ActorConfig } from './registry.js'

// applyDispatchPolicy persists round-robin cursors under ~/.crosstalk/.
// `os.homedir()` snapshots at process start and ignores runtime HOME
// changes, so we pass an explicit `stateRoot` override to every call
// that touches the cursor (parameter added v1.5.0-alpha.2 specifically
// for this isolation). Each test creates its own tmp state root.
const STATE_ROOT = mkdtempSync(join(tmpdir(), 'crosstalk-disp-pol-test-'))
mkdirSync(STATE_ROOT, { recursive: true })

function actor(name: string, instance?: number): ActorConfig {
  return {
    name,
    role: name.replace(/-\d+$/, ''),
    instance,
    address: name,
    args: [],
  }
}

describe('parseDispatchPolicy', () => {
  it('absent input defaults to fanout', () => {
    assert.equal(parseDispatchPolicy(undefined), 'fanout')
    assert.equal(parseDispatchPolicy(''), 'fanout')
  })
  it('accepts the known values, case-insensitive, trimmed', () => {
    assert.equal(parseDispatchPolicy('fanout'), 'fanout')
    assert.equal(parseDispatchPolicy('  FANOUT  '), 'fanout')
    assert.equal(parseDispatchPolicy('round-robin'), 'round-robin')
    assert.equal(parseDispatchPolicy('Round-Robin'), 'round-robin')
    // v1.5.0-alpha.2 additions
    assert.equal(parseDispatchPolicy('random'), 'random')
    assert.equal(parseDispatchPolicy('  RANDOM '), 'random')
    assert.equal(parseDispatchPolicy('broadcast-with-quorum'), 'broadcast-with-quorum')
    assert.equal(parseDispatchPolicy('Broadcast-With-Quorum'), 'broadcast-with-quorum')
  })
  it('returns null on unknown values so caller can surface the typo', () => {
    assert.equal(parseDispatchPolicy('roundrobin'), null)
    assert.equal(parseDispatchPolicy('first-of-n'), null)
    assert.equal(parseDispatchPolicy('whatever'), null)
    assert.equal(parseDispatchPolicy('quorum'), null)        // common shorthand operators might try
    assert.equal(parseDispatchPolicy('rand'), null)
  })
})

describe('applyDispatchPolicy — fanout', () => {
  it('passes targets through unchanged', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const out = await applyDispatchPolicy(targets, 'fanout', 'sess', 'ch1', 'alice@steve', STATE_ROOT)
    assert.equal(out.length, 3)
    assert.deepEqual(out.map(a => a.address), ['alice-1', 'alice-2', 'alice-3'])
  })

  it('no-op on empty + single-target lists', async () => {
    assert.deepEqual(await applyDispatchPolicy([], 'fanout', 's', 'c', 'addr', STATE_ROOT), [])
    const one = [actor('solo')]
    assert.deepEqual(await applyDispatchPolicy(one, 'fanout', 's', 'c', 'addr', STATE_ROOT), one)
  })
})

describe('applyDispatchPolicy — round-robin', () => {
  it('picks one instance per call, rotating', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      const out = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-1', 'ch-rr-1', 'alice@steve', STATE_ROOT)
      assert.equal(out.length, 1, 'round-robin should pick a single instance')
      picks.push(out[0].address)
    }
    // First six picks rotate through pool twice
    assert.deepEqual(picks, ['alice-1', 'alice-2', 'alice-3', 'alice-1', 'alice-2', 'alice-3'])
  })

  it('cursor is per-(channel, pool) — different channels rotate independently', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2)]
    // Channel A: pick once → alice-1
    const a1 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chA', 'alice@steve', STATE_ROOT)
    // Channel B fresh: also picks alice-1 (independent cursor)
    const b1 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chB', 'alice@steve', STATE_ROOT)
    assert.equal(a1[0].address, 'alice-1')
    assert.equal(b1[0].address, 'alice-1')
    // Channel A again: alice-2
    const a2 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chA', 'alice@steve', STATE_ROOT)
    assert.equal(a2[0].address, 'alice-2')
  })

  it('different pool addresses on same channel rotate independently', async () => {
    const aliceTargets = [actor('alice-1', 1), actor('alice-2', 2)]
    const bobTargets = [actor('bob-1', 1), actor('bob-2', 2)]
    // alice@steve picks alice-1
    const a = await applyDispatchPolicy(aliceTargets, 'round-robin', 'sess-rr-3', 'ch', 'alice@steve', STATE_ROOT)
    // bob@steve also picks bob-1 (independent cursor)
    const b = await applyDispatchPolicy(bobTargets, 'round-robin', 'sess-rr-3', 'ch', 'bob@steve', STATE_ROOT)
    assert.equal(a[0].address, 'alice-1')
    assert.equal(b[0].address, 'bob-1')
  })

  it('handles pool shrinkage gracefully via modulo', async () => {
    const big = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3), actor('alice-4', 4)]
    // Burn three picks against the big pool — cursor is now 3
    for (let i = 0; i < 3; i++) {
      await applyDispatchPolicy(big, 'round-robin', 'sess-rr-4', 'ch', 'alice@steve', STATE_ROOT)
    }
    // Now shrink to 2 instances — cursor=3, 3 % 2 = 1, should pick instance index 1
    const shrunk = [actor('alice-1', 1), actor('alice-2', 2)]
    const pick = await applyDispatchPolicy(shrunk, 'round-robin', 'sess-rr-4', 'ch', 'alice@steve', STATE_ROOT)
    assert.equal(pick[0].address, 'alice-2')
  })

  it('no-op on empty + single-target (nothing to rotate)', async () => {
    assert.deepEqual(await applyDispatchPolicy([], 'round-robin', 'sess-rr-5', 'c', 'addr', STATE_ROOT), [])
    const one = [actor('solo')]
    assert.deepEqual(await applyDispatchPolicy(one, 'round-robin', 'sess-rr-5', 'c', 'addr', STATE_ROOT), one)
  })
})

describe('applyDispatchPolicy — random (v1.5.0-alpha.2)', () => {
  it('returns exactly one instance from the pool', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    for (let i = 0; i < 10; i++) {
      const out = await applyDispatchPolicy(targets, 'random', 'sess-rnd', 'ch', 'alice@steve', STATE_ROOT)
      assert.equal(out.length, 1, 'random should pick a single instance')
      assert.ok(targets.some(t => t.address === out[0].address),
        `pick (${out[0].address}) must be one of the pool members`)
    }
  })

  it('coverage — across many picks all pool members get chosen', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const seen = new Set<string>()
    // 60 trials over 3 instances → probability of missing any member is
    // 3 * (2/3)^60 ≈ 7e-11; flaky-test risk is negligible.
    for (let i = 0; i < 60; i++) {
      const out = await applyDispatchPolicy(targets, 'random', 'sess-rnd-cov', 'ch', 'alice@steve', STATE_ROOT)
      seen.add(out[0].address)
    }
    assert.equal(seen.size, 3, 'all three pool members should be picked at least once over 60 trials')
  })

  it('no-op on empty + single-target', async () => {
    assert.deepEqual(await applyDispatchPolicy([], 'random', 's', 'c', 'addr', STATE_ROOT), [])
    const one = [actor('solo')]
    assert.deepEqual(await applyDispatchPolicy(one, 'random', 's', 'c', 'addr', STATE_ROOT), one)
  })
})

describe('applyDispatchPolicy — broadcast-with-quorum (v1.5.0-alpha.2)', () => {
  it('dispatches as fanout (every pool member) — quorum tracker is v1.6 follow-up', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const out = await applyDispatchPolicy(targets, 'broadcast-with-quorum', 'sess-q', 'ch', 'alice@steve', STATE_ROOT)
    assert.equal(out.length, 3)
    assert.deepEqual(out.map(a => a.address), ['alice-1', 'alice-2', 'alice-3'])
  })
})
