import { useCallback, useEffect, useState } from "react";
import { api, get, post, useAuth } from "../../lib/api";
import { Button, Input, td, th } from "../../lib/ui";
import { useToast } from "../../lib/toast";
import { useLive } from "../../lib/live";

interface Cat { id: number; name: string; product_count: number }

/** Categories group the catalogue. Renaming is safe; a category with products in it cannot be deleted. */
export function Categories() {
  const { can } = useAuth();
  const canManage = can("products.manage");
  const toast = useToast();
  const [rows, setRows] = useState<Cat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => get<Cat[]>("/api/categories").then((r) => { setRows(r); setLoaded(true); }).catch((e) => { toast({ msg: (e as Error).message, kind: "err" }); setLoaded(true); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useLive(["products"], load);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast({ msg: ok }); await load(); return true; }
    catch (e) { toast({ msg: (e as Error).message, kind: "err" }); return false; }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-2xl">
      <p className="text-slate-600 mb-3">Categories group your items so they are easy to find and filter. Open an item to change its category.</p>
      {canManage && (
        <form className="flex flex-wrap items-center gap-2 mb-4" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; if (await run(() => post("/api/categories", { name: name.trim() }), "Category added")) setName(""); }}>
          <Input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New category name" className="!w-64 max-w-full" />
          <Button variant="primary" type="submit" disabled={busy || !name.trim()} className="shrink-0 whitespace-nowrap">Add category</Button>
        </form>
      )}
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead><tr><th className={th}>Category</th><th className={`${th} text-right`}>Items</th>{canManage && <th className={th}></th>}</tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className={td}>
                  {edit?.id === c.id
                    ? <Input autoFocus value={edit.name} onChange={(e) => setEdit({ id: c.id, name: e.target.value })} aria-label="Category name" className="!w-56 max-w-full"
                        onKeyDown={async (e) => { if (e.key === "Enter" && edit.name.trim() && (await run(() => api("PATCH", `/api/categories/${c.id}`, { name: edit.name.trim() }), "Category renamed"))) setEdit(null); if (e.key === "Escape") setEdit(null); }} />
                    : <span className="font-medium">{c.name}</span>}
                </td>
                <td className={`${td} num`}>{c.product_count.toLocaleString("en-KE")}</td>
                {canManage && (
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {edit?.id === c.id ? (
                      <span className="inline-flex gap-2 whitespace-nowrap">
                        <Button variant="primary" className="!py-1.5" disabled={busy || !edit.name.trim()} onClick={async () => { if (await run(() => api("PATCH", `/api/categories/${c.id}`, { name: edit.name.trim() }), "Category renamed")) setEdit(null); }}>Save</Button>
                        <Button className="!py-1.5" onClick={() => setEdit(null)}>Cancel</Button>
                      </span>
                    ) : confirm === c.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-sm text-slate-600">Delete this category?</span>
                        <Button variant="danger" className="!py-1.5" disabled={busy} onClick={async () => { await run(() => api("DELETE", `/api/categories/${c.id}`), "Category deleted"); setConfirm(null); }}>Delete</Button>
                        <Button className="!py-1.5" onClick={() => setConfirm(null)}>Keep</Button>
                      </span>
                    ) : (
                      <span className="inline-flex gap-2 items-center">
                        <Button className="!py-1.5" onClick={() => setEdit({ id: c.id, name: c.name })}>Rename</Button>
                        <Button className="!py-1.5" disabled={c.product_count > 0} title={c.product_count > 0 ? "Move its items to another category first" : undefined} onClick={() => setConfirm(c.id)}>Delete</Button>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {loaded && !rows.length && <tr><td colSpan={3} className={`${td} text-center text-slate-500 py-10`}>No categories yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {canManage && rows.some((c) => c.product_count > 0) && <p className="text-xs text-slate-500 mt-2">A category that still has items cannot be deleted. Move its items to another category first.</p>}
    </div>
  );
}
