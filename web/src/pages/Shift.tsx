import { useEffect, useState } from "react";
import { fmtKES, toCents } from "../../../shared/money";
import { fmtTime, get, post, useAuth } from "../lib/api";
import { Button, ErrorLine, Field, Input, NumInput, PageHead, td, th } from "../lib/ui";
import { useLive } from "../lib/live";

export default function Shift() {
  const { can } = useAuth();
  const seeAll = can("shifts.view_all");
  const [s, setS] = useState<any | undefined>(undefined);
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const load = () => get("/api/shifts/current").then(setS);
  useEffect(() => { load(); if (seeAll) get("/api/shifts").then(setHistory); }, [seeAll, result]);

  useLive(["shifts", "sales"], () => { load(); if (seeAll) get("/api/shifts").then(setHistory); });

  const close = async () => {
    if (counted == null) return setErr("Count the drawer and enter the amount");
    try { setResult(await post("/api/shifts/close", { countedCashCents: toCents(counted), note: note || undefined })); setErr(""); load(); }
    catch (e) { setErr((e as Error).message); }
  };

  if (s === undefined) return null;
  return (
    <div className="p-4 max-w-2xl">
      <PageHead title="Shift & cash-up" />
      {result && (
        <div className="border border-line rounded-xl p-5 mb-4 bg-white shadow-card">
          <h2 className="font-semibold mb-2">Shift closed</h2>
          <div className="flex justify-between"><span>Expected cash</span><span className="num">{fmtKES(result.expectedCashCents)}</span></div>
          <div className="flex justify-between"><span>Counted cash</span><span className="num">{fmtKES(result.countedCashCents)}</span></div>
          <div className={`flex justify-between font-semibold text-lg ${result.varianceCents === 0 ? "text-ok" : "text-danger"}`}>
            <span>{result.varianceCents === 0 ? "Balanced" : result.varianceCents > 0 ? "Over" : "Short"}</span><span className="num">{fmtKES(result.varianceCents)}</span>
          </div>
          <Button className="mt-3" onClick={() => window.print()}>Print</Button>
        </div>
      )}
      {s ? (
        <div className="bg-white border border-line rounded-xl shadow-card p-5">
          <p className="text-sm text-gray-600 mb-3">Open since {fmtTime(s.opened_at)}</p>
          <div className="flex justify-between"><span>Opening float</span><span className="num">{fmtKES(s.opening_float_cents)}</span></div>
          {Object.entries(s.byMethod as Record<string, number>).map(([m, v]) => (
            <div key={m} className="flex justify-between capitalize"><span>{m} sales</span><span className="num">{fmtKES(v)}</span></div>
          ))}
          <div className="flex justify-between font-semibold text-lg border-t border-line mt-2 pt-2"><span>Cash that should be in drawer</span><span className="num">{fmtKES(s.expectedCashCents)}</span></div>
          <div className="mt-4 space-y-3">
            <Field label="Cash counted in drawer (KES)"><NumInput value={counted} onChange={setCounted} /></Field>
            <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <ErrorLine msg={err} />
            <Button variant="primary" onClick={close}>Close shift</Button>
          </div>
        </div>
      ) : !result && <p className="text-gray-600">You have no open shift. Go to Sell to open one.</p>}

      {history.length > 0 && (
        <>
          <h2 className="font-semibold mt-8 mb-2">Recent shifts</h2>
          <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
            <table className="w-full min-w-[34rem]">
              <thead><tr><th className={th}>Cashier</th><th className={th}>Opened</th><th className={`${th} text-right`}>Expected</th><th className={`${th} text-right`}>Counted</th><th className={`${th} text-right`}>Variance</th></tr></thead>
              <tbody>
                {history.map((h) => {
                  const v = h.closed_at ? h.counted_cash_cents - h.expected_cash_cents : null;
                  return (
                    <tr key={h.id}><td className={td}>{h.cashier}</td><td className={td}>{fmtTime(h.opened_at)}</td>
                      <td className={`${td} num`}>{h.closed_at ? fmtKES(h.expected_cash_cents) : "open"}</td>
                      <td className={`${td} num`}>{h.closed_at ? fmtKES(h.counted_cash_cents) : ""}</td>
                      <td className={`${td} num ${v ? "text-danger font-semibold" : ""}`}>{v == null ? "" : fmtKES(v)}</td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
