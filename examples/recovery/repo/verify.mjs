// Independent verification (spec §39): the runtime runs this after the agent
// claims to be finished. The agent's summary is not evidence; this is.
import { readFileSync } from 'node:fs';

const EXPECTED_TOTAL_CENTS = 85000;

let report;
try {
  report = readFileSync('report.md', 'utf8');
} catch {
  console.error('report.md was not written');
  process.exit(1);
}

const digits = report.replace(/[,\s_]/g, '');
if (!digits.includes(String(EXPECTED_TOTAL_CENTS))) {
  console.error(`report.md does not contain the total ${EXPECTED_TOTAL_CENTS} cents`);
  process.exit(1);
}
console.log(`report.md reports ${EXPECTED_TOTAL_CENTS} cents in orders over 10000`);
