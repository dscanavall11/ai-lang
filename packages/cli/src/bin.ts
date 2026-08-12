#!/usr/bin/env node
import { main } from './index.js';

// `haic explain X | head` closes the pipe early; that is the reader saying
// "enough", not a failure worth a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2));
