import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]);
const hlen = b.readUInt32LE(12);
const h = JSON.parse(b.toString("utf8", 16, 16 + hlen));
const out = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files ?? {})) {
    const name = prefix ? `${prefix}/${k}` : k;
    if (v.files) walk(v, name);
    else out.push(`${name}  ${v.size ?? ""}`);
  }
};
walk(h, "");
console.log("entries:", out.length);
const filter = process.argv[3];
for (const line of out) {
  if (filter && !line.startsWith(filter)) continue;
  if (!filter && line.startsWith("dist/deps/")) continue;
  console.log(line);
}