import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as acorn from "acorn";
import { COMPONENT_SOURCE, patchOriginalSignInGate } from "./scripts/lib/router-renderer-patch.mjs";

const lines = readFileSync("scripts/lib/router-renderer-patch.mjs", "utf8").split("\n");
const expect = { 5: "ABBDC82204", 6: "60F9ABAEF8", 7: "4AF368A8ED", 8: "A1CC810621", 9: "4143D5C2BA", 10: "5AFB1B34C9", 11: "881C5D6D30" };
let ok = true;
for (const n of [5, 6, 7, 8, 9, 10, 11]) {
  const md5 = createHash("md5").update(Buffer.from(lines[n - 1], "utf8")).digest("hex").slice(0, 10).toUpperCase();
  const match = md5 === expect[n];
  if (!match) ok = false;
  console.log(`line ${n}: ${md5} expected ${expect[n]} ${match ? "OK" : "MISMATCH"}`);
}
console.log("protected lines intact:", ok);

acorn.parse(COMPONENT_SOURCE, { ecmaVersion: "latest" });
console.log("COMPONENT_SOURCE parses: OK");

const chunk = readFileSync("src/app/dist/renderer/assets/index-lA9cgT4O.js", "utf8");
const patched = patchOriginalSignInGate(chunk);
console.log("patch applied, delta bytes:", Buffer.byteLength(patched) - Buffer.byteLength(chunk));
const guard = 'return n?p.jsxs(p.Fragment,{children:[p.jsx(Ipe,{}),p.jsx(M0t,{})]}):p.jsx(JBn,{chrome:Hzn,children:p.jsx(Gzn,{})})}';
console.log("patched $zn guard present:", patched.includes(guard));
console.log("old 'checking'?null guard gone:", !patched.includes('e==="checking"?null'));
console.log("onboarding screen symbol eDn still referenced elsewhere:", patched.includes("eDn"));
acorn.parse(patched, { ecmaVersion: "latest", sourceType: "module" });
console.log("patched chunk parses (module): OK");
acorn.parse(chunk, { ecmaVersion: "latest", sourceType: "module" });
console.log("original chunk parses (module): OK");