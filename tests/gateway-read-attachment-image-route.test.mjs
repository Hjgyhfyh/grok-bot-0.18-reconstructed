import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * `POST /api/readAttachmentImage` was never driven over a real socket, so two
 * things nobody could see were open: whether the route answers without its bearer
 * token, and whether it answers anything at all for the file kinds the product
 * actually accepts.
 *
 * What this route is: it is not a side door. The desktop never calls it directly.
 * `source/electron-main/adapters/attachment-gateway.ts:89` takes the attachment
 * legs from `context.coordinatorLegs.legs`, `source/node-agent-coordinator/main.ts:235`
 * serves `COORDINATOR_MAIN_METHOD_TABLE` over the main-data port, and
 * `readAttachmentImage` is in that table
 * (`source/shared/rpc/coordinator-main.ts:3`) — so the image the renderer shows
 * travels
 * renderer -> preload `resolveAttachmentMedia` -> main edge `resolveMedia`
 * -> `legs.readAttachmentImage` -> coordinator main-data port -> gateway
 * `POST /api/readAttachmentImage` -> `readHostAttachmentImage`.
 * One dead hop on that chain and every image in the app is "Image unavailable",
 * which is exactly the symptom the drive-path fix had to clear.
 *
 * What the tests below measure, on a real `startGatewayServer` with the real
 * `readHostAttachmentImage` behind it and a real sandbox on disk:
 *
 *  - without a token: `401`, and the body carries no image bytes;
 *  - with a wrong token: `401`;
 *  - with the right token: `200` and the exact bytes of the file on disk;
 *  - with a browser `Origin:` header: `403`, before the bearer check;
 *  - `GET /health` with no token: `200` — the documented exception, which exists
 *    because `host-supervisor.ts` probes it without a credential and a required
 *    token there would turn every reachability report into a 401;
 *  - a body that is not an object: `400` naming `readAttachmentImage`;
 *  - and the six file kinds, each measured against what the host answers.
 *
 * The read surface is also pinned, because the three read commands do not agree
 * about it. Measured on this code, against one sandbox holding seven PNGs:
 * `readHostAttachmentImage` answered for all seven, `readAttachmentChunk` for two.
 * `readImage` guards with `isPathWithin(getSandRootDir(), resolved)`; the chunk and
 * text legs guard with `resolveAttachmentOwnerDir`, which additionally requires
 * `<root>/agents/<safe-id>/{attachments,assets}`. So an image in the shared
 * `box-workspace` — where agents write files — is readable through this route and
 * refused through the chunk leg for the identical path. The tests state that
 * difference as data rather than narrowing either guard: narrowing the image guard
 * is a product decision with a real cost, and the number is what makes it
 * arguable.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-attachment-image-"));
  const written = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    const file = path.join(directory, name);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    });
    written.push([name, file]);
  }
  const loaded = {};
  for (const [name, file] of written) loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "gateway-server.ts"],
  ["host", "extensions", "attachments", "attachments-service.ts"],
]);
const { startGatewayServer } = loaded["gateway-server.mjs"];
const { readHostAttachmentImage, readHostAttachmentChunk, readAttachmentText, resolveAttachmentOwnerDir } =
  loaded["attachments-service.mjs"];
test.after(() => dispose());

const AGENT_ID = "bfc58d14-8380-4ae9-ba16-927a1fad9bc8";
const OTHER_AGENT_ID = "0bcd4a61-f3f5-4fb2-9d0e-672f7fee6743";
const TOKEN = "t".repeat(43);

/** A real 1x1 PNG. Small enough to keep inline, real enough to decode. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A real 1x1 baseline JPEG. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "utf8");
/** A PNG whose 40-byte header is intact and whose 400-byte body is noise. */
const CORRUPT_PNG = Buffer.concat([PNG.subarray(0, 40), Buffer.alloc(400, 0xab)]);
/** A 3 MB image: legal under ATTACHMENT_BYTE_LIMIT, large enough to chunk. */
const LARGE_PNG = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 0)]);

const previousRoot = process.env.SAND_DATA_ROOT;
const sandbox = await mkdtemp(path.join(os.tmpdir(), "grok-sand-root-"));
process.env.SAND_DATA_ROOT = sandbox;
test.after(async () => {
  if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
  else process.env.SAND_DATA_ROOT = previousRoot;
  await rm(sandbox, { recursive: true, force: true });
});

const agentDir = path.join(sandbox, "agents", AGENT_ID);
const attachmentsDir = path.join(agentDir, "attachments");
await mkdir(attachmentsDir, { recursive: true });

const stored = {
  png: path.join(attachmentsDir, `${"a".repeat(64)}.png`),
  jpg: path.join(attachmentsDir, `${"b".repeat(64)}.jpg`),
  "corrupt.png": path.join(attachmentsDir, `${"c".repeat(64)}.png`),
  "large.png": path.join(attachmentsDir, `${"d".repeat(64)}.png`),
  "doc.pdf": path.join(attachmentsDir, `${"e".repeat(64)}.pdf`),
  "notes.zzz": path.join(attachmentsDir, `${"f".repeat(64)}.zzz`),
  "noext": path.join(attachmentsDir, `${"0".repeat(64)}`),
};
await writeFile(stored.png, PNG);
await writeFile(stored.jpg, JPEG);
await writeFile(stored["corrupt.png"], CORRUPT_PNG);
await writeFile(stored["large.png"], LARGE_PNG);
await writeFile(stored["doc.pdf"], PDF);
await writeFile(stored["notes.zzz"], "plain text, not an image\n", "utf8");
await writeFile(stored.noext, "plain text, not an image\n", "utf8");

// The read-surface fixtures: seven PNGs, only two of them inside an agent's
// own attachments or assets folder.
const surfaces = {
  "own attachments": path.join(attachmentsDir, `${"1".repeat(64)}.png`),
  "own assets": path.join(agentDir, "assets", `${"2".repeat(64)}.png`),
  "another agent's attachments": path.join(sandbox, "agents", OTHER_AGENT_ID, "attachments", `${"3".repeat(64)}.png`),
  "agent avatar": path.join(agentDir, "avatar.png"),
  "shared box workspace": path.join(sandbox, "box-workspace", "shot.png"),
  "sandbox root": path.join(sandbox, "loose.png"),
  "link preview cache": path.join(sandbox, "link-preview-cache", `${"4".repeat(64)}.png`),
};
for (const file of Object.values(surfaces)) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, PNG);
}
await writeFile(surfaces["own attachments"], PNG);

// The outside-the-sandbox control. The guard has to refuse it or none of the
// numbers above mean anything.
const outside = path.join(sandbox, "..", path.basename(sandbox) + "-outside.png");
await writeFile(outside, PNG);

/** The production wiring, reduced: `host-gateway-api.ts:1271` is exactly this call. */
const gatewayApi = {
  readAttachmentImage: (args) => readHostAttachmentImage(args.path),
  getAgentAvatar: () => ({ dataUrl: null, version: null }),
};

const server = await startGatewayServer({
  api: gatewayApi,
  subscribe: () => () => {},
  getHealth: () => ({ isBusy: false, lastBusyAtMs: 0 }),
  startedAt: 0,
  authToken: TOKEN,
});
test.after(() => server.close());
const base = `http://127.0.0.1:${server.port}`;

async function call(body, { token = TOKEN, headers = {} } = {}) {
  const response = await fetch(`${base}/api/readAttachmentImage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, raw: text };
}

test("the image route hands over the bytes of a file the host already stored", async () => {
  const answer = await call({ path: stored.png });
  assert.equal(answer.status, 200, "a stored image read with the right token did not answer 200");
  assert.equal(
    answer.body?.dataUrl,
    `data:image/png;base64,${PNG.toString("base64")}`,
    "the bytes handed to the renderer are not the bytes on disk",
  );
  assert.equal(answer.body?.width, 1, "a 1x1 PNG was measured as something else");
  assert.equal(answer.body?.height, 1, "a 1x1 PNG was measured as something else");

  const jpeg = await call({ path: stored.jpg });
  assert.equal(jpeg.status, 200, "a stored JPEG did not answer 200");
  assert.equal(
    jpeg.body?.dataUrl,
    `data:image/jpeg;base64,${JPEG.toString("base64")}`,
    "the JPEG round-trip changed the bytes",
  );
});

test("the image route answers nothing at all without its bearer token", async () => {
  const anonymous = await call({ path: stored.png }, { token: null });
  assert.equal(anonymous.status, 401, "the image route served a caller that presented no token");
  assert.ok(
    !anonymous.raw.includes("data:image"),
    "the refusal still carried the image bytes in its body, so the token bought nothing",
  );

  const wrong = await call({ path: stored.png }, { token: "not-the-token" });
  assert.equal(wrong.status, 401, "the image route served a caller that presented the wrong token");

  // A prefix of the real token must not pass. A length-or-prefix comparison is
  // the classic way this check quietly degrades.
  const prefix = await call({ path: stored.png }, { token: TOKEN.slice(0, 20) });
  assert.equal(prefix.status, 401, "a prefix of the real token was accepted as the token");

  // And the route is not the one thing that answers without a credential: health
  // is, on purpose, and the test below proves that exception still exists so a
  // future "require auth everywhere" change cannot be made by accident.
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200, "the health probe the host supervisor relies on stopped answering without a token");
});

test("the image route refuses a browser before it even looks at the token", async () => {
  const browser = await call({ path: stored.png }, { token: null, headers: { origin: "http://evil.example" } });
  assert.equal(browser.status, 403, "a cross-origin request with no token was answered as a token problem rather than a browser problem");
});

test("the image route names itself when the body is not a request", async () => {
  const notJson = await call("{", {});
  assert.equal(notJson.status, 400, "a truncated body was answered as a server fault");
  assert.match(
    String(notJson.body?.error),
    /readAttachmentImage/,
    "the 400 names neither the endpoint nor the problem, so the caller cannot tell what to fix",
  );

  const notAnObject = await call([{ path: stored.png }]);
  assert.equal(notAnObject.status, 400, "a JSON array was accepted where a command object is required");
});

test("each file kind answers what it is, and the answer is measured", async () => {
  const table = [];
  for (const [label, file] of Object.entries(stored)) {
    const answer = await call({ path: file });
    assert.equal(answer.status, 200, `${label} did not answer 200 with a valid token`);
    table.push({ label, body: answer.body });
  }
  const byLabel = Object.fromEntries(table.map((row) => [row.label, row.body]));

  // A PDF is not an image and the route says so rather than guessing.
  assert.equal(byLabel["doc.pdf"], null, "the image route returned something for a PDF, so a PDF card can be drawn as an image");

  // An unknown extension and a file with no extension at all are the same case.
  assert.equal(byLabel["notes.zzz"], null, "an unknown extension was answered as an image");
  assert.equal(byLabel.noext, null, "a file with no extension was answered as an image");

  // A corrupt image still answers, and still answers honestly about its header:
  // the IHDR survived, so the dimensions are 1x1 while the pixels are noise. The
  // renderer takes the data URL either way and the <img> fails to decode, which
  // is the honest outcome — the alternative, refusing to serve it, would look
  // identical to the "Image unavailable" bug this whole area is about.
  assert.equal(
    byLabel["corrupt.png"]?.dataUrl,
    `data:image/png;base64,${CORRUPT_PNG.toString("base64")}`,
    "the corrupt image was not returned byte for byte, so the renderer would be told it is missing when it is merely broken",
  );

  // A large image is served whole. No cap, no truncation, no 413.
  assert.equal(
    byLabel["large.png"]?.dataUrl,
    `data:image/png;base64,${LARGE_PNG.toString("base64")}`,
    "a 3 MB image did not round-trip whole, which is the size an ordinary phone photo exceeds",
  );
  assert.equal(byLabel["large.png"]?.width, 1, "the large image lost its dimensions");
});

test("a path outside the sandbox is refused, so the read numbers below mean something", async () => {
  const answer = await call({ path: outside });
  assert.equal(answer.status, 200, "the route answered a request about a path outside the sandbox");
  assert.equal(answer.body, null, "the image route read a file outside the sandbox root");
});

test("the three attachment read commands do not agree about which files they will read", async () => {
  const rows = [];
  for (const [label, file] of Object.entries(surfaces)) {
    rows.push({
      label,
      readImage: (await call({ path: file })).body !== null,
      chunk: (await readHostAttachmentChunk(agentDir, file, 0, 16)) !== null,
      text: (await readAttachmentText(agentDir, file)) !== null,
      owner: resolveAttachmentOwnerDir(file),
    });
  }

  const imageYes = rows.filter((row) => row.readImage).map((row) => row.label);
  const chunkYes = rows.filter((row) => row.chunk).map((row) => row.label);
  assert.equal(
    imageYes.length,
    rows.length,
    `the image route did not read every fixture under the sandbox root: ${JSON.stringify(rows)}`,
  );
  assert.deepEqual(
    chunkYes.sort(),
    ["own assets", "own attachments"].sort(),
    "the chunk leg's own scope changed; the difference measured here is a scope decision, not an accident",
  );

  const imageOnly = rows.filter((row) => row.readImage && !row.chunk).map((row) => row.label);
  assert.ok(
    imageOnly.includes("shared box workspace"),
    `the shared box workspace is where agents write files, and it is the concrete case this measurement is about: ${JSON.stringify(rows)}`,
  );
  for (const row of rows) {
    // The chunk leg is gated on the owner directory AND on the agent it was
    // asked about. Another agent's attachment folder resolves to a real owner
    // directory, and is still refused for this agent — which is the rule, and the
    // reason the earlier draft of this assertion was wrong.
    assert.equal(
      row.owner != null && row.owner.toLowerCase() === agentDir.toLowerCase(),
      row.chunk,
      `${row.label}: the chunk leg reads an agent's own attachments and assets and nothing else, so owner-dir agreement is the whole rule`,
    );
  }
});