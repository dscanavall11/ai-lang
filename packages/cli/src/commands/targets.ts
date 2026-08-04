/** `haic targets` — what this build of the compiler can emit. */
import { codeGenerators } from '@haic/codegen';
import { aliasesOf, type CodegenTarget } from '@haic/core';
import { infrastructureGenerators } from '@haic/iac';
import { EXIT_OK, type Command } from '../command.js';
import { dim, heading, info } from '../output.js';

export const targetsCommand: Command = {
  name: 'targets',
  summary: 'List the available language and deployment targets',
  usage: 'haic targets',

  run() {
    heading('Languages');
    for (const generator of codeGenerators.all()) {
      const verify = generator.verifyCommand ? dim(`  (verify: ${generator.verifyCommand.join(' ')})`) : '';
      info(`  ${generator.id.padEnd(12)} ${generator.displayName} — ${generator.framework}${verify}`);
      // The names `--language` and a code fence accept for this backend.
      const aliases = aliasesOf(generator.id as CodegenTarget);
      if (aliases.length > 0) info(`  ${''.padEnd(12)} ${dim(`also written: ${aliases.join(', ')}`)}`);
    }
    heading('Deployment platforms');
    for (const generator of infrastructureGenerators.all()) {
      const verify = generator.verifyCommand ? dim(`  (verify: ${generator.verifyCommand.join(' ')})`) : '';
      info(`  ${generator.id.padEnd(12)} ${generator.displayName}${verify}`);
    }
    return EXIT_OK;
  },
};
