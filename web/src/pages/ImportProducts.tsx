import { useRef, useState } from "react";
import { Download, FileSpreadsheet, TriangleAlert } from "lucide-react";
import { post } from "../lib/api";
import { Button, ErrorLine, Modal } from "../lib/ui";

/** Minimal CSV parser: quoted fields, escaped quotes, CRLF, comma or semicolon separators. */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const sep = (clean.split("\n")[0].match(/;/g)?.length ?? 0) > (clean.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (q) {
      if (c === '"' && clean[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

// spreadsheet header (lower-cased, punctuation stripped) -> field the server expects
const HEADERS: Record<string, string> = {
  name: "name", item: "name", product: "name", description: "name", productname: "name", itemname: "name",
  sku: "sku", code: "sku", itemcode: "sku", productcode: "sku",
  barcode: "barcode", ean: "barcode",
  category: "category", group: "category",
  unit: "unit", uom: "unit",
  vat: "vat", tax: "vat", vatrate: "vat",
  cost: "cost", costprice: "cost", buyingprice: "cost", buying: "cost",
  price: "retail", retail: "retail", retailprice: "retail", sellingprice: "retail", selling: "retail",
  contractor: "contractor", contractorprice: "contractor",
  wholesale: "wholesale", wholesaleprice: "wholesale",
  reorder: "reorder", reorderlevel: "reorder", minstock: "reorder",
  stock: "shopStock", shopstock: "shopStock", qty: "shopStock", quantity: "shopStock", openingstock: "shopStock",
  storestock: "storeStock", store: "storeStock",
};

const TEMPLATE =
  "name,code,barcode,category,unit,vat,cost,price,contractor,wholesale,reorder,shop stock,store stock\n" +
  "Bamburi Cement 50kg,CEM-BAM,,Cement,bag,Exempt,690,780,760,,50,120,400\n" +
  "Nails 3 inch,NL-3,,Fasteners,kg,16,115,160,145,,20,80,100\n";

interface Preview { total: number; valid: number; invalid: number; errors: { row: number; message: string }[]; sample: string[] }

export function ImportProducts({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "products-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(""); setPreview(null); setRows(null); setFileName(f.name);
    if (/\.xlsx?$/i.test(f.name)) return setErr("Excel files are not read directly. In Excel choose File > Save As > CSV, then upload that file.");
    const grid = parseCsv(await f.text());
    if (grid.length < 2) return setErr("The file has no product rows. The first row must be the column headings.");
    const keys = grid[0].map((h) => HEADERS[h.toLowerCase().replace(/[^a-z]/g, "")] ?? "");
    setUnknown(grid[0].filter((_, i) => !keys[i]));
    if (!keys.includes("name") || !keys.includes("retail")) return setErr("The file needs at least a Name column and a Price column. Download the template to see the layout.");
    const objs = grid.slice(1).map((r) => {
      const o: Record<string, string> = {};
      keys.forEach((k, i) => { if (k) o[k] = (r[i] ?? "").trim(); });
      return o;
    });
    setRows(objs);
    setBusy(true);
    try { setPreview(await post<Preview>("/api/products/import", { rows: objs, dryRun: true })); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const run = async () => {
    if (!rows) return;
    setBusy(true);
    try { const r = await post<{ imported: number }>("/api/products/import", { rows, dryRun: false }); onDone(r.imported); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title="Import products from a spreadsheet" onClose={onClose}>
      <ol className="text-slate-600 space-y-1 mb-4 list-decimal pl-5">
        <li>Save your price list as a <strong>CSV</strong> file (in Excel: File &gt; Save As &gt; CSV).</li>
        <li>The first row must be the column headings: name, code, price and so on.</li>
        <li>You see a check of every row before anything is saved.</li>
      </ol>
      <div className="flex flex-wrap gap-2 mb-4">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <Button variant="primary" onClick={() => fileRef.current?.click()} className="flex items-center gap-2"><FileSpreadsheet className="size-4" />{fileName ? "Choose a different file" : "Choose CSV file"}</Button>
        <Button onClick={downloadTemplate} className="flex items-center gap-2"><Download className="size-4" />Download template</Button>
      </div>
      {fileName && <p className="text-sm text-slate-500 mb-3">{fileName}</p>}
      <ErrorLine msg={err} />

      {unknown.length > 0 && preview && (
        <p className="text-sm text-slate-500 mb-3">Ignored columns: {unknown.join(", ")}</p>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Rows in file" v={preview.total} />
            <Stat label="Ready to import" v={preview.valid} tone="ok" />
            <Stat label="Need fixing" v={preview.invalid} tone={preview.invalid ? "bad" : undefined} />
          </div>
          {preview.invalid > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 max-h-48 overflow-auto">
              <p className="font-semibold text-danger flex items-center gap-2 mb-1"><TriangleAlert className="size-4" />These rows will be skipped. Fix them in your file and import again if you need them.</p>
              <ul className="text-sm space-y-0.5">{preview.errors.map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}</ul>
            </div>
          )}
          <Button variant="primary" className="w-full !py-3" disabled={busy || preview.valid === 0} onClick={run}>
            {busy ? "Importing" : `Import ${preview.valid} product${preview.valid === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, v, tone }: { label: string; v: number; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-danger" : ""}`}>{v}</div>
    </div>
  );
}
