import type { ReactNode } from "react";
import { brandOr, useBrand } from "../../lib/brand";
import { downloadCsv } from "../../lib/csv";
import { Button } from "../../lib/ui";

export interface CsvData { name: string; header: string[]; rows: (string | number | null)[][] }

/**
 * The white panel every report sits in: title, what it shows, the period, and Export CSV / Print.
 * Printing shows only this panel (index.css prints .print-area), with the business name on top.
 * Pass csv={undefined} for a panel with no export (the buttons are left out).
 */
export function Frame({ title, desc, period, csv, children }: { title: string; desc: string; period: string; csv?: CsvData | null; children: ReactNode }) {
  const biz = brandOr(useBrand());
  return (
    <section className="print-area bg-white border border-line rounded-xl shadow-card p-5 min-w-0">
      <div className="hidden print:block mb-4">
        <div className="text-lg font-bold">{biz}</div>
        <div className="font-semibold">{title}</div>
        <div className="text-sm">{period}</div>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0 print:hidden">
          <h2 className="font-semibold text-lg">{title}</h2>
          <p className="text-sm text-slate-500">{desc}</p>
          <p className="text-sm font-medium text-slate-700 mt-0.5">{period}</p>
        </div>
        {csv !== undefined && (
          <div className="flex gap-2 print:hidden">
            <Button onClick={() => csv && downloadCsv(`${csv.name}.csv`, csv.header, csv.rows)} disabled={!csv || !csv.rows.length}>Export CSV</Button>
            <Button onClick={() => window.print()}>Print</Button>
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

/** A table that scrolls sideways on a small screen instead of squashing. */
export const Table = ({ children }: { children: ReactNode }) => (
  <div className="overflow-auto -mx-1"><table className="w-full">{children}</table></div>
);

export const Summary = ({ children }: { children: ReactNode }) => <p className="text-sm text-slate-600 mb-3">{children}</p>;
export const Empty = ({ children }: { children: ReactNode }) => <p className="text-slate-500 py-8 text-center">{children}</p>;
export const totalRow = "font-bold bg-slate-50";
