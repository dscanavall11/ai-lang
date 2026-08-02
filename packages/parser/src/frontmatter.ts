/**
 * YAML frontmatter.
 *
 *   ---
 *   module: orders
 *   context: Sales
 *   target: java
 *   imports:
 *     - catalog via anti-corruption-layer
 *   ---
 *
 * Only the flat subset AI-Lang needs is supported: scalars and lists of scalars.
 * Anything deeper belongs in a declaration, not in the header.
 */
import type { ParseReporter } from './reporter.js';
import type { Line, SourceFile } from './source.js';

export interface Frontmatter {
  values: Map<string, string>;
  lists: Map<string, string[]>;
  /** Lines after the closing `---`, i.e. the document body. */
  body: Line[];
  /** Line where each key was declared, for diagnostics. */
  origins: Map<string, Line>;
}

const DELIMITER = /^-{3,}$/;

export function parseFrontmatter(file: SourceFile, reporter: ParseReporter): Frontmatter {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const origins = new Map<string, Line>();
  const lines = file.lines;

  let index = 0;
  while (index < lines.length && lines[index]!.text === '') index += 1;
  if (index >= lines.length || !DELIMITER.test(lines[index]!.text)) {
    return { values, lists, origins, body: lines };
  }

  index += 1;
  let currentList: string[] | null = null;

  while (index < lines.length && !DELIMITER.test(lines[index]!.text)) {
    const line = lines[index]!;
    index += 1;
    if (line.text === '' || line.text.startsWith('#')) continue;

    const bullet = /^[-*]\s+(.*)$/.exec(line.text);
    if (bullet) {
      if (!currentList) {
        reporter.error('AIL1601', 'list item outside of a frontmatter key', file.spanOf(line));
        continue;
      }
      currentList.push(bullet[1]!.trim());
      continue;
    }

    const entry = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.text);
    if (!entry) {
      reporter.error('AIL1602', `expected "key: value" in frontmatter, found "${line.text}"`, file.spanOf(line));
      continue;
    }
    const key = entry[1]!.toLowerCase();
    const value = entry[2]!.trim();
    origins.set(key, line);

    if (value === '') {
      currentList = [];
      lists.set(key, currentList);
      continue;
    }
    currentList = null;
    values.set(key, value.replace(/^["']|["']$/g, ''));
  }

  if (index >= lines.length) {
    reporter.error('AIL1603', 'frontmatter is not closed with "---"', file.spanOf(lines[0]!));
    return { values, lists, origins, body: lines };
  }

  return { values, lists, origins, body: lines.slice(index + 1) };
}
