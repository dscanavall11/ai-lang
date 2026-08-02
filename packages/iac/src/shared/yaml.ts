/** YAML documents: the banner, optional notes, then `toYaml` over a plain object. */
import { GENERATED_BANNER, toYaml } from '@ai-lang/core';

export function yamlDocument(value: unknown, notes: readonly string[] = []): string {
  const header = [`# ${GENERATED_BANNER}`, ...notes.map((note) => `# ${note}`)];
  return `${header.join('\n')}\n${toYaml(value)}\n`;
}
