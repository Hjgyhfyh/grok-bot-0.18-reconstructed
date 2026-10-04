/**
 * Graphite notes MCP server.
 *
 * Gives an agent its own personal notes system over a local Graphite vault —
 * the user's own notes project, `graphite-lite`. No credentials and no network:
 * everything is plain markdown on disk, so this server works with no account.
 *
 * Vault layout, confirmed against
 * `C:\Users\user\graphite-lite-test-vault`:
 *   <vault>/<folder>/<Title>.md
 *   <vault>/.graphite/    application metadata (index.db, history, journal)
 *   <vault>/.trash/       deleted notes, kept by Graphite itself
 *
 * Note format is YAML frontmatter followed by markdown:
 *   ---
 *   id: 01M2G39EB5ZGXV4W66HFY6A6Y8
 *   type: note
 *   title: "О библиотеке"
 *   status: inbox
 *   created: 2026-09-14T13:56:45.029Z
 *   updated: 2026-09-14T13:56:45.029Z
 *   ---
 *   # О библиотеке
 *
 * Configuration — the vault comes from the environment, never from argv, because
 * `McpServerConfig.env` is the only field a server can be given a path through:
 *   { "command": "node", "args": ["...\\graphite-notes-mcp-server.mjs"],
 *     "env": { "GRAPHITE_VAULT": "C:\\Users\\user\\graphite-lite" } }
 *
 * Set `GRAPHITE_VAULT` to a scratch copy while testing. This server writes files.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { serveStdio, textResult } from "../mcp-stdio-core.mjs";

const vault = process.env.GRAPHITE_VAULT?.trim();
if (vault === undefined || vault.length === 0) {
  process.stderr.write("GRAPHITE_VAULT is not set. Point it at a Graphite vault directory.\n");
  process.exit(1);
}
const vaultRoot = path.resolve(vault);
if (!existsSync(vaultRoot)) {
  process.stderr.write(`GRAPHITE_VAULT does not exist: ${vaultRoot}\n`);
  process.exit(1);
}

/** Directories Graphite owns; an agent must not read or write them as notes. */
const RESERVED_DIRECTORIES = new Set([".graphite", ".trash", "_assets", "node_modules", ".git"]);
const DEFAULT_FOLDER = process.env.GRAPHITE_INBOX?.trim() || "Входящие";

/** Refuses to leave the vault. Guards against `..` and absolute paths in tool args. */
function resolveInsideVault(...segments) {
  const target = path.resolve(vaultRoot, ...segments);
  const relative = path.relative(vaultRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes the vault: ${segments.join("/")}`);
  }
  const first = relative.split(path.sep)[0];
  if (first.length > 0 && RESERVED_DIRECTORIES.has(first)) {
    throw new Error(`"${first}" is reserved by Graphite and is not a notes folder`);
  }
  return target;
}

/** Strips characters Windows rejects in a filename, without touching Cyrillic. */
function safeFileName(raw) {
  const cleaned = String(raw).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  if (cleaned.length === 0) throw new Error("note name is empty after sanitisation");
  return `${cleaned}.md`;
}

/** Graphite ids are lexicographically sortable ULIDs; 26 Crockford base32 chars. */
function newNoteId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let i = 0; i < 10; i += 1) time += alphabet[Math.floor(Math.random() * 32)];
  const random = randomBytes(16);
  let tail = "";
  for (const byte of random) tail += alphabet[byte % 32];
  return time + tail;
}

/**
 * Parses the frontmatter block without a YAML dependency.
 *
 * Handles exactly the scalar fields Graphite writes. A dependency would be the
 * only one in this server, and the note format is flat.
 */
function parseNote(contents) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents);
  if (match == null) return { frontmatter: {}, body: contents };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key.length > 0) frontmatter[key] = value;
  }
  return { frontmatter, body: contents.slice(match[0].length) };
}

function renderNote({ title, status, id, created, updated }, body) {
  return [
    "---",
    `id: ${id}`,
    "type: note",
    `title: "${title}"`,
    `status: ${status}`,
    `created: ${created}`,
    `updated: ${updated}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

async function walkNotes(directory, collected = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (RESERVED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkNotes(full, collected);
    else if (entry.isFile() && entry.name.endsWith(".md")) collected.push(full);
  }
  return collected;
}

/** Indexes every note once per call. A vault of this size stays well under a second. */
async function indexNotes() {
  const files = await walkNotes(vaultRoot);
  const notes = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    const { frontmatter, body } = parseNote(contents);
    notes.push({
      id: frontmatter.id ?? "",
      title: frontmatter.title ?? path.basename(file, ".md"),
      status: frontmatter.status ?? "",
      updated: frontmatter.updated ?? "",
      folder: path.relative(vaultRoot, path.dirname(file)).split(path.sep).join("/"),
      path: path.relative(vaultRoot, file).split(path.sep).join("/"),
      body,
    });
  }
  return notes;
}

/** Writes a note, creating its folder. Used by create and append. */
async function writeNote(folder, title, body, { status, mode }) {
  const fileName = safeFileName(title);
  const relative = path.join(folder, fileName);
  const target = resolveInsideVault(relative);
  const now = new Date().toISOString();

  if (mode === "append") {
    let existing = "";
    try {
      existing = await readFile(target, "utf8");
    } catch {
      existing = "";
    }
    const { frontmatter } = parseNote(existing);
    const rendered = renderNote({
      title: frontmatter.title ?? title,
      status: frontmatter.status ?? status ?? "inbox",
      id: frontmatter.id ?? newNoteId(),
      created: frontmatter.created ?? now,
      updated: now,
    }, `${parseNote(existing).body.trim()}\n\n${body.trim()}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rendered, "utf8");
    return { path: relative.split(path.sep).join("/"), mode: "appended" };
  }

  if (mode === "overwrite" && existsSync(target)) {
    const existing = parseNote(await readFile(target, "utf8"));
    const rendered = renderNote({
      title: existing.frontmatter.title ?? title,
      status: existing.frontmatter.status ?? status ?? "inbox",
      id: existing.frontmatter.id ?? newNoteId(),
      created: existing.frontmatter.created ?? now,
      updated: now,
    }, body);
    await writeFile(target, rendered, "utf8");
    return { path: relative.split(path.sep).join("/"), mode: "overwritten" };
  }

  const rendered = renderNote({ title, status: status ?? "inbox", id: newNoteId(), created: now, updated: now }, body);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rendered, "utf8");
  return { path: relative.split(path.sep).join("/"), mode: "created" };
}

serveStdio({
  name: "graphite-notes",
  version: "1.0.0",
  instructions: `Personal notes in a local Graphite vault at ${vaultRoot}. Folders are top-level directories; notes are markdown with YAML frontmatter.`,
  tools: [
    {
      name: "list_notes",
      description: "List notes in the vault, newest first. Optionally restrict to one folder.",
      inputSchema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder name to restrict to. Omit for the whole vault." },
          limit: { type: "number", description: "Maximum notes to return (default 50)." },
        },
      },
    },
    {
      name: "read_note",
      description: "Read one note by its vault-relative path, e.g. \"Входящие/Заметка.md\".",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Vault-relative path of the note." } },
        required: ["path"],
      },
    },
    {
      name: "search_notes",
      description: "Find notes whose title or body contains the query. Case-insensitive.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to look for." },
          limit: { type: "number", description: "Maximum notes to return (default 25)." },
        },
        required: ["query"],
      },
    },
    {
      name: "create_note",
      description: "Create a new markdown note in a folder. Fails if the note already exists unless mode is overwrite.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title; also the file name." },
          body: { type: "string", description: "Markdown body. The title heading is added automatically." },
          folder: { type: "string", description: `Folder to create the note in (default ${DEFAULT_FOLDER}).` },
          status: { type: "string", description: "Frontmatter status, usually inbox." },
          mode: { type: "string", description: "\"overwrite\" replaces an existing note instead of failing." },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "append_note",
      description: "Append text to an existing note, or create it when missing. Keeps the original creation time.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title; also the file name." },
          body: { type: "string", description: "Markdown to append." },
          folder: { type: "string", description: `Folder holding the note (default ${DEFAULT_FOLDER}).` },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "list_folders",
      description: "List the top-level note folders in the vault.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  async onCall(toolName, args) {
    switch (toolName) {
      case "list_notes": {
        const notes = await indexNotes();
        const filtered = args.folder == null
          ? notes
          : notes.filter((note) => note.folder === args.folder || note.folder.startsWith(`${args.folder}/`));
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 50;
        return filtered
          .slice()
          .sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
          .slice(0, limit)
          .map((note) => `${note.path}\n  title=${note.title} status=${note.status} updated=${note.updated}`);
      }
      case "read_note": {
        const target = resolveInsideVault(args.path);
        if (!existsSync(target)) throw new Error(`note not found: ${args.path}`);
        return await readFile(target, "utf8");
      }
      case "search_notes": {
        const needle = String(args.query).toLowerCase();
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 25;
        const hits = [];
        for (const note of await indexNotes()) {
          if (hits.length >= limit) break;
          const inTitle = note.title.toLowerCase().includes(needle);
          const position = note.body.toLowerCase().indexOf(needle);
          if (!inTitle && position === -1) continue;
          const excerpt = position === -1 ? "" : ` ...${note.body.slice(Math.max(0, position - 40), position + 120).replace(/\s+/g, " ").trim()}...`;
          hits.push(`${note.path}\n  title=${note.title}${excerpt}`);
        }
        return hits.length === 0 ? `No notes match "${args.query}".` : hits.join("\n");
      }
      case "create_note": {
        if (args.mode === "overwrite") {
          return textResult(JSON.stringify(await writeNote(args.folder ?? DEFAULT_FOLDER, args.title, args.body, { status: args.status, mode: "overwrite" }), null, 2));
        }
        const target = resolveInsideVault(args.folder ?? DEFAULT_FOLDER, safeFileName(args.title));
        if (existsSync(target)) {
          throw new Error(`note already exists: ${args.title}. Use append_note, or pass mode "overwrite".`);
        }
        return textResult(JSON.stringify(await writeNote(args.folder ?? DEFAULT_FOLDER, args.title, args.body, { status: args.status, mode: "create" }), null, 2));
      }
      case "append_note":
        return textResult(JSON.stringify(await writeNote(args.folder ?? DEFAULT_FOLDER, args.title, args.body, { status: args.status, mode: "append" }), null, 2));
      case "list_folders": {
        const entries = await readdir(vaultRoot, { withFileTypes: true });
        const folders = entries.filter((entry) => entry.isDirectory() && !RESERVED_DIRECTORIES.has(entry.name)).map((entry) => entry.name);
        return folders.length === 0 ? "The vault has no note folders yet." : folders.join("\n");
      }
      default:
        throw new Error(`unhandled tool: ${toolName}`);
    }
  },
});