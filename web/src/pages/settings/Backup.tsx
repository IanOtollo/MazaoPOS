import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { get } from "../../lib/api";
import { Button } from "../../lib/ui";
import { useToast } from "../../lib/toast";
import { downloadCsv } from "../../lib/csv";
import { brandOr, useBrand } from "../../lib/brand";

interface Meta { key: string; label: string; group: string; about: string }
interface Count { rows: number; capped: boolean }
type Row = Record<string, unknown>;

const stamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Reads every page of one dataset. The server hands out 400 rows at a time with a cursor to continue from. */
async function fetchAll(key: string, onPage?: (rows: number) => void): Promise<Row[]> {
  const all: Row[] = [];
  let cursor = "";
  for (let guard = 0; guard < 2000; guard++) {
    const p = await get<{ rows: Row[]; cursor: string; done: boolean }>(`/api/backup/${key}?cursor=${encodeURIComponent(cursor)}`);
    all.push(...p.rows);
    onPage?.(all.length);
    if (p.done) return all;
    cursor = p.cursor;
  }
  throw new Error("The export did not finish. Try again.");
}

function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** A spreadsheet cell: plain values as they are, times as readable dates, nested lists and objects as JSON text. */
function cell(key: string, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && /(At|Time)$/.test(key) && v > 1e11) return new Date(v).toISOString();
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return JSON.stringify(v);
}

export function Backup() {
  const toast = useToast();
  const biz = brandOr(useBrand());
  const [meta, setMeta] = useState<Meta[]>([]);
  const [counts, setCounts] = useState<Record<string, Count>>({});
  const [busy, setBusy] = useState<string | null>(null); // "all" or a dataset key
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let live = true;
    get<{ datasets: Meta[] }>("/api/backup/summary").then((r) => {
      if (!live) return;
      setMeta(r.datasets);
      // one small call per dataset, so each count arrives as soon as it is ready
      r.datasets.forEach((d) => get<{ rows: number; capped: boolean }>(`/api/backup/${d.key}/count`)
        .then((c) => live && setCounts((x) => ({ ...x, [d.key]: { rows: c.rows, capped: c.capped } }))).catch(() => {}));
    }).catch((e) => toast({ msg: (e as Error).message, kind: "err" }));
    return () => { live = false; };
  }, [toast]);

  const groups = useMemo(() => [...new Set(meta.map((m) => m.group))], [meta]);
  const totalRows = meta.reduce((a, m) => a + (counts[m.key]?.rows ?? 0), 0);
  const counted = meta.length > 0 && meta.every((m) => counts[m.key]);

  const downloadAll = async () => {
    setBusy("all"); setDone("");
    try {
      const datasets: Record<string, Row[]> = {};
      let rows = 0;
      for (let i = 0; i < meta.length; i++) {
        const m = meta[i];
        setProgress(`Collecting ${m.label.toLowerCase()}… ${i + 1} of ${meta.length}`);
        datasets[m.key] = await fetchAll(m.key);
        rows += datasets[m.key].length;
      }
      const text = JSON.stringify({ exportedAt: new Date().toISOString(), business: biz, datasets }, null, 1);
      saveFile(`mazaopos-backup-${stamp()}.json`, text, "application/json");
      setDone(`Saved ${rows.toLocaleString("en-KE")} rows from ${meta.length} data sets (${fmtBytes(text.length)}).`);
    } catch (e) {
      toast({ msg: (e as Error).message, kind: "err" });
    }
    setBusy(null); setProgress("");
  };

  const downloadOne = async (m: Meta) => {
    setBusy(m.key); setDone("");
    try {
      setProgress(`Collecting ${m.label.toLowerCase()}…`);
      const rows = await fetchAll(m.key, (n) => setProgress(`Collecting ${m.label.toLowerCase()}… ${n.toLocaleString("en-KE")} rows`));
      if (!rows.length) { toast({ msg: `There is nothing in ${m.label.toLowerCase()} yet`, kind: "info" }); }
      else {
        const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        downloadCsv(`mazaopos-${m.key}-${stamp()}.csv`, header, rows.map((r) => header.map((k) => cell(k, r[k]))));
        setDone(`Saved ${m.label.toLowerCase()}: ${rows.length.toLocaleString("en-KE")} rows.`);
      }
    } catch (e) {
      toast({ msg: (e as Error).message, kind: "err" });
    }
    setBusy(null); setProgress("");
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-line rounded-xl shadow-card p-5">
        <h2 className="font-semibold text-base">Your data is safe</h2>
        <p className="text-slate-600 mt-1">Your data is stored in the cloud and every change is saved the moment it happens. Download a copy any time for your own records.</p>
      </section>

      <section className="rounded-xl border border-blue-200 bg-blue-50 p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-lg">Download everything</h2>
          <p className="text-sm text-slate-600">
            One file with all {meta.length || ""} data sets below{counted ? `, about ${totalRows.toLocaleString("en-KE")} rows in all` : ""}. It can be large if the shop has been trading for a long time.
          </p>
          <p className="text-sm font-medium mt-1 min-h-5" aria-live="polite">{progress || done}</p>
        </div>
        <Button variant="primary" onClick={downloadAll} disabled={busy !== null || !meta.length} className="inline-flex items-center gap-2 !py-3">
          <Download className="size-4" aria-hidden />{busy === "all" ? "Downloading" : "Download everything"}
        </Button>
      </section>

      {groups.map((g) => (
        <section key={g}>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">{g}</h3>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {meta.filter((m) => m.group === g).map((m) => {
              const c = counts[m.key];
              return (
                <div key={m.key} className="bg-white border border-line rounded-xl shadow-card p-4 flex flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="font-semibold">{m.label}</h4>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-600">{c ? `${c.rows.toLocaleString("en-KE")}${c.capped ? "+" : ""} rows` : "…"}</span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1 flex-1">{m.about}</p>
                  <Button onClick={() => downloadOne(m)} disabled={busy !== null} className="mt-3 inline-flex items-center justify-center gap-2 !py-2">
                    <Download className="size-4" aria-hidden />{busy === m.key ? "Downloading" : "Download CSV"}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <p className="text-sm text-slate-500">To restore or move data to another system, send these files to your system administrator.</p>
    </div>
  );
}
