#!/usr/bin/env bun
// Download every Boox .note from a Dropbox folder (via dbxcli) and extract its pages.
import { mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { assignDays, groupByDay, writeDays } from "./days.ts";
import { loadNote } from "./note.ts";
import { renderNote } from "./render.ts";

const HELP = `usage: sync.ts [options] [NOTEBOOK ...]

Download every Boox .note from a Dropbox folder (via dbxcli) and extract its pages.

For each notebook <name>.note this writes, under the output directory:
  <name>/<name>.note                the downloaded file
  <name>/<name>.pdf                 vector PDF, one page per note page
  <name>/by-day/<name>_<date>.pdf   pages grouped by the day they were written
Pass notebook names (without .note, case-insensitive) to process only those.
Unchanged notes (same Dropbox revision) are skipped unless --force.

options:
  -r, --remote <path>     Dropbox folder (default: /onyx/Go6_2/Notebooks)
  -o, --out-dir <dir>     output directory (default: boox-export)
      --force             re-download and re-render even if unchanged
      --day-start <hour>  hour a new day begins (default: 4)
      --min-strokes <n>   ignore a day with fewer strokes on a page (default: 5)
  -h, --help
`;

const { values: a, positionals: names } = parseArgs({
  allowPositionals: true,
  options: {
    remote: { type: "string", short: "r", default: "/onyx/Go6_2/Notebooks" },
    "out-dir": { type: "string", short: "o", default: "boox-export" },
    force: { type: "boolean", default: false },
    "day-start": { type: "string", default: "4" },
    "min-strokes": { type: "string", default: "5" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (a.help) {
  console.log(HELP);
  process.exit(0);
}

function dbxcli(...args: string[]) {
  const r = Bun.spawnSync(["dbxcli", ...args]);
  const out = r.stdout.toString();
  if (r.exitCode) {
    let msg = r.stderr.toString().trim();
    try {
      msg ||= JSON.parse(out).error?.message;
    } catch {}
    throw new Error(msg || `dbxcli ${args.join(" ")} failed`);
  }
  return out;
}

interface LsEntry {
  status: string;
  kind: string;
  result?: { path_display: string; rev?: string };
}

/** [dropbox path, revision] for .note files directly under `remote`. */
function listNotes(remote: string): [string, string][] {
  const listing = JSON.parse(dbxcli("--output", "json", "ls", remote));
  if (!listing.ok) throw new Error(`${listing.error?.message ?? "unknown error"} (dbxcli ls ${remote})`);
  return (listing.results as LsEntry[])
    .filter((e) => e.kind === "file" && e.result?.rev && e.result.path_display.endsWith(".note"))
    .map((e) => [e.result!.path_display, e.result!.rev!]);
}

const stemOf = (p: string) => basename(p, ".note");
const outDir = a["out-dir"]!;
mkdirSync(outDir, { recursive: true });
const stateFile = join(outDir, ".revisions.json");
const state: Record<string, string> = existsSync(stateFile) ? await Bun.file(stateFile).json() : {};

let notes: [string, string][];
try {
  notes = listNotes(a.remote!);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (!notes.length) {
  console.error(`no .note files found in ${a.remote}`);
  process.exit(1);
}
if (names.length) {
  const have = new Map(notes.map((n) => [stemOf(n[0]).toLowerCase(), n]));
  const missing = names.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) {
    console.error(`not found in ${a.remote}: ${missing.join(", ")}\navailable: ${notes.map((n) => stemOf(n[0])).sort().join(", ")}`);
    process.exit(1);
  }
  notes = names.map((n) => have.get(n.toLowerCase())!);
}

const failed: string[] = [];
for (const [remotePath, rev] of notes) {
  const stem = stemOf(remotePath);
  const dir = join(outDir, stem);
  const noteFile = join(dir, `${stem}.note`);
  const pdf = join(dir, `${stem}.pdf`);
  if (!a.force && state[remotePath] === rev && existsSync(pdf)) {
    console.log(`${stem}: up to date`);
    continue;
  }
  console.log(`${stem}: downloading`);
  try {
    mkdirSync(dir, { recursive: true });
    dbxcli("get", remotePath, noteFile);
    const note = await loadNote(noteFile);
    await renderNote(note, pdf);
    const days = groupByDay(assignDays(note, Number(a["day-start"]), Number(a["min-strokes"])));
    if (days.size) {
      mkdirSync(join(dir, "by-day"), { recursive: true });
      await writeDays(pdf, days, join(dir, "by-day"), stem);
    } else console.error("  no dated strokes, skipping by-day split");
  } catch (e) {
    console.error(`  failed: ${e instanceof Error ? e.message : e}`);
    failed.push(stem);
    continue;
  }
  state[remotePath] = rev;
  await Bun.write(stateFile, JSON.stringify(state, null, 1));
}
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
