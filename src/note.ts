// Reader for Boox .note files: a zip of protobuf shape records and binary point files.
import { unzipSync } from "fflate";

export interface Points {
  x: Float32Array;
  y: Float32Array;
  pressure: Uint16Array;
}

export interface Stroke {
  kind: number; // shape type: 2/21/22 pens, 15 highlighter, 19 image, 33 link, 34 attachment, 38 timestamp stamp
  color: number; // signed ARGB
  width: number;
  created: number; // epoch ms
  bbox: [number, number, number, number] | null; // left, top, right, bottom, already in page coordinates
  points?: Points;
  image?: string; // archive path (kind 19)
  matrix?: number[]; // row-major 3x3 affine for strokes that were moved/scaled
  text?: string; // label to draw in the box (kinds 33/34/38); bbox is where to draw it
  framed?: boolean; // kind 38: device draws a border around the text
  url?: string; // kind 33, link type URL: the target address
  linkType?: "NOTE" | "DOCUMENT" | "URL"; // kind 33: what the link points at
  attachment?: { path: string; name: string }; // kind 34: archive path and display name of the embedded file
}

export interface Page {
  id: string;
  width: number;
  height: number;
  grid: boolean;
  bgImage?: string;
  strokes: Stroke[];
}

export interface Note {
  pages: Page[];
  files: Record<string, Uint8Array>;
  /** stroke creation times (epoch ms) per page id, over every shape on the page */
  times: Map<string, number[]>;
  gridSvg?: string;
}

const PEN_KINDS = new Set([2, 21, 22]);
const HIGHLIGHTER = 15;
const IMAGE = 19;
const LINK = 33; // the "insert link" widget: to a URL, another notebook, or a document
const ATTACHMENT = 34; // the "insert file" widget: an embedded file (e.g. a .md note)
const TIMESTAMP = 38; // the "insert date/time" stamp widget
const utf8 = new TextDecoder();

interface Field {
  f: number;
  w: number;
  n: bigint; // wire type 0
  b: Uint8Array; // wire types 1, 2, 5
}

function* fields(buf: Uint8Array): Generator<Field> {
  let i = 0;
  const varint = (): bigint => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const c = buf[i++]!;
      r |= BigInt(c & 0x7f) << s;
      s += 7n;
      if (!(c & 0x80)) return r;
    }
  };
  const none = new Uint8Array(0);
  while (i < buf.length) {
    const k = Number(varint());
    const f = k >> 3;
    const w = k & 7;
    if (w === 0) yield { f, w, n: varint(), b: none };
    else if (w === 2) {
      const n = Number(varint());
      yield { f, w, n: 0n, b: buf.subarray(i, i + n) };
      i += n;
    } else if (w === 1 || w === 5) {
      const n = w === 1 ? 8 : 4;
      yield { f, w, n: 0n, b: buf.subarray(i, i + n) };
      i += n;
    } else throw new Error(`unsupported protobuf wire type ${w}`);
  }
}

function readPoints(blob: Uint8Array): Map<string, Points> {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Map<string, Points>();
  for (let p = dv.getUint32(blob.length - 4); p < blob.length - 4; p += 44) {
    const id = utf8.decode(blob.subarray(p, p + 36));
    const off = dv.getUint32(p + 36);
    const size = dv.getUint32(p + 40);
    const n = (size - 4) >> 4;
    const pts: Points = { x: new Float32Array(n), y: new Float32Array(n), pressure: new Uint16Array(n) };
    for (let i = 0, o = off + 4; i < n; i++, o += 16) {
      pts.x[i] = dv.getFloat32(o);
      pts.y[i] = dv.getFloat32(o + 4);
      pts.pressure[i] = dv.getUint16(o + 10);
    }
    out.set(id, pts);
  }
  return out;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export async function loadNote(path: string): Promise<Note> {
  const files = unzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const names = Object.keys(files);
  const infoName = names.find((n) => n.endsWith("note/pb/note_info"));
  if (!infoName) throw new Error("not a Boox .note file (no note/pb/note_info)");
  const root = infoName.slice(0, -"note/pb/note_info".length);

  // page order: the longest pageNameList in note_info
  const info = new TextDecoder("latin1").decode(files[infoName]);
  const lists = [...info.matchAll(/\{"pageNameList":\[[^\]]*\]\}/g)].map(
    (m) => JSON.parse(m[0]).pageNameList as string[],
  );
  const order = lists.reduce((a, b) => (b.length > a.length ? b : a), []);

  const pages = new Map<string, Page>();
  for (const id of order) {
    const page: Page = { id, width: 1086, height: 1448, grid: true, strokes: [] };
    const t = files[`${root}template/json/${id}.template_json`];
    if (t) {
      const props = JSON.parse(utf8.decode(t)).properties ?? {};
      page.grid = (props.resourceAttr?.resName ?? "").includes("grid_point");
      const rel: string | undefined = props.imageAttr?.relativePath;
      if (rel?.endsWith(".svg")) page.grid = true;
      else if (rel) page.bgImage = names.find((n) => n.endsWith(rel));
    }
    pages.set(id, page);
  }

  // point files are keyed page#pointsfile; a stroke's field 16 names its points file
  const points = new Map<string, Map<string, Points>>();
  for (const n of names) {
    if (!n.includes("/point/") || !n.endsWith("#points")) continue;
    const pid = basename(n).split("#")[0]!;
    const m = points.get(pid) ?? new Map();
    for (const [k, v] of readPoints(files[n]!)) m.set(k, v);
    points.set(pid, m);
  }

  const times = new Map<string, number[]>();
  for (const n of names) {
    if (!n.includes("/shape/") || !n.endsWith(".zip")) continue;
    const pid = basename(n).split("#")[0]!;
    const page = pages.get(pid);
    const inner = unzipSync(files[n]!);
    const data = inner[Object.keys(inner)[0]!]!;
    const pageTimes = times.get(pid) ?? [];
    times.set(pid, pageTimes);
    for (const top of fields(data)) {
      if (top.w !== 2) continue;
      const r = new Map<number, Field>();
      for (const fl of fields(top.b)) r.set(fl.f, fl);
      const created = Number(r.get(2)?.n ?? 0n);
      if (r.has(2)) pageTimes.push(created);
      if (!page) continue;

      const kind = Number(r.get(12)?.n ?? 0n);
      const width = r.has(5) ? new DataView(r.get(5)!.b.buffer, r.get(5)!.b.byteOffset).getFloat32(0, true) : 0;
      const bb = r.has(7) ? JSON.parse(utf8.decode(r.get(7)!.b)) : null;
      const stroke: Stroke = {
        kind,
        color: Number(BigInt.asIntN(32, r.get(4)?.n ?? 0n)),
        width,
        created,
        bbox: bb ? [bb.left, bb.top, bb.right, bb.bottom] : null,
      };
      if (r.has(8)) stroke.matrix = JSON.parse(utf8.decode(r.get(8)!.b)).values;
      if (kind === IMAGE) {
        const rel = (JSON.parse(utf8.decode(r.get(14)!.b)).relativePath ?? "").replace(/^\/+/, "");
        stroke.image = names.find((x) => x.endsWith("resource/data/" + rel));
      } else if (kind === TIMESTAMP) {
        // the two "points" are just the box's corners, not ink to draw; bbox is already
        // in final page coordinates (it matches the corners with the matrix applied), so
        // the matrix is not needed for placement.
        if (!bb || !r.has(10)) continue;
        const meta = JSON.parse(utf8.decode(r.get(10)!.b));
        stroke.text = meta.timestampBean?.formattedStr;
        stroke.framed = !meta.noFrame;
        if (!stroke.text) continue;
      } else if (kind === LINK) {
        // same corner-marker/bbox situation as the timestamp widget.
        if (!bb || !r.has(10)) continue;
        const meta = JSON.parse(utf8.decode(r.get(10)!.b));
        stroke.linkType = meta.key;
        if (meta.key === "URL") {
          stroke.url = meta.value || meta.remark;
          stroke.text = stroke.url;
        } else {
          stroke.text = meta.docBean?.title;
        }
        if (!stroke.text) continue;
      } else if (kind === ATTACHMENT) {
        if (!bb || !r.has(14)) continue;
        const rel: string = (JSON.parse(utf8.decode(r.get(14)!.b)).relativePath ?? "").replace(/^\/+/, "");
        const path = names.find((x) => x.endsWith("resource/data/" + rel));
        if (!path) continue;
        stroke.attachment = { path, name: rel };
        stroke.text = rel;
      } else if (PEN_KINDS.has(kind) || kind === HIGHLIGHTER) {
        stroke.points = points.get(pid)?.get(utf8.decode(r.get(1)!.b));
        if (!stroke.points) continue;
      } else continue; // templates, references, unknown shapes
      page.strokes.push(stroke);
    }
  }
  for (const p of pages.values()) p.strokes.sort((a, b) => a.created - b.created);

  const svgName = names.find((n) => /(resource\/content|note\/templateRes)\/.*grid.*\.svg$/.test(n));
  return {
    pages: order.map((id) => pages.get(id)!),
    files,
    times,
    gridSvg: svgName ? utf8.decode(files[svgName]) : undefined,
  };
}
