/** `ail new` — scaffold a project that already compiles. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { kebabCase, pascalCase } from '@ai-lang/core';
import { flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Command } from '../command.js';
import { dim, error, info, success } from '../output.js';

export const newCommand: Command = {
  name: 'new',
  summary: 'Create a new AI-Lang project',
  usage: 'ail new <name> [--target <language>]',
  flags: [{ name: '--target <language>', description: 'Default compilation target (default: typescript)' }],

  run({ args, cwd }) {
    const name = args.positional[0];
    if (!name) {
      error('a project name is required: ail new my-service');
      return EXIT_USAGE;
    }

    const root = resolve(cwd, kebabCase(name));
    if (existsSync(root)) {
      error(`${root} already exists`);
      return EXIT_FAILURE;
    }

    const target = flagString(args, 'target', 'typescript');
    const moduleName = kebabCase(name).replace(/-/g, '');
    const contextName = pascalCase(name);

    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', `${kebabCase(name)}.ail`), starterModule(moduleName, contextName, target), 'utf8');
    writeFileSync(join(root, 'ail.json'), starterConfig(name, target), 'utf8');
    writeFileSync(join(root, 'README.md'), starterReadme(name), 'utf8');
    writeFileSync(join(root, '.gitignore'), 'out/\nnode_modules/\n', 'utf8');

    success(`created ${dim(root)}`);
    info('');
    info('Next steps:');
    info(`  cd ${kebabCase(name)}`);
    info('  ail check src');
    info(`  ail build src --target ${target}`);
    return EXIT_OK;
  },
};

/**
 * The starter is a complete slice, not a skeleton: one aggregate with a real
 * invariant, one port, one service, one endpoint. It compiles as written.
 */
function starterModule(moduleName: string, contextName: string, target: string): string {
  return `---
module: ${moduleName}
context: ${contextName}
target: ${target}
---

# ${contextName}

Describe the domain in plain language. This paragraph becomes the module's documentation.

## aggregate Item
identified by id

- id: uuid, required
- name: text, required, min length 1, max length 200
- archived: boolean, required, default false

invariant "an archived item keeps its name":
  archived is false or name is not empty

operation archive () -> nothing:
  set archived to true

## command ArchiveItem targets Item
- itemId: uuid, required

## error ItemNotFound (checked, status 404)
message: "no item exists with id {itemId}"

- itemId: uuid, required

## port ItemRepository (outbound)
using in-memory

- find item by id (id: uuid) -> Item or ItemNotFound
- save item (item: Item) -> nothing

## port ArchiveItemUseCase (inbound)
- archive item (command: ArchiveItem) -> Item or ItemNotFound

## service ArchiveItemService
uses ItemRepository
implements ArchiveItemUseCase

operation archive item (command: ArchiveItem) -> Item or ItemNotFound:
  let item be find item by id with id = command.itemId
  perform archive with item = item
  perform save item with item = item
  return item

## endpoint POST /items/{itemId}/archive
handled by ArchiveItemService.archive item
request ArchiveItem
responds 200 with Item
responds 404 when ItemNotFound

## infrastructure
port 8080
database ${moduleName}db using postgres
deploy to docker
`;
}

function starterConfig(name: string, target: string): string {
  return `${JSON.stringify({ name, sources: ['src'], defaultTarget: target, out: 'out' }, null, 2)}\n`;
}

function starterReadme(name: string): string {
  return `# ${name}

An AI-Lang project. The \`.ail\` files under \`src/\` are the source of truth for
both the code and the infrastructure.

\`\`\`bash
ail check src          # parse, type-check, and audit the design
ail build src          # generate the service
ail deploy src         # generate the infrastructure
\`\`\`
`;
}
