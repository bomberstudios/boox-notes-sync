# Boox Notes Sync

> [!NOTE]
> **This tool is written using AI tools.** If you hate that (or are ambivalent about it like myself), you may want to skip this project.

I *love* my Boox Go6 Gen2. However, I hate that its Notes app doesn't sync with my (pretty particular) note system in other devices.

So I asked Claude to make this tool. It will pull handwritten notebooks off Dropbox and turn them into "clean" vector PDFs, split by the day each page was written. Two words here are doing some heavy lifting:

- **Handwritten** means I have 0 text blocks on my notes. I have _no idea_ how they'll render in the export because I don't use them on my notes.I didn't buy an eink device with a stylus to _use a keyboard, like an animal_
- **Clean** is used very liberally. If you're doing art sketches with your Boox, this tool will 100% murder your drawings with its smoothing algorithm 😅

The app assumes you've set up your Boox device to sync to Dropbox, and store Notes in Boox's proprietary `.note` format. The format is a zip file with a bunch of stuff inside, that allows us to reconstruct the vector output with a bit of AI-assisted reverse engineering. It also stores timestamp data, which is *great* because I work with large notebooks, but want to split them by day automatically.

My plan is to run this daily, and store the partial, daily PDF files on my Obsidian-like vault, linked to the relevant dates. But if your use case is different, the tool also saves a single PDF with all the pages for each notebook.

## Requirements

- [Bun](https://bun.sh) 1.x
- [dbxcli](https://github.com/dropbox/dbxcli), logged in to the Dropbox account your Boox syncs to (`dbxcli account` should print your account)

## Setup

```bash
bun install
dbxcli account   # first run walks you through Dropbox authorization
```

Optionally build a standalone executable (no Bun needed to run it, but `dbxcli` still is):

```bash
bun run build    # writes dist/boox-sync
```

## Usage

Search Dropbox under `/onyx` for every `.note` file (at any depth), render each one, and split it by day:

```bash
bun run sync
```

Only some notebooks (names without `.note`, case-insensitive; `device/name` also works):

```bash
bun run sync Journal
bun run sync Journal "Asuntos Pendientes"
bun run sync Go6_2/Journal
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `-r, --remote` | `/onyx` | Dropbox folder to search recursively for `.note` files |
| `-o, --out-dir` | `boox-export` | Where output is written |
| `--force` | off | Re-download and re-render even if unchanged |
| `--day-start` | `4` | Hour a new day begins, so late-night writing counts toward the previous day |
| `--min-strokes` | `5` | Ignore a day with fewer strokes than this on a page (stray edits) |

### Output

```
boox-export/
  Go6_2/                          one folder per device (the first folder under /onyx)
    Journal/
      Journal.note                the downloaded file
      Journal.pdf                 vector PDF, one page per note page
      by-day/
        Journal_2026-09-05.pdf
        Journal_2026-09-06.pdf
        ...
    Habits/
      ...
  <another device>/
    ...
```

- Boox devices sync to `/onyx/<device>/...`, so the device name comes from the Dropbox path. Notes directly under `/onyx`, or found via a different `--remote`, go in `unknown/`.
- If two notes on the same device share a name (say `Notebooks/Journal.note` and `Archive/Journal.note`), the folders below the device are added to the name (`Archive-Journal`).

- A page written on more than one day appears in each of those days' files.
- A page with no strokes (only an image, say) takes the previous page's date.
- Re-runs skip notebooks whose Dropbox revision hasn't changed (tracked in `boox-export/.revisions.json`).
- If one notebook fails, the others still run, and the exit status is non-zero.

### Rendering a Local `.note`

To render a `.note` you already have, without Dropbox:

```bash
bun run render Journal.note                        # writes Journal.vector.pdf
bun run render Journal.note out.pdf --pages 1,13,20-22
```

## How It Works

| File | Role |
|---|---|
| `src/sync.ts` | The CLI: lists and downloads from Dropbox, then renders and splits each notebook |
| `src/render.ts` | Draws pages to PDF with [pdfkit](https://pdfkit.org) |
| `src/days.ts` | Assigns each page to the day(s) it was written and writes the per-day PDFs with [pdf-lib](https://pdf-lib.js.org) |
| `src/note.ts` | Reads the `.note` format (zip via [fflate](https://github.com/101arrowz/fflate)) |

A `.note` is a zip archive. What the code relies on:

- `note/pb/note_info` holds the page order (`pageNameList`).
- `shape/<page>#<id>#<ts>.zip` holds one protobuf message per stroke: id (field 1), creation time (2), colour (4, ARGB), width (5, float), bounding box (7), optional 3x3 affine matrix (8, for strokes that were moved or scaled), shape type (12) and points-file id (16).
- `point/<page>/<page>#<id>#points` holds the point data. It starts with a 76-byte header. Each stroke is a 4-byte header followed by 16-byte records: big-endian float32 `x`, `y`, two uint16 values (the second is pressure, up to 4096) and a uint32 time offset in ms. An index of `(stroke id, offset, size)` entries sits at the end, and the last four bytes of the file give the index offset.
- `template/json/<page>.template_json` names the page background: an SVG dot grid or an image under `note/templateRes/`.

Stroke types handled: 2, 21 and 22 (pens), 15 (highlighter) and 19 (inserted images). Others, such as template layouts and cross-page references, are skipped.

## Caveats

- The `.note` format is undocumented and reverse-engineered from exports from a Boox Go 6. A firmware update could change it.
- Pressure-to-width mapping is a visual approximation of the device's rendering, not an exact match.
- Only `.note` files are used; the PDFs and other files that Boox syncs alongside them are ignored.

## Acknowledgments

- Thanks to <https://github.com/RobertCsordas/OnyxNoteRenderer> for the inspiration about reverse-engineering the `.note` format, and for some path smoothing code.
