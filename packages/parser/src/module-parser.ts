/** Turns one `.ail` file into an IR module (before semantic analysis). */
import {
  CODEGEN_TARGETS,
  IR_VERSION,
  type CodegenTarget,
  type DiagnosticBag,
  type IRDeclaration,
  type IRModule,
} from '@ai-lang/core';
import { behaviourParsers } from './declarations/behaviour.js';
import { dataShapeParsers } from './declarations/data-shapes.js';
import { queryParser } from './declarations/query.js';
import { DeclarationRegistry } from './declarations/registry.js';
import { parseFrontmatter } from './frontmatter.js';
import { parseInfrastructure } from './infrastructure-parser.js';
import { ParseReporter } from './reporter.js';
import { readBody, splitSections, type Section } from './section.js';
import { SourceFile } from './source.js';

export const defaultDeclarationRegistry = (): DeclarationRegistry => {
  const registry = new DeclarationRegistry();
  for (const parser of [...dataShapeParsers, ...behaviourParsers, queryParser]) registry.register(parser);
  return registry;
};

export interface ParseOptions {
  registry?: DeclarationRegistry;
}

export interface ParseResult {
  module: IRModule | null;
  file: SourceFile;
}

const IMPORT_RELATIONSHIPS = ['shared-kernel', 'anti-corruption-layer', 'conformist', 'open-host'] as const;

export function parseModule(path: string, text: string, diagnostics: DiagnosticBag, options: ParseOptions = {}): ParseResult {
  const file = new SourceFile(path, text);
  const reporter = new ParseReporter(diagnostics);
  const registry = options.registry ?? defaultDeclarationRegistry();

  const frontmatter = parseFrontmatter(file, reporter);
  const { intro, sections } = splitSections(file, frontmatter.body, reporter);

  const name = frontmatter.values.get('module') ?? inferModuleName(path);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    const origin = frontmatter.origins.get('module');
    reporter.error('AIL1610', `"${name}" is not a valid module name`, origin ? file.spanOf(origin) : file.spanOf(file.lines[0]!));
    return { module: null, file };
  }

  const context = frontmatter.values.get('context') ?? capitalize(name);
  const declarations: IRDeclaration[] = [];
  let infrastructure: IRModule['infrastructure'];
  const glossary: IRModule['glossary'] = [];

  for (const section of sections) {
    if (section.keyword === 'infrastructure' || section.keyword === 'infra') {
      if (infrastructure) {
        reporter.error('AIL1611', 'a module can declare infrastructure only once', section.span);
        continue;
      }
      infrastructure = parseInfrastructure(section, reporter);
      continue;
    }
    if (section.keyword === 'glossary' || section.keyword === 'language') {
      glossary.push(...parseGlossary(section));
      continue;
    }

    const parser = registry.get(section.keyword);
    if (!parser) {
      reporter.error(
        'AIL1612',
        `unknown declaration "${section.keyword}"`,
        section.span,
        `known declarations: ${[...registry.keywords(), 'infrastructure', 'glossary'].join(', ')}`,
      );
      continue;
    }
    if (section.name === '' && section.keyword !== 'endpoint') {
      reporter.error('AIL1613', `${section.keyword} needs a name`, section.span);
      continue;
    }
    const produced = parser.parse(section, reporter);
    if (Array.isArray(produced)) declarations.push(...produced);
    else if (produced) declarations.push(produced);
  }

  const module: IRModule = {
    irVersion: IR_VERSION,
    name,
    context,
    glossary,
    imports: parseImports(frontmatter, reporter, file),
    declarations,
    source: { file: path },
  };

  const description = introDescription(intro, file);
  if (description) module.description = description;
  if (infrastructure) module.infrastructure = infrastructure;

  const target = frontmatter.values.get('target');
  if (target) {
    if ((CODEGEN_TARGETS as readonly string[]).includes(target)) module.target = target as CodegenTarget;
    else {
      const origin = frontmatter.origins.get('target');
      reporter.error(
        'AIL1614',
        `unknown compilation target "${target}"`,
        origin ? file.spanOf(origin) : file.spanOf(file.lines[0]!),
        `supported targets: ${CODEGEN_TARGETS.join(', ')}`,
      );
    }
  }

  return { module, file };
}

function parseImports(
  frontmatter: ReturnType<typeof parseFrontmatter>,
  reporter: ParseReporter,
  file: SourceFile,
): IRModule['imports'] {
  const raw = frontmatter.lists.get('imports') ?? [];
  const origin = frontmatter.origins.get('imports');
  const span = origin ? file.spanOf(origin) : file.spanOf(file.lines[0]!);

  return raw.map((entry) => {
    // `catalog via anti-corruption-layer` or `catalog exposing Product, Price`
    const viaMatch = /\bvia\s+([\w-]+)/.exec(entry);
    const exposing = /\b(?:exposing|using)\s+(.*)$/.exec(entry);
    const moduleName = entry.split(/\s+/)[0]!;

    let via: (typeof IMPORT_RELATIONSHIPS)[number] = 'anti-corruption-layer';
    if (viaMatch) {
      const candidate = viaMatch[1]!.toLowerCase();
      if ((IMPORT_RELATIONSHIPS as readonly string[]).includes(candidate)) via = candidate as typeof via;
      else reporter.error('AIL1615', `unknown import relationship "${candidate}"`, span, `supported: ${IMPORT_RELATIONSHIPS.join(', ')}`);
    }
    return {
      module: moduleName,
      names: exposing
        ? exposing[1]!
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      via,
    };
  });
}

function parseGlossary(section: Section): IRModule['glossary'] {
  const body = readBody(section);
  const entries: IRModule['glossary'] = [];
  for (const bullet of body.bullets) {
    const text = bullet.text.replace(/^[-*]\s+/, '');
    const separator = text.indexOf(':');
    if (separator < 0) continue;
    entries.push({ term: text.slice(0, separator).trim(), definition: text.slice(separator + 1).trim() });
  }
  return entries;
}

function introDescription(intro: ReturnType<SourceFile['lines']['slice']>, _file: SourceFile): string | undefined {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of intro) {
    if (line.text.startsWith('#')) continue;
    if (line.text === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(line.text);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  const text = paragraphs.join('\n\n').trim();
  return text.length > 0 ? text : undefined;
}

function inferModuleName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'module';
  return base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
