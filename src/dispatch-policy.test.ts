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
// To avoid clobbering the user's real cursor state, point HOME at a
// per-suite tmpdir before importing/exercising any cursor-touching code.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'crosstalk-disp-pol-test-'))
mkdirSync(join(TMP_HOME, '.crosstalk'), { recursive: true })
process.env.HOME = TMP_HOME

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
  })
  it('returns null on unknown values so caller can surface the typo', () => {
    assert.equal(parseDispatchPolicy('roundrobin'), null)
    assert.equal(parseDispatchPolicy('first-of-n'), null)
    assert.equal(parseDispatchPolicy('whatever'), null)
  })
})

describe('applyDispatchPolicy — fanout', () => {
  it('passes targets through unchanged', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const out = await applyDispatchPolicy(targets, 'fanout', 'sess', 'ch1', 'alice@steve')
    assert.equal(out.length, 3)
    assert.deepEqual(out.map(a => a.address), ['alice-1', 'alice-2', 'alice-3'])
  })

  it('no-op on empty + single-target lists', async () => {
    assert.deepEqual(await applyDispatchPolicy([], 'fanout', 's', 'c', 'addr'), [])
    const one = [actor('solo')]
    assert.deepEqual(await applyDispatchPolicy(one, 'fanout', 's', 'c', 'addr'), one)
  })
})

describe('applyDispatchPolicy — round-robin', () => {
  it('picks one instance per call, rotating', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3)]
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      const out = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-1', 'ch-rr-1', 'alice@steve')
      assert.equal(out.length, 1, 'round-robin should pick a single instance')
      picks.push(out[0].address)
    }
    // First six picks rotate through pool twice
    assert.deepEqual(picks, ['alice-1', 'alice-2', 'alice-3', 'alice-1', 'alice-2', 'alice-3'])
  })

  it('cursor is per-(channel, pool) — different channels rotate independently', async () => {
    const targets = [actor('alice-1', 1), actor('alice-2', 2)]
    // Channel A: pick once → alice-1
    const a1 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chA', 'alice@steve')
    // Channel B fresh: also picks alice-1 (independent cursor)
    const b1 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chB', 'alice@steve')
    assert.equal(a1[0].address, 'alice-1')
    assert.equal(b1[0].address, 'alice-1')
    // Channel A again: alice-2
    const a2 = await applyDispatchPolicy(targets, 'round-robin', 'sess-rr-2', 'chA', 'alice@steve')
    assert.equal(a2[0].address, 'alice-2')
  })

  it('different pool addresses on same channel rotate independently', async () => {
    const aliceTargets = [actor('alice-1', 1), actor('alice-2', 2)]
    const bobTargets = [actor('bob-1', 1), actor('bob-2', 2)]
    // alice@steve picks alice-1
    const a = await applyDispatchPolicy(aliceTargets, 'round-robin', 'sess-rr-3', 'ch', 'alice@steve')
    // bob@steve also picks bob-1 (independent cursor)
    const b = await applyDispatchPolicy(bobTargets, 'round-robin', 'sess-rr-3', 'ch', 'bob@steve')
    assert.equal(a[0].address, 'alice-1')
    assert.equal(b[0].address, 'bob-1')
  })

  it('handles pool shrinkage gracefully via modulo', async () => {
    const big = [actor('alice-1', 1), actor('alice-2', 2), actor('alice-3', 3), actor('alice-4', 4)]
    // Burn three picks against the big pool — cursor is now 3
    for (let i = 0; i < 3; i++) {
      await applyDispatchPolicy(big, 'round-robin', 'sess-rr-4', 'ch', 'alice@steve')
    }
    // Now shrink to 2 instances — cursor=3, 3 % 2 = 1, should pick instance index 1
    const shrunk = [actor('alice-1', 1), actor('alice-2', 2)]
    const pick = await applyDispatchPolicy(shrunk, 'round-robin', 'sess-rr-4', 'ch', 'alice@steve')
    assert.equal(pick[0].address, 'alice-2')
  })

  it('no-op on empty + single-target (nothing to rotate)', async () => {
    assert.deepEqual(await applyDispatchPolicy([], 'round-robin', 'sess-rr-5', 'c', 'addr'), [])
    const one = [actor('solo')]
    assert.deepEqual(await applyDispatchPolicy(one, 'round-robin', 'sess-rr-5', 'c', 'addr'), one)
  })
})
