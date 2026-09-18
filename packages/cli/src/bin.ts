#!/usr/bin/env node
import { main } from './cli.js';

// A closed pipe (`kazi-agent runs | head`) is normal, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`kazi-agent: ${(error as Error).message ?? String(error)}\n`);
    process.exitCode = 1;
  });
