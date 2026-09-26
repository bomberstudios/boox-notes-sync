// Group note pages by the day they were written, and write one PDF per day.
import { PDFDocument } from "pdf-lib";
import type { Note } from "./note.ts";

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Map page number (1-based) -> dates (ISO strings, sorted).
 *
 * A page written on several days maps to all of them. A stroke written before `dayStart`
 * o'clock counts toward the previous day, and days with fewer than `minStrokes` strokes on a
 * page are ignored. Pages with no strokes (drawings or images) inherit the previous page's
 * last date.
 */
export function assignDays(note: Note, dayStart = 4, minStrokes = 5): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let last: string | undefined;
  note.pages.forEach((page, i) => {
    const counts = new Map<string, number>();
    for (const t of note.times.get(page.id) ?? []) {
      const d = iso(new Date(t - dayStart * 3600_000));
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let dates = [...counts].filter(([, c]) => c >= minStrokes).map(([d]) => d).sort();
    if (!dates.length && last) {
      dates = [last];
      console.error(`  note: page ${i + 1} has no strokes, using ${last}`);
    }
    out.set(i + 1, dates);
    last = dates.at(-1) ?? last;
  });
  return out;
}

export function groupByDay(mapping: Map<number, string[]>): Map<string, number[]> {
  const days = new Map<string, number[]>();
  for (const [pg, ds] of mapping) for (const d of ds) days.set(d, [...(days.get(d) ?? []), pg]);
  return new Map([...days].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Write <stem>_<date>.pdf for each day, with the given 1-based pages of `srcPdf`. */
export async function writeDays(srcPdf: string, days: Map<string, number[]>, outDir: string, stem: string) {
  const src = await PDFDocument.load(await Bun.file(srcPdf).arrayBuffer());
  for (const [day, pages] of days) {
    const doc = await PDFDocument.create();
    for (const p of await doc.copyPages(src, pages.map((n) => n - 1))) doc.addPage(p);
    const name = `${stem}_${day}.pdf`;
    await Bun.write(`${outDir}/${name}`, await doc.save());
    console.log(`wrote ${name} (${pages.length} pages)`);
  }
}
