/**
 * Literal conversion.
 *
 * `given task be Task with id = "t-1"` is how anyone writes a scenario, and
 * `"t-1"` is not a uuid. Three answers were available: accept it and let a typed
 * backend refuse it later, refuse it here and fill every scenario with
 * `"11111111-1111-4111-8111-111111111111"`, or convert it.
 *
 * Converting wins because the identifier in a scenario is a *name*, not a value:
 * nothing reads its digits, everything compares it to itself. So a text literal
 * standing where a uuid is declared becomes the UUID version 5 of that text —
 * derived, stable, and the same in the interpreter, in the IR, in every backend
 * and in every compiled test. `"t-1"` is one uuid, `"t-2"` is another, and the
 * design stays readable.
 *
 * The conversion is recorded in the IR rather than applied at each use, so
 * `haic ir` shows exactly what will run. Nothing downstream has to know this
 * file exists.
 */
import { createHash } from 'node:crypto';

/** Namespace uuid for HADL identifiers. Fixed forever; changing it moves every id. */
const NAMESPACE = 'f7d2c1a8-3b46-4e9f-9c05-1a7b6d4e2f83';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(text: string): boolean {
  return UUID_PATTERN.test(text);
}

/**
 * The uuid this text stands for: itself when it already is one, and its RFC
 * 4122 version 5 derivation otherwise.
 */
export function uuidFor(text: string): string {
  if (isUuid(text)) return text.toLowerCase();

  const namespace = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(Buffer.concat([namespace, Buffer.from(text, 'utf8')])).digest();

  // Version 5, RFC 4122 variant: the two fields that say how this was derived.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
