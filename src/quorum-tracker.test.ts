import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { QuorumTracker, buildQuorumReachedMessage } from './quorum-tracker.js'

describe('QuorumTracker — register', () => {
  it('register on a fresh key creates state', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    assert.equal(t.size(), 1)
  })

  it('re-register on the same key is a no-op (idempotent)', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    t.register('ch1', 'rel1', 'alice@steve', 99, 99) // ignored — first registration sticks
    assert.equal(t.size(), 1)
    // Verify the K from first registration is what gets used
    const v1 = t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    assert.equal(v1.action, 'recorded')
    const v2 = t.recordResponse('ch1', 'rel1', 'alice-2@steve')
    assert.equal(v2.action, 'reached', 'K=2 from first registration, not K=99 from second')
  })

  it('different keys are independent', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    t.register('ch1', 'rel2', 'bob@steve', 1, 2)
    t.register('ch2', 'rel1', 'alice@bob', 3, 5)
    assert.equal(t.size(), 3)
  })
})

describe('QuorumTracker — recordResponse', () => {
  it('returns no-state for an unregistered key', () => {
    const t = new QuorumTracker()
    const v = t.recordResponse('ch1', 'rel-never-registered', 'alice-1@steve')
    assert.equal(v.action, 'no-state')
  })

  it('counts distinct responders up to K, then reports reached', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    const v1 = t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    assert.equal(v1.action, 'recorded')
    const v2 = t.recordResponse('ch1', 'rel1', 'alice-2@steve')
    assert.equal(v2.action, 'reached')
    if (v2.action === 'reached') {
      assert.equal(v2.state.responders.size, 2)
      assert.equal(v2.state.k, 2)
      assert.equal(v2.state.n, 3)
      assert.equal(v2.state.poolAddress, 'alice@steve')
    }
  })

  it('dedup — same responder twice counts as one', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    const v = t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    assert.equal(v.action, 'recorded', 'duplicate responder must not trigger reached')
  })

  it('already-reached on subsequent responses past threshold', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    const reached = t.recordResponse('ch1', 'rel1', 'alice-2@steve')
    assert.equal(reached.action, 'reached')
    // Third responder arrives after threshold
    const after = t.recordResponse('ch1', 'rel1', 'alice-3@steve')
    assert.equal(after.action, 'already-reached')
  })

  it('all-responded when K > N (misconfig) and N respondents arrive', () => {
    const t = new QuorumTracker()
    // K=5 but pool only has 3 — operator error, will never reach K
    t.register('ch1', 'rel1', 'alice@steve', 5, 3)
    t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    t.recordResponse('ch1', 'rel1', 'alice-2@steve')
    const last = t.recordResponse('ch1', 'rel1', 'alice-3@steve')
    assert.equal(last.action, 'all-responded')
  })
})

describe('QuorumTracker — close', () => {
  it('removes the entry', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    assert.equal(t.size(), 1)
    t.close('ch1', 'rel1')
    assert.equal(t.size(), 0)
    // Subsequent record is no-state
    const v = t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    assert.equal(v.action, 'no-state')
  })

  it('close on unknown key is a no-op', () => {
    const t = new QuorumTracker()
    t.close('ch1', 'rel-never-existed')
    assert.equal(t.size(), 0)
  })
})

describe('QuorumTracker — TTL + sweep (v1.9.0-alpha.2)', () => {
  it('entries older than TTL get swept', () => {
    // 1ms TTL so we can advance Date.now() trivially
    const t = new QuorumTracker({ ttlMs: 1, autoStart: false })
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    t.register('ch1', 'rel2', 'bob@steve', 1, 2)
    assert.equal(t.size(), 2)
    // Pretend 1 hour passed
    const swept = t.sweepExpired(Date.now() + 60 * 60 * 1000)
    assert.equal(swept, 2)
    assert.equal(t.size(), 0)
  })

  it('entries within TTL are preserved', () => {
    const t = new QuorumTracker({ ttlMs: 10 * 60 * 1000, autoStart: false })
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    // Pretend 1 second passed — well within 10 minutes
    const swept = t.sweepExpired(Date.now() + 1000)
    assert.equal(swept, 0)
    assert.equal(t.size(), 1)
  })

  it('sweepExpired is a no-op on empty tracker', () => {
    const t = new QuorumTracker({ autoStart: false })
    assert.equal(t.sweepExpired(), 0)
  })

  it('startSweep is idempotent', () => {
    const t = new QuorumTracker({ ttlMs: 1, sweepIntervalMs: 100, autoStart: false })
    t.startSweep()
    t.startSweep()  // should not double-register interval
    t.stopSweep()
    // No assertion crash = pass
  })

  it('stopSweep is safe when never started', () => {
    const t = new QuorumTracker({ autoStart: false })
    t.stopSweep()
    // No crash = pass
  })

  it('default TTL is 10 minutes', () => {
    const t = new QuorumTracker({ autoStart: false })
    t.register('ch1', 'rel1', 'alice@steve', 2, 3)
    // 9 minutes — still alive
    assert.equal(t.sweepExpired(Date.now() + 9 * 60 * 1000), 0)
    // 11 minutes — swept
    assert.equal(t.sweepExpired(Date.now() + 11 * 60 * 1000), 1)
  })
})

describe('buildQuorumReachedMessage', () => {
  it('emits well-formed pool-quorum-reached frontmatter + body', () => {
    const t = new QuorumTracker()
    t.register('ch1', '2026/05/18/100000000Z-abc12345.md', 'alice@steve', 2, 3)
    t.recordResponse('ch1', '2026/05/18/100000000Z-abc12345.md', 'alice-1@steve')
    const v = t.recordResponse('ch1', '2026/05/18/100000000Z-abc12345.md', 'alice-2@steve')
    if (v.action !== 'reached') throw new Error('expected reached')

    const msg = buildQuorumReachedMessage(v.state, 'watcher')
    assert.ok(msg.includes('type: pool-quorum-reached'))
    assert.ok(msg.includes('from: watcher'))
    assert.ok(msg.includes('in-reply-to: 2026/05/18/100000000Z-abc12345.md'))
    assert.ok(msg.includes('pool-address: alice@steve'))
    assert.ok(msg.includes('quorum-required: 2'))
    assert.ok(msg.includes('responses-received: 2'))
    assert.ok(msg.includes('pool-size: 3'))
    assert.ok(msg.includes('responders: alice-1@steve, alice-2@steve'))
    // Frontmatter delimiters
    assert.ok(msg.startsWith('---\n'))
    assert.ok(msg.includes('\n---\n\n'))
  })

  it('responders list is sorted', () => {
    const t = new QuorumTracker()
    t.register('ch1', 'rel1', 'alice@steve', 3, 3)
    // Record out of order
    t.recordResponse('ch1', 'rel1', 'alice-3@steve')
    t.recordResponse('ch1', 'rel1', 'alice-1@steve')
    const v = t.recordResponse('ch1', 'rel1', 'alice-2@steve')
    if (v.action !== 'reached') throw new Error('expected reached')
    const msg = buildQuorumReachedMessage(v.state, 'watcher')
    assert.ok(msg.includes('responders: alice-1@steve, alice-2@steve, alice-3@steve'),
      'responders should sort alphabetically for deterministic output')
  })
})
