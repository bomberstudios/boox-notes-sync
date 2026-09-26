#!/usr/bin/env bun
// Download every Boox .note under a Dropbox folder (via dbxcli) and extract its pages.
import { mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { assignDays, groupByDay, writeDays } from "./days.ts";
import { loadNote } from "./note.ts";
import { renderNote } from "./render.ts";

const HELP = `usage: sync.ts [options] [NOTEBOOK ...]

Download every Boox .note under a Dropbox folder (via dbxcli) and extract its pages.
The folder is searched recursively for anything ending in .note. Boox devices sync to
/onyx/<device>/..., so notes are grouped into one output folder per device.

For each notebook <name>.note this writes, under the output directory:
  <device>/<name>/<name>.note                the downloaded file
  <device>/<name>/<name>.pdf                 vector PDF, one page per note page
  <device>/<name>/by-day/<name>_<date>.pdf   pages grouped by the day they were written
Pass notebook names (without .note, case-insensitive; "device/name" also works) to process
only those. Unchanged notes (same Dropbox revision) are skipped unless --force.

options:
  -r, --remote <path>     Dropbox folder to search (default: /onyx)
  -o, --out-dir <dir>     output directory (default: boox-export)
      --force             re-download and re-render even if unchanged
      --day-start <hour>  hour a new day begins (default: 4)
      --min-strokes <n>   ignore a day with fewer strokes on a page (default: 5)
  -h, --help
`;

const { values: a, positionals: names } = parseArgs({
  allowPositionals: true,
  options: {
    remote: { type: "string", short: "r", default: "/onyx" },
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

interface RemoteNote {
  path: string; // Dropbox path
  rev: string;
  device: string; // first folder under /onyx
  name: string; // unique within the device, used as the output folder
}

/** Every file ending in .note under `remote`, however deeply nested. */
function listNotes(remote: string): RemoteNote[] {
  const listing = JSON.parse(dbxcli("--output", "json", "ls", "--recursive", remote));
  if (!listing.ok) throw new Error(`${listing.error?.message ?? "unknown error"} (dbxcli ls ${remote})`);
  const found = (listing.results as LsEntry[])
    .filter((e) => e.kind === "file" && e.result?.rev && e.result.path_display.toLowerCase().endsWith(".note"))
    .map((e) => ({ path: e.result!.path_display, rev: e.result!.rev! }));

  const parts = (p: string) => p.split("/").filter(Boolean);
  const deviceOf = (p: string) => {
    const [root, dev] = parts(p);
    return root?.toLowerCase() === "onyx" && parts(p).length > 2 ? dev! : "unknown";
  };
  const stem = (p: string) => basename(p).replace(/\.note$/i, "");
  const count = new Map<string, number>();
  for (const f of found) {
    const k = `${deviceOf(f.path)}/${stem(f.path)}`.toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return found.map((f) => {
    const device = deviceOf(f.path);
    let name = stem(f.path);
    if (count.get(`${device}/${name}`.toLowerCase())! > 1) {
      // same name in different folders: prefix the folders below the device
      const dirs = parts(f.path).slice(2, -1);
      name = [...dirs, name].join("-");
    }
    return { ...f, device, name };
  });
}

const outDir = a["out-dir"]!;
mkdirSync(outDir, { recursive: true });
const stateFile = join(outDir, ".revisions.json");
const state: Record<string, string> = existsSync(stateFile) ? await Bun.file(stateFile).json() : {};

let notes: RemoteNote[];
try {
  notes = listNotes(a.remote!);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (!notes.length) {
  console.error(`no .note files found under ${a.remote}`);
  process.exit(1);
}
if (names.length) {
  const labels = (n: RemoteNote) => [n.name.toLowerCase(), `${n.device}/${n.name}`.toLowerCase()];
  const wanted = names.map((n) => n.toLowerCase());
  const missing = names.filter((n) => !notes.some((x) => labels(x).includes(n.toLowerCase())));
  if (missing.length) {
    console.error(`not found under ${a.remote}: ${missing.join(", ")}\navailable: ${notes.map((n) => `${n.device}/${n.name}`).sort().join(", ")}`);
    process.exit(1);
  }
  notes = notes.filter((x) => labels(x).some((l) => wanted.includes(l)));
}

const failed: string[] = [];
for (const { path: remotePath, rev, device, name: stem } of notes) {
  const label = `${device}/${stem}`;
  const dir = join(outDir, device, stem);
  const noteFile = join(dir, `${stem}.note`);
  const pdf = join(dir, `${stem}.pdf`);
  if (!a.force && state[remotePath] === rev && existsSync(pdf)) {
    console.log(`${label}: up to date`);
    continue;
  }
  console.log(`${label}: downloading`);
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
    failed.push(label);
    continue;
  }
  state[remotePath] = rev;
  await Bun.write(stateFile, JSON.stringify(state, null, 1));
}
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
