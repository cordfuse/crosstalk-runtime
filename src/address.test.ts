import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseAddress, formatAddress, isAddressError, validateBareRoleName } from './address.js'

describe('parseAddress — human form (bare name)', () => {
  it('parses a simple human name', () => {
    assert.deepEqual(parseAddress('steve'), { kind: 'human', name: 'steve' })
  })

  it('parses a multi-token kebab-case human name', () => {
    assert.deepEqual(parseAddress('bob-the-builder'), { kind: 'human', name: 'bob-the-builder' })
  })

  it('rejects a bare name ending in -<integer>', () => {
    const r = parseAddress('steve-1')
    assert.ok(isAddressError(r))
    assert.match(r.message, /reserved for pool instances/)
  })

  it('rejects a bare name with invalid characters', () => {
    const r = parseAddress('Steve')
    assert.ok(isAddressError(r))
    assert.match(r.message, /kebab-case/)
  })

  it('rejects empty input', () => {
    const r = parseAddress('')
    assert.ok(isAddressError(r))
    assert.match(r.message, /empty/)
  })

  it('rejects whitespace-only input', () => {
    const r = parseAddress('   ')
    assert.ok(isAddressError(r))
  })
})

describe('parseAddress — machine form (role@operator)', () => {
  it('parses simple role@operator', () => {
    assert.deepEqual(parseAddress('alice@steve'), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
    })
  })

  it('parses kebab-case role', () => {
    assert.deepEqual(parseAddress('code-reviewer@steve'), {
      kind: 'machine',
      role: 'code-reviewer',
      operator: 'steve',
    })
  })

  it('parses kebab-case operator', () => {
    assert.deepEqual(parseAddress('alice@team-platform'), {
      kind: 'machine',
      role: 'alice',
      operator: 'team-platform',
    })
  })

  it('rejects empty role before @', () => {
    const r = parseAddress('@steve')
    assert.ok(isAddressError(r))
    assert.match(r.message, /missing role/)
  })

  it('rejects empty operator after @', () => {
    const r = parseAddress('alice@')
    assert.ok(isAddressError(r))
    assert.match(r.message, /missing operator/)
  })

  it('rejects multiple @ characters', () => {
    const r = parseAddress('alice@steve@cordfuse')
    assert.ok(isAddressError(r))
    assert.match(r.message, /multiple "@"/)
  })

  it('rejects invalid operator handle', () => {
    const r = parseAddress('alice@Steve')
    assert.ok(isAddressError(r))
    assert.match(r.message, /invalid operator/)
  })
})

describe('parseAddress — instance index (role-N@operator)', () => {
  it('parses instance with index', () => {
    assert.deepEqual(parseAddress('alice-7@steve'), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
      instance: { kind: 'index', n: 7 },
    })
  })

  it('parses instance with index on kebab-case role', () => {
    assert.deepEqual(parseAddress('dart-thrower-1@bob'), {
      kind: 'machine',
      role: 'dart-thrower',
      operator: 'bob',
      instance: { kind: 'index', n: 1 },
    })
  })

  it('parses larger instance indices', () => {
    assert.deepEqual(parseAddress('dart-thrower-20@steve'), {
      kind: 'machine',
      role: 'dart-thrower',
      operator: 'steve',
      instance: { kind: 'index', n: 20 },
    })
  })

  it('parses three-digit indices (post 999 instances)', () => {
    assert.deepEqual(parseAddress('alice-1001@steve'), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
      instance: { kind: 'index', n: 1001 },
    })
  })
})

describe('parseAddress — instance tag (role@operator/tag)', () => {
  it('parses tag instance', () => {
    assert.deepEqual(parseAddress('alice@steve/cachy'), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
      instance: { kind: 'tag', tag: 'cachy' },
    })
  })

  it('parses kebab-case tag', () => {
    assert.deepEqual(parseAddress('alice@steve/gpu-host'), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
      instance: { kind: 'tag', tag: 'gpu-host' },
    })
  })

  it('rejects empty tag', () => {
    const r = parseAddress('alice@steve/')
    assert.ok(isAddressError(r))
    assert.match(r.message, /invalid instance tag/)
  })

  it('rejects invalid tag', () => {
    const r = parseAddress('alice@steve/CACHY')
    assert.ok(isAddressError(r))
    assert.match(r.message, /invalid instance tag/)
  })

  it('rejects combining -N and /tag on same address', () => {
    const r = parseAddress('alice-7@steve/cachy')
    assert.ok(isAddressError(r))
    assert.match(r.message, /cannot combine/)
  })
})

describe('parseAddress — special cases', () => {
  it('treats steve@steve as equivalent to bare steve (human)', () => {
    assert.deepEqual(parseAddress('steve@steve'), { kind: 'human', name: 'steve' })
  })

  it('treats bob@bob as equivalent to bare bob', () => {
    assert.deepEqual(parseAddress('bob@bob'), { kind: 'human', name: 'bob' })
  })

  it('does NOT treat alice@steve as redundant (role ≠ operator)', () => {
    const r = parseAddress('alice@steve')
    assert.ok(!isAddressError(r))
    assert.equal(r.kind, 'machine')
  })

  it('trims whitespace', () => {
    assert.deepEqual(parseAddress('  steve  '), { kind: 'human', name: 'steve' })
    assert.deepEqual(parseAddress('  alice@steve  '), {
      kind: 'machine',
      role: 'alice',
      operator: 'steve',
    })
  })

  it('rejects non-string input gracefully', () => {
    const r = parseAddress(null as unknown as string)
    assert.ok(isAddressError(r))
  })
})

describe('formatAddress — round-trips parseAddress', () => {
  const cases: string[] = [
    'steve',
    'bob-the-builder',
    'alice@steve',
    'code-reviewer@team-platform',
    'alice-7@steve',
    'dart-thrower-20@bob',
    'alice@steve/cachy',
    'alice@steve/gpu-host',
  ]
  for (const input of cases) {
    it(`round-trips "${input}"`, () => {
      const parsed = parseAddress(input)
      assert.ok(!isAddressError(parsed))
      assert.equal(formatAddress(parsed), input)
    })
  }

  it('canonicalises steve@steve to steve', () => {
    const parsed = parseAddress('steve@steve')
    assert.ok(!isAddressError(parsed))
    assert.equal(formatAddress(parsed), 'steve')
  })
})

describe('validateBareRoleName', () => {
  it('accepts valid bare role names', () => {
    assert.equal(validateBareRoleName('alice'), null)
    assert.equal(validateBareRoleName('code-reviewer'), null)
    assert.equal(validateBareRoleName('dart-thrower'), null)
  })

  it('rejects names ending in -<integer>', () => {
    assert.match(validateBareRoleName('alice-1') ?? '', /reserved/)
    assert.match(validateBareRoleName('dart-thrower-7') ?? '', /reserved/)
    assert.match(validateBareRoleName('version-2') ?? '', /reserved/)
  })

  it('rejects invalid characters', () => {
    assert.match(validateBareRoleName('Alice') ?? '', /kebab-case/)
    assert.match(validateBareRoleName('alice_pool') ?? '', /kebab-case/)
  })

  it('rejects empty', () => {
    assert.match(validateBareRoleName('') ?? '', /empty/)
  })
})
