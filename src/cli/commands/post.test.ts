import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { validateTarget } from './post.js'
import type { ActorEntry } from '../lib/actors.js'

// Minimal ActorEntry factory — only the fields validateTarget reads.
function entry(name: string, type: 'human' | 'machine' = 'machine'): ActorEntry {
  return {
    name,
    layer: 'custom',
    file: `/fake/${name}.md`,
    validKebabName: true,
    data: { name, type },
  }
}

describe('validateTarget — single-operator mode (back-compat)', () => {
  it('accepts a bare machine name that exists', () => {
    const r = validateTarget('alice', [entry('alice', 'machine')], undefined)
    assert.equal(r.ok, true)
  })

  it('accepts a bare human name that exists', () => {
    const r = validateTarget('steve', [entry('steve', 'human')], undefined)
    assert.equal(r.ok, true)
  })

  it('rejects an unknown bare name', () => {
    const r = validateTarget('mallory', [entry('alice')], undefined)
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'unknown')
  })
})

describe('validateTarget — multi-operator mode (operator = steve)', () => {
  it('accepts a local qualified address (alice@steve, alice profile exists)', () => {
    const r = validateTarget('alice@steve', [entry('alice')], 'steve')
    assert.equal(r.ok, true)
  })

  it('rejects a local qualified address with no matching profile (alice@steve, no alice)', () => {
    const r = validateTarget('alice@steve', [entry('bob')], 'steve')
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'unknown')
  })

  it('accepts a cross-operator address WITHOUT validating it (alice@bob from steve)', () => {
    // We have no view of bob's registry, so we trust the user — bob's
    // daemon will validate/process the message when it lands on the transport.
    const r = validateTarget('alice@bob', [], 'steve')
    assert.equal(r.ok, true)
  })

  it('accepts a bare human (humans are always bare even in multi-op)', () => {
    const r = validateTarget('steve', [entry('steve', 'human')], 'steve')
    assert.equal(r.ok, true)
  })

  it('rejects a bare machine name in multi-op (machines must be qualified)', () => {
    const r = validateTarget('alice', [entry('alice', 'machine')], 'steve')
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'unknown')
  })

  it('accepts a pool address when at least one instance exists', () => {
    const profiles = [entry('dart-thrower-1'), entry('dart-thrower-2'), entry('dart-thrower-3')]
    const r = validateTarget('dart-thrower@steve', profiles, 'steve')
    assert.equal(r.ok, true)
  })

  it('rejects a pool address when no instances exist', () => {
    const r = validateTarget('dart-thrower@steve', [entry('alice')], 'steve')
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'unknown')
  })

  it('accepts a specific pool instance when it exists', () => {
    const profiles = [entry('dart-thrower-1'), entry('dart-thrower-2')]
    const r = validateTarget('dart-thrower-2@steve', profiles, 'steve')
    assert.equal(r.ok, true)
  })

  it('rejects a specific pool instance that does not exist', () => {
    const profiles = [entry('dart-thrower-1')]
    const r = validateTarget('dart-thrower-99@steve', profiles, 'steve')
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'unknown')
  })
})

describe('validateTarget — invalid grammar', () => {
  it('flags malformed addresses with kind=invalid', () => {
    const r = validateTarget('@nope', [], undefined)
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'invalid')
  })

  it('flags upper-case names', () => {
    const r = validateTarget('Alice', [], undefined)
    assert.equal(r.ok, false)
    if (r.ok === false) assert.equal(r.kind, 'invalid')
  })
})
