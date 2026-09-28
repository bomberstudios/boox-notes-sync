// Render a Boox .note to a vector PDF (one PDF page per note page).
import { createWriteStream } from "node:fs";
import PDFDocument from "pdfkit";
import { loadNote, type Note, type Page, type Stroke } from "./note.ts";

const HIGHLIGHT_ALPHA = 0.4;
const MAX_PRESSURE = 4096;

/** Moving average with edge padding; keeps the length. */
function smooth(a: ArrayLike<number>, win: number): Float64Array {
  const n = a.length;
  const out = Float64Array.from(a);
  if (n < 4 || win <= 1) return out;
  const pad = win >> 1;
  const at = (i: number) => a[Math.min(n - 1, Math.max(0, i))]!;
  let sum = 0;
  for (let j = -pad; j < win - pad; j++) sum += at(j);
  for (let i = 0; i < n; i++) {
    out[i] = sum / win;
    sum += at(i + win - pad) - at(i - pad);
  }
  return out;
}

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** Add a filled variable-width outline to the current path; returns the cap centres. */
function outline(doc: PDFKit.PDFDocument, xs: Float64Array, ys: Float64Array, ws: Float64Array): [number, number, number][] {
  const x: number[] = [];
  const y: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i === 0 || Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!) > 1e-3) {
      x.push(xs[i]!);
      y.push(ys[i]!);
      w.push(ws[i]!);
    }
  }
  const n = x.length;
  const caps: [number, number, number][] = [[x[0]!, y[0]!, w[0]! / 2]];
  if (n < 2) return caps;
  caps.push([x[n - 1]!, y[n - 1]!, w[n - 1]! / 2]);

  const lx: number[] = [];
  const ly: number[] = [];
  const rx: number[] = [];
  const ry: number[] = [];
  for (let i = 0; i < n; i++) {
    // central-difference tangent, one-sided at the ends (like numpy.gradient)
    const a = i === 0 ? 0 : i - 1;
    const b = i === n - 1 ? n - 1 : i + 1;
    const scale = a === i || b === i ? 1 : 2;
    const tx = (x[b]! - x[a]!) / scale;
    const ty = (y[b]! - y[a]!) / scale;
    const len = Math.max(Math.hypot(tx, ty), 1e-9);
    const nx = (-ty / len) * (w[i]! / 2);
    const ny = (tx / len) * (w[i]! / 2);
    lx.push(x[i]! + nx);
    ly.push(y[i]! + ny);
    rx.push(x[i]! - nx);
    ry.push(y[i]! - ny);
  }
  doc.moveTo(lx[0]!, ly[0]!);
  for (let i = 1; i < n; i++) doc.lineTo(lx[i]!, ly[i]!);
  for (let i = n - 1; i >= 0; i--) doc.lineTo(rx[i]!, ry[i]!);
  doc.closePath();
  return caps;
}

function drawGrid(doc: PDFKit.PDFDocument, page: Page, svg: string) {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return;
  const sx = page.width / Number(vb[1]);
  const sy = page.height / Number(vb[2]);
  for (const m of svg.matchAll(/<circle[^>]*cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g))
    doc.circle(Number(m[1]) * sx, Number(m[2]) * sy, Number(m[3]) * sx * 0.6);
  doc.fillColor([153, 153, 153]).fill();
}

function drawStroke(doc: PDFKit.PDFDocument, s: Stroke) {
  const pts = s.points!;
  const n = pts.x.length;
  let x: Float64Array = Float64Array.from(pts.x);
  let y: Float64Array = Float64Array.from(pts.y);
  if (s.matrix) {
    const [a, b, tx, c, d, ty] = s.matrix as [number, number, number, number, number, number];
    if (!(a === 1 && b === 0 && tx === 0 && c === 0 && d === 1 && ty === 0)) {
      for (let i = 0; i < n; i++) {
        const px = x[i]!;
        const py = y[i]!;
        x[i] = a * px + b * py + tx;
        y[i] = c * px + d * py + ty;
      }
    }
  }
  x = smooth(x, 5);
  y = smooth(y, 5);
  const ws = new Float64Array(n);
  if (s.kind === 15) {
    ws.fill(s.width);
    doc.fillColor(rgb(s.color), HIGHLIGHT_ALPHA);
    outline(doc, x, y, ws); // flat ends, no caps
    doc.fill("nonzero");
    return;
  }
  const pr = smooth(pts.pressure, 9);
  for (let i = 0; i < n; i++) ws[i] = s.width * (0.65 + 0.5 * Math.sqrt(Math.min(Math.max(pr[i]! / MAX_PRESSURE, 0), 1)));
  doc.fillColor(rgb(s.color), 1);
  const caps = outline(doc, x, y, ws);
  doc.fill("nonzero"); // caps go in their own path: opposite winding would punch holes in the outline
  for (const [cx, cy, r] of caps) doc.circle(cx, cy, r);
  doc.fill();
}

function drawTimestamp(doc: PDFKit.PDFDocument, s: Stroke) {
  const [l, t, r, b] = s.bbox!;
  const w = r - l;
  const h = b - t;
  if (s.framed) {
    doc.rect(l, t, w, h).lineWidth(Math.max(s.width, 1)).strokeColor(rgb(s.color)).stroke();
  }
  const pad = h * 0.15;
  const fontSize = Math.min(h - 2 * pad, w / (s.text!.length * 0.6));
  doc
    .fillColor(rgb(s.color), 1)
    .fontSize(fontSize)
    .text(s.text!, l, t + (h - fontSize) / 2, { width: w, align: "center", lineBreak: false });
}

function drawPage(doc: PDFKit.PDFDocument, page: Page, note: Note) {
  doc.addPage({ size: [page.width, page.height], margin: 0 });
  if (page.bgImage) doc.image(Buffer.from(note.files[page.bgImage]!), 0, 0, { width: page.width, height: page.height });
  else if (page.grid && note.gridSvg) drawGrid(doc, page, note.gridSvg);
  // highlighter goes under everything else, like a multiply blend on the device
  const strokes = [...page.strokes].sort((a, b) => Number(a.kind !== 15) - Number(b.kind !== 15));
  for (const s of strokes) {
    if (s.kind === 19) {
      if (s.image && s.bbox) {
        const [l, t, r, b] = s.bbox;
        doc.image(Buffer.from(note.files[s.image]!), l, t, { width: r - l, height: b - t });
      }
    } else if (s.kind === 38) {
      if (s.text && s.bbox) drawTimestamp(doc, s);
    } else drawStroke(doc, s);
  }
}

export async function renderNote(note: Note, out: string, only?: Set<number>, log = false) {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true });
  const done = new Promise<void>((res, rej) => {
    const ws = createWriteStream(out);
    ws.on("finish", () => res());
    ws.on("error", rej);
    doc.pipe(ws);
  });
  note.pages.forEach((page, i) => {
    if (only && !only.has(i + 1)) return;
    drawPage(doc, page, note);
    if (log) console.error(`page ${i + 1}/${note.pages.length}: ${page.strokes.length} strokes`);
  });
  doc.end();
  await done;
}

function parsePages(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [lo, hi] = part.split("-");
    for (let i = Number(lo); i <= Number(hi ?? lo); i++) out.add(i);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--pages");
  const only = pi >= 0 ? parsePages(args.splice(pi, 2)[1]!) : undefined;
  const [input, output] = args;
  if (!input) {
    console.error("usage: render.ts <file.note> [out.pdf] [--pages 1,13,20-22]");
    process.exit(2);
  }
  await renderNote(await loadNote(input), output ?? input.replace(/\.note$/, ".vector.pdf"), only, true);
}
