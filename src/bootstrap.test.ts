import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shouldRunBootstrapPass } from './bootstrap.js'
import type { Registry } from './registry.js'

// shouldRunBootstrapPass uses listAllActorProfiles, which reads from
// real disk under <transportRoot>/manifest/... + ~/.crosstalk/actors/.
// For these tests we use a fresh empty tmpdir so listAllActorProfiles
// returns an empty map; the v1.4.0-alpha.2+ designated-coordinator
// branch resolves BEFORE the all-actors lookup runs, so an empty tree
// is fine for testing it. The pre-existing fallback (ROE field,
// first-by-joined-at) tests would need profile fixtures — not added
// here.
function emptyTransport(): string {
  return mkdtempSync(join(tmpdir(), 'crosstalk-bootstrap-test-'))
}

const emptyRegistry: Registry = new Map()

describe('shouldRunBootstrapPass — designated coordinator (v1.4.0-alpha.2+)', () => {
  describe('machine address (alice@steve)', () => {
    it('this daemon coordinates when its operator handle matches', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'steve', 'alice@steve', undefined)
      assert.equal(decision.should, true)
      assert.equal(decision.coordinatorActor, 'alice@steve')
      assert.match(decision.reason, /config bootstrap.coordinator-address/)
    })

    it('this daemon does NOT coordinate when operator does not match', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'bob', 'alice@steve', undefined)
      assert.equal(decision.should, false)
      assert.match(decision.reason, /does not match/)
    })

    it('operator unset → does not match a machine address', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, undefined, 'alice@steve', undefined)
      assert.equal(decision.should, false)
    })
  })

  describe('human address (bare name)', () => {
    it('coordinates when default-human-actor matches', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'steve', 'steve', 'steve')
      assert.equal(decision.should, true)
      assert.equal(decision.coordinatorActor, 'steve')
      assert.match(decision.reason, /human 'steve'/)
    })

    it('does NOT coordinate when default-human-actor differs', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'bob', 'steve', 'bob')
      assert.equal(decision.should, false)
      assert.match(decision.reason, /does not match/)
    })

    it('does NOT coordinate when default-human-actor unset', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'steve', 'steve', undefined)
      assert.equal(decision.should, false)
    })
  })

  describe('invalid address', () => {
    it('rejects malformed coordinator-address with explanation', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'steve', 'UPPER@steve', undefined)
      assert.equal(decision.should, false)
      assert.match(decision.reason, /malformed/)
    })

  })

  describe('precedence — designated wins over fallback', () => {
    it('takes precedence even if the all-actors set is empty (no profiles needed)', () => {
      const root = emptyTransport()
      const decision = shouldRunBootstrapPass(root, emptyRegistry, 'steve', 'alice@steve', undefined)
      // No profiles on disk, but designated coordinator still fires.
      assert.equal(decision.should, true)
      assert.equal(decision.coordinatorActor, 'alice@steve')
    })
  })
})
