#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`kazi-agent: ${(error as Error).message ?? String(error)}\n`);
    process.exitCode = 1;
  });
