import { readFileSync } from "node:fs";
const text = readFileSync("src/app/dist/renderer/assets/index-lA9cgT4O.js", "utf8");
const before = ':e==="checking"?null:p.jsx(JBn,{chrome:Hzn,children:e==="onboarding"?p.jsx(eDn,{onComplete:s,presentation:lzn},t):p.jsx(Gzn,{})})}';
const after = ':p.jsx(JBn,{chrome:Hzn,children:p.jsx(Gzn,{})})}';
const count = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n += 1; i += needle.length; } return n; };
console.log("BEFORE occurrences:", count(text, before));
console.log("AFTER occurrences (must be 0):", count(text, after));
const at = text.indexOf(before);
console.log("context:", JSON.stringify(text.slice(at - 220, at + before.length + 60)));
// sanity: the patched form must still be syntactically balanced at that spot
console.log("patched context:", JSON.stringify(text.slice(at - 220, at) + after));