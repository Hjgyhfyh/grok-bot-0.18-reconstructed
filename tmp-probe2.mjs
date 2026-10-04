import { readFileSync } from "node:fs";
const [file, needlesFile] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
const needles = readFileSync(needlesFile, "utf8").split("\n").filter((line) => line.length > 0);
for (const needle of needles) {
  let from = 0;
  let hits = 0;
  while (hits < 3) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    hits += 1;
    const start = Math.max(0, at - 900);
    const end = Math.min(text.length, at + needle.length + 900);
    console.log(`\n===== [${needle}] @ ${at} =====`);
    console.log(text.slice(start, end));
    from = at + needle.length;
  }
  if (hits === 0) console.log(`\n===== [${needle}] :: NOT FOUND =====`);
}