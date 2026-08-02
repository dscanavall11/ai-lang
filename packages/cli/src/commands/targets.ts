/** `ail targets` — what this build of the compiler can emit. */
import { codeGenerators } from '@ai-lang/codegen';
import { infrastructureGenerators } from '@ai-lang/iac';
import { EXIT_OK, type Command } from '../command.js';
import { dim, heading, info } from '../output.js';

export const targetsCommand: Command = {
  name: 'targets',
  summary: 'List the available language and deployment targets',
  usage: 'ail targets',

  run() {
    heading('Languages');
    for (const generator of codeGenerators.all()) {
      const verify = generator.verifyCommand ? dim(`  (verify: ${generator.verifyCommand.join(' ')})`) : '';
      info(`  ${generator.id.padEnd(12)} ${generator.displayName} — ${generator.framework}${verify}`);
    }
    heading('Deployment platforms');
    for (const generator of infrastructureGenerators.all()) {
      const verify = generator.verifyCommand ? dim(`  (verify: ${generator.verifyCommand.join(' ')})`) : '';
      info(`  ${generator.id.padEnd(12)} ${generator.displayName}${verify}`);
    }
    return EXIT_OK;
  },
};
