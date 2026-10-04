import { readFileSync } from "node:fs";
const target = process.argv[2];
const needlesFile = process.argv[3];
const buf = readFileSync(target);
const text = buf.toString("latin1");
const needles = readFileSync(needlesFile, "utf8").split("\n").filter((l) => l.length > 0);
console.log(`${target} :: ${buf.length} bytes`);
for (const needle of needles) {
  const at = text.indexOf(needle);
  console.log(`  ${at >= 0 ? "FOUND  " : "MISSING"}  @${at}  ${needle}`);
}