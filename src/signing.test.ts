import { describe, it, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  generateSigningKey,
  loadPrivateSigningKey,
  publishPublicKey,
  loadPublicKey,
  canonicalize,
  signMessage,
  verifyMessage,
  embedSignature,
  signAndEmbed,
} from './signing.js'

// ── Test isolation ──────────────────────────────────────────────────────────
// We need to redirect ~/.crosstalk/keys/ to a per-test-suite tmpdir so we
// don't trample the real keystore. The signing module reads HOME at module
// load time via `homedir()`, so we set HOME before importing — but tests
// run in the same process as the import. Workaround: override HOME via
// env, and the signing module reads it on each call (since homedir() is
// not cached at module load).
//
// Actually, signing.ts reads `homedir()` inside its constants block (top
// of module). That's evaluated ONCE at import. To work around without
// refactoring the module, we set HOME before this file is imported by
// the test runner — which we do by setting it as the FIRST thing in this
// file. But that's too late since the import already happened.
//
// Better: refactor the module to compute LOCAL_KEYS_DIR per-call. Or
// accept that tests have to use the real ~/.crosstalk/keys/ with unique
// addresses (test-prefix scheme) to avoid collisions.
//
// Going with the unique-address scheme — tests use addresses like
// `test-<uuid>` so we never collide with real keys.

import { randomBytes } from 'crypto'
const TEST_PREFIX = `test-${randomBytes(4).toString('hex')}`
const testAddr = (suffix: string) => `${TEST_PREFIX}-${suffix}`

let tempTransport: string

before(() => {
  tempTransport = mkdtempSync(join(tmpdir(), 'crosstalk-signing-test-'))
})

after(() => {
  // Clean up tmpdir
  rmSync(tempTransport, { recursive: true, force: true })
  // Clean up test keys we generated
  const keysDir = join(homedir(), '.crosstalk', 'keys')
  if (existsSync(keysDir)) {
    const { readdirSync, unlinkSync } = require('fs')
    for (const f of readdirSync(keysDir)) {
      if (f.startsWith(TEST_PREFIX)) {
        try { unlinkSync(join(keysDir, f)) } catch {}
      }
    }
  }
})

describe('canonicalize — strips signature line', () => {
  it('removes signature line from frontmatter', () => {
    const input = `---
from: alice@steve
to: all
timestamp: 2026-05-17T22:00:00Z
signature: abc123==
---

Hello world
`
    const output = canonicalize(input)
    assert.equal(output.includes('signature:'), false)
    assert.equal(output.includes('Hello world'), true)
    assert.equal(output.includes('from: alice@steve'), true)
  })

  it('is a no-op when no signature present', () => {
    const input = `---
from: alice@steve
to: all
---

Body content
`
    assert.equal(canonicalize(input), input)
  })

  it('only removes the signature line, not body matches', () => {
    const input = `---
from: alice@steve
signature: real-sig==
---

The word "signature: fake" appears in the body.
`
    const output = canonicalize(input)
    assert.equal(output.includes('signature: real-sig=='), false)
    assert.equal(output.includes('signature: fake'), true)  // body untouched
  })
})

describe('generateSigningKey + loadPrivateSigningKey', () => {
  it('generates a key, returns public PEM, writes private to file', () => {
    const addr = testAddr('gen')
    const result = generateSigningKey(addr)
    assert.ok(result.publicKeyPem.includes('BEGIN PUBLIC KEY'))
    const loaded = loadPrivateSigningKey(addr)
    assert.ok(loaded !== null, 'private key should be loadable after generation')
  })

  it('refuses to overwrite existing private key', () => {
    const addr = testAddr('no-overwrite')
    generateSigningKey(addr)
    assert.throws(() => generateSigningKey(addr), /refusing to overwrite/)
  })

  it('writes private key with mode 600', () => {
    const addr = testAddr('mode')
    generateSigningKey(addr)
    const path = join(homedir(), '.crosstalk', 'keys', `${addr}.sign`)
    const mode = statSync(path).mode & 0o777
    assert.equal(mode, 0o600, 'private key should be mode 600')
  })

  it('rejects invalid addresses', () => {
    assert.throws(() => generateSigningKey('Invalid'), /invalid address/)
    assert.throws(() => generateSigningKey('alice-1'), /reserved for pool instances/)
  })

  it('returns null when loading a non-existent key', () => {
    assert.equal(loadPrivateSigningKey(testAddr('nonexistent-xyz')), null)
  })
})

describe('publishPublicKey + loadPublicKey', () => {
  it('publishes public key to transport, loads it back', () => {
    const addr = testAddr('publish')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)
    const loaded = loadPublicKey(tempTransport, addr)
    assert.ok(loaded !== null)
  })

  it('returns null for unpublished public key', () => {
    assert.equal(loadPublicKey(tempTransport, testAddr('not-published')), null)
  })
})

describe('signMessage + verifyMessage — full round trip', () => {
  it('signs and verifies a message successfully', () => {
    const addr = testAddr('roundtrip')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const message = `---
from: ${addr}
to: all
timestamp: 2026-05-17T22:00:00Z
---

Test message body
`
    const signature = signMessage(message, addr)
    const signed = embedSignature(message, signature)

    const result = verifyMessage(signed, addr, tempTransport)
    assert.deepEqual(result, { valid: true })
  })

  it('signAndEmbed is a one-call equivalent', () => {
    const addr = testAddr('shortcut')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const message = `---
from: ${addr}
to: all
---

Test
`
    const signed = signAndEmbed(message, addr)
    const result = verifyMessage(signed, addr, tempTransport)
    assert.deepEqual(result, { valid: true })
  })

  it('detects tampering — modified body fails verification', () => {
    const addr = testAddr('tamper-body')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const message = `---
from: ${addr}
to: all
---

Original body
`
    const signed = signAndEmbed(message, addr)
    const tampered = signed.replace('Original body', 'Tampered body')

    const result = verifyMessage(tampered, addr, tempTransport)
    assert.equal(result.valid, false)
    if (!result.valid) assert.equal(result.reason, 'signature-mismatch')
  })

  it('detects tampering — modified frontmatter fails verification', () => {
    const addr = testAddr('tamper-from')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const message = `---
from: ${addr}
to: alice@steve
---

Body
`
    const signed = signAndEmbed(message, addr)
    const tampered = signed.replace('to: alice@steve', 'to: bob@steve')

    const result = verifyMessage(tampered, addr, tempTransport)
    assert.equal(result.valid, false)
    if (!result.valid) assert.equal(result.reason, 'signature-mismatch')
  })

  it('returns no-signature when message has no signature', () => {
    const addr = testAddr('no-sig')
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const unsigned = `---
from: ${addr}
to: all
---

Body
`
    const result = verifyMessage(unsigned, addr, tempTransport)
    assert.equal(result.valid, false)
    if (!result.valid) assert.equal(result.reason, 'no-signature')
  })

  it('returns no-public-key when address has no published .pub', () => {
    // Create a signed message but don't publish the public key
    const addr = testAddr('no-pub')
    const { publicKeyPem: _ } = generateSigningKey(addr)
    // intentionally skip publishPublicKey

    const message = `---
from: ${addr}
to: all
---

Body
`
    const signed = signAndEmbed(message, addr)
    const result = verifyMessage(signed, addr, tempTransport)
    assert.equal(result.valid, false)
    if (!result.valid) assert.equal(result.reason, 'no-public-key')
  })

  it('rejects signature signed by a different key (impersonation attempt)', () => {
    const realAddr = testAddr('victim')
    const attackerAddr = testAddr('attacker')

    // Real victim publishes their public key
    const { publicKeyPem: realPub } = generateSigningKey(realAddr)
    publishPublicKey(tempTransport, realAddr, realPub)

    // Attacker generates their own key
    generateSigningKey(attackerAddr)

    // Attacker tries to post a message claiming to be from victim,
    // signed with attacker's private key
    const message = `---
from: ${realAddr}
to: all
---

Pretending to be victim
`
    const attackerSigned = signAndEmbed(message, attackerAddr)
    // Replace the implicit "this was signed by attacker" with addressing it
    // to the victim — i.e., verify against victim's public key
    const result = verifyMessage(attackerSigned, realAddr, tempTransport)
    assert.equal(result.valid, false)
    if (!result.valid) assert.equal(result.reason, 'signature-mismatch')
  })
})

describe('signing — human address forms', () => {
  it('signs and verifies for a bare human address', () => {
    const addr = testAddr('human')  // looks like "test-xxxx-human" — valid bare name
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(tempTransport, addr, publicKeyPem)

    const message = `---
from: ${addr}
to: all
---

Human message
`
    const signed = signAndEmbed(message, addr)
    const result = verifyMessage(signed, addr, tempTransport)
    assert.deepEqual(result, { valid: true })
  })
})

describe('embedSignature', () => {
  it('inserts signature before closing ---', () => {
    const message = `---
from: alice@steve
to: all
---

Body
`
    const result = embedSignature(message, 'fake-sig==')
    const lines = result.split('\n')
    assert.equal(lines[3], 'signature: fake-sig==')
    assert.equal(lines[4], '---')
  })

  it('throws on malformed frontmatter (missing closing ---)', () => {
    const malformed = `---
from: alice
to: all

No closing delimiter
`
    assert.throws(() => embedSignature(malformed, 'sig'), /no complete frontmatter/)
  })
})
