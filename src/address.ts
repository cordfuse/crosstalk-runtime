/**
 * Actor address grammar — parser + types for the v1.x multi-operator design.
 *
 * Address forms:
 *   `steve`               → human actor (operator's self)
 *   `alice@steve`         → machine actor in Steve's namespace (singleton or pool)
 *   `alice-7@steve`       → instance 7 of Steve's `alice` pool
 *   `alice@steve/cachy`   → instance of Steve's `alice` pool tagged "cachy"
 *   `dart-thrower-1@bob`  → instance 1 of Bob's `dart-thrower` pool
 *
 * Asymmetries:
 *   - Humans are addressed by BARE NAME (no `@`). They aren't owned, they ARE.
 *   - Machine actors carry `@operator` because they're owned by an operator.
 *   - `steve@steve` (redundant explicit human form) parses but is equivalent to `steve`.
 *
 * Hyphen-integer reservation rule:
 *   - Role names CANNOT end in `-<integer>`.
 *   - Trailing `-<integer>` ALWAYS means instance-of-pool.
 *   - E.g. `alice-7` is instance 7 of pool `alice`; never a role named `alice-7`.
 *   - `dart-thrower-1` is instance 1 of pool `dart-thrower`; never a role.
 *
 * Pure parsing — no I/O, no crypto, no registry lookups. The parser tells
 * you what shape an address has; resolution to a concrete actor identity
 * happens later in the dispatch layer.
 *
 * Locked design spec: `cordfuse/crosstalk/TODO.md` item #34 (2026-05-17).
 */

/** Discriminated union — what kind of actor address. */
export type ParsedAddress =
  | { kind: 'human'; name: string }
  | {
      kind: 'machine';
      role: string;
      operator: string;
      instance?:
        | { kind: 'index'; n: number }
        | { kind: 'tag'; tag: string };
    };

/** Returned by `parseAddress` when the input doesn't form a valid address.
 * `message` is human-readable for surfacing in CLI errors / logs. */
export type AddressParseError = {
  kind: 'error';
  input: string;
  message: string;
};

/** Names allowed for roles and operator handles. kebab-case alphanumeric.
 * No leading digit, no consecutive hyphens, no trailing hyphen. */
const NAME_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Trailing `-<integer>` matcher for stripping the instance suffix off a
 * role. Captures: role-without-suffix, integer. */
const INSTANCE_INDEX_SUFFIX = /^(.+)-(\d+)$/;

/** Parse an actor address. Returns a ParsedAddress on success or
 * AddressParseError on failure. Never throws. */
export function parseAddress(input: string): ParsedAddress | AddressParseError {
  if (typeof input !== 'string') {
    return { kind: 'error', input: String(input), message: 'address must be a string' };
  }
  const raw = input.trim();
  if (!raw) {
    return { kind: 'error', input, message: 'address is empty' };
  }

  // Split on the FIRST `@`. Machine actors have exactly one `@`; humans have
  // zero. Reject multiple `@` (no support for federated identities yet).
  const atCount = (raw.match(/@/g) ?? []).length;
  if (atCount > 1) {
    return {
      kind: 'error',
      input,
      message: `multiple "@" characters — addresses contain at most one`,
    };
  }

  // ── Human form (no `@`) ─────────────────────────────────────────────────
  if (atCount === 0) {
    // The hyphen-integer reservation: a bare name ending in `-<int>` would
    // be ambiguous (is it a pool instance? a role?). For humans this is
    // unambiguously invalid — humans aren't pools.
    if (INSTANCE_INDEX_SUFFIX.test(raw)) {
      return {
        kind: 'error',
        input,
        message: `bare name ending in -<integer> is reserved for pool instances; humans are not pools`,
      };
    }
    if (!NAME_TOKEN.test(raw)) {
      return {
        kind: 'error',
        input,
        message: `invalid human name "${raw}" — expected kebab-case alphanumeric`,
      };
    }
    return { kind: 'human', name: raw };
  }

  // ── Machine form (`role@operator` or `role-N@operator` or `role@operator/tag`) ──
  const [rolePart, operatorAndInstance] = raw.split('@');

  if (!rolePart) {
    return { kind: 'error', input, message: `missing role before "@"` };
  }
  if (!operatorAndInstance) {
    return { kind: 'error', input, message: `missing operator after "@"` };
  }

  // The operator part may optionally include `/<tag>` for instance addressing.
  let operatorPart = operatorAndInstance;
  let tagInstance: string | null = null;
  const slashIdx = operatorAndInstance.indexOf('/');
  if (slashIdx >= 0) {
    operatorPart = operatorAndInstance.slice(0, slashIdx);
    tagInstance = operatorAndInstance.slice(slashIdx + 1);
  }

  if (!operatorPart) {
    return { kind: 'error', input, message: `empty operator between "@" and "/"` };
  }
  if (!NAME_TOKEN.test(operatorPart)) {
    return {
      kind: 'error',
      input,
      message: `invalid operator handle "${operatorPart}" — expected kebab-case alphanumeric`,
    };
  }

  // Special case: `steve@steve` (redundant explicit human form). Parse as human.
  // The role part must match the operator part for this equivalence to apply.
  if (rolePart === operatorPart && tagInstance === null) {
    // Re-validate as human (same rules apply).
    if (INSTANCE_INDEX_SUFFIX.test(rolePart)) {
      return {
        kind: 'error',
        input,
        message: `bare name ending in -<integer> is reserved for pool instances; humans are not pools`,
      };
    }
    return { kind: 'human', name: rolePart };
  }

  // Try to strip a trailing `-<integer>` off the role part. If present,
  // that's the index instance suffix.
  const indexMatch = rolePart.match(INSTANCE_INDEX_SUFFIX);
  let role: string;
  let indexInstance: number | null = null;
  if (indexMatch) {
    role = indexMatch[1];
    indexInstance = parseInt(indexMatch[2], 10);
  } else {
    role = rolePart;
  }

  // Can't have BOTH `-N` and `/tag` instance discriminators on the same address.
  if (indexInstance !== null && tagInstance !== null) {
    return {
      kind: 'error',
      input,
      message: `cannot combine -<integer> and /<tag> instance discriminators on the same address`,
    };
  }

  if (!NAME_TOKEN.test(role)) {
    return {
      kind: 'error',
      input,
      message: `invalid role "${role}" — expected kebab-case alphanumeric`,
    };
  }
  if (tagInstance !== null && !NAME_TOKEN.test(tagInstance)) {
    return {
      kind: 'error',
      input,
      message: `invalid instance tag "${tagInstance}" — expected kebab-case alphanumeric`,
    };
  }

  const machine: Extract<ParsedAddress, { kind: 'machine' }> = {
    kind: 'machine',
    role,
    operator: operatorPart,
  };
  if (indexInstance !== null) {
    machine.instance = { kind: 'index', n: indexInstance };
  } else if (tagInstance !== null) {
    machine.instance = { kind: 'tag', tag: tagInstance };
  }
  return machine;
}

/** True when the parse result is an error rather than a valid address.
 * Convenience for callers using narrowing. */
export function isAddressError(result: ParsedAddress | AddressParseError): result is AddressParseError {
  return result.kind === 'error';
}

/** Format a ParsedAddress back to its canonical string form. Round-trips
 * with parseAddress (modulo the `steve@steve` → `steve` canonicalisation). */
export function formatAddress(addr: ParsedAddress): string {
  if (addr.kind === 'human') {
    return addr.name;
  }
  const base = addr.instance && addr.instance.kind === 'index'
    ? `${addr.role}-${addr.instance.n}@${addr.operator}`
    : `${addr.role}@${addr.operator}`;
  if (addr.instance && addr.instance.kind === 'tag') {
    return `${base}/${addr.instance.tag}`;
  }
  return base;
}

/** Validate a role-name standalone (e.g. for actor profile filenames).
 * Returns null if valid, otherwise a human-readable reason it's invalid.
 *
 * Used by the registry to validate actor profile filenames: a profile
 * named `alice-1.md` is technically valid as an instance-1-of-alice
 * declaration, but a profile named `version-2.md` is rejected as a
 * standalone role declaration because trailing `-<int>` is reserved.
 *
 * NOTE: this validator says "is this a valid bare ROLE name" (rejecting
 * trailing `-<int>`). The registry uses it differently for filename
 * parsing — if the filename ends in `-<int>`, it's an instance declaration
 * for the corresponding pool; if not, it's a standalone role declaration.
 * This helper is for the standalone-role case. */
export function validateBareRoleName(name: string): string | null {
  if (typeof name !== 'string' || !name) {
    return 'name is empty';
  }
  if (INSTANCE_INDEX_SUFFIX.test(name)) {
    return `name ends in -<integer>, which is reserved for pool instances`;
  }
  if (!NAME_TOKEN.test(name)) {
    return `invalid name "${name}" — expected kebab-case alphanumeric`;
  }
  return null;
}
