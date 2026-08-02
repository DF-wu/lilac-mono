import {
  baselineFromFindings,
  formatSyntaxBaseline,
  scanSyntaxFindings,
} from "./check-syntax-ratchet.mts";

const findings = await scanSyntaxFindings();
const baseline = baselineFromFindings(findings);

await Bun.write("scripts/oxlint-plugins/syntax-baseline.mts", formatSyntaxBaseline(baseline));
console.log(`generated ${findings.length} reviewed Stage 0 syntax baseline entries`);
