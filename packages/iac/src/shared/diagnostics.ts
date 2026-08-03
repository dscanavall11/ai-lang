/**
 * IaC diagnostics.
 *
 * A platform that cannot express something the IR declares says so instead of
 * emitting a plausible-looking guess: an unusable warning beats wrong YAML.
 */
import { unknownSpan, type Diagnostic, type SourceSpan } from '@haic/core';

/** Stable machine-readable codes for the `iac` stage. */
export const IAC_CODE = {
  noContextRequests: 'HADL3001',
  unsupportedRuntime: 'HADL3002',
  unsupportedDatabase: 'HADL3010',
  unsupportedBroker: 'HADL3011',
  unsupportedCache: 'HADL3012',
  unsupportedObjectStore: 'HADL3013',
  unsupportedAuth: 'HADL3020',
  noEventSource: 'HADL3021',
} as const;

export function iacWarning(code: string, message: string, span: SourceSpan, hint?: string): Diagnostic {
  return { severity: 'warning', stage: 'iac', code, message, span, hint };
}

/** Nothing in the project asked for this platform, so it produced no files. */
export function noContextRequests(platform: string, target: string): Diagnostic {
  return iacWarning(
    IAC_CODE.noContextRequests,
    `no bounded context deploys to "${target}", so the ${platform} generator emitted nothing`,
    unknownSpan('<project>'),
    `add "deploy to ${target}" to an infrastructure block`,
  );
}

/** The platform has no equivalent for a declared engine; the resource is skipped. */
export function unsupportedEngine(
  code: string,
  platform: string,
  kind: string,
  resource: string,
  engine: string,
  span: SourceSpan,
): Diagnostic {
  return iacWarning(
    code,
    `${platform} cannot provision the ${kind} "${resource}": engine "${engine}" has no equivalent there`,
    span,
    `declare a different engine for "${resource}", or provision it outside HADL`,
  );
}
