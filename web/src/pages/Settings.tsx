import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Lock, Plus, Trash2 } from "lucide-react";
import { ADMIN_EXCLUDED, PERMISSIONS, PERMISSION_GROUPS, type Permission } from "../../../shared/permissions";
import { api, apiUrl, get, getToken, patch, post, put, useAuth } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, PageHead, inputCls, td, th, Select, PinInput } from "../lib/ui";
import { useConfirm, useToast } from "../lib/toast";
import { setBrand, setLogo, useLogoUrl } from "../lib/brand";
import { useLive } from "../lib/live";

type Tab = "business" | "staff" | "roles" | "backup";

export default function Settings() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const allowed: Record<Tab, boolean> = { business: can("settings.manage"), staff: can("users.manage"), roles: can("roles.manage"), backup: can("settings.manage") };
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && allowed[asked] ? asked : (["business", "staff", "roles", "backup"] as Tab[]).find((t) => allowed[t]) ?? "business";
  const TITLE: Record<Tab, string> = { business: "Business", staff: "Staff", roles: "Roles & access", backup: "Backup" };

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <PageHead title={TITLE[tab]} />
      {tab === "business" && <Business />}
      {tab === "staff" && <Staff />}
      {tab === "roles" && <Roles />}
      {tab === "backup" && <Backups />}
    </div>
  );
}

// ---------------------------------------------------------------- Business
function Business() {
  const toast = useToast();
  const [s, setS] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  useEffect(() => { get("/api/settings").then(setS); }, []);
  const set = (k: string, v: string) => setS((x) => ({ ...x, [k]: v }));

  const save = async () => {
    try { await put("/api/settings", s); setBrand(s.business_name); toast({ msg: "Settings saved" }); setErr(""); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="max-w-2xl">
      <LogoUpload />
      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <Field label="Business name"><Input value={s.business_name ?? ""} onChange={(e) => set("business_name", e.target.value)} /></Field>
        <Field label="Address"><Input value={s.address ?? ""} onChange={(e) => set("address", e.target.value)} /></Field>
        <Field label="Phone"><Input value={s.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Receipt footer"><Input value={s.receipt_footer ?? ""} onChange={(e) => set("receipt_footer", e.target.value)} /></Field></div>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" checked={s.allow_negative_stock === "1"} onChange={(e) => set("allow_negative_stock", e.target.checked ? "1" : "0")} />
          Allow selling items that are not in stock (stock count goes negative)
        </label>
      </div>
      <ErrorLine msg={err} />
      <Button variant="primary" onClick={save} className="mt-2">Save settings</Button>
    </div>
  );
}

// ---------------------------------------------------------------- Logo
/** Shrink the picture in the browser first, so even a phone photo of a signboard becomes a small, crisp logo. */
function shrink(file: File, max = 320): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image")); };
    img.src = url;
  });
}

function LogoUpload() {
  const toast = useToast();
  const confirm = useConfirm();
  const logo = useLogoUrl();
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast({ msg: "Choose a PNG, JPG or WebP image", kind: "err" });
    setBusy(true);
    try {
      const r = await put<{ version: string }>("/api/logo", { dataUrl: await shrink(f) });
      setLogo(r.version);
      toast({ msg: "Logo saved" });
    } catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
    setBusy(false);
  };
  const remove = async () => {
    if (!(await confirm({ title: "Remove the logo?", body: "The menu and receipts go back to showing just the business name.", confirmLabel: "Remove", danger: true }))) return;
    try { await api("DELETE", "/api/logo"); setLogo(""); toast({ msg: "Logo removed" }); } catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
  };
  return (
    <div className="flex items-center gap-4 mb-6 pb-6 border-b border-slate-200">
      <div className="size-24 shrink-0 rounded-xl border border-dashed border-slate-300 bg-white flex items-center justify-center overflow-hidden">
        {logo ? <img src={logo} alt="Your logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-slate-400 text-center px-2">No logo yet</span>}
      </div>
      <div>
        <div className="font-semibold">Business logo</div>
        <p className="text-sm text-slate-500 mb-2">Shown on the sign-in screen, the menu, receipts and customer statements. A square or wide PNG or JPG works best.</p>
        <div className="flex gap-2">
          <label className={`border px-4 py-2 rounded-lg font-semibold bg-white border-slate-300 hover:bg-slate-50 shadow-card cursor-pointer ${busy ? "opacity-50 pointer-events-none" : ""}`}>
            {logo ? "Replace logo" : "Upload logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {logo && <Button variant="danger" onClick={remove}>Remove</Button>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Staff
interface StaffRow { id: number; name: string; role: string; role_id: number; active: number }
interface RoleRow { id: number; name: string; description: string; is_system: number; user_count: number; permissions: Permission[] }

function Staff() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [modal, setModal] = useState<StaffRow | "new" | null>(null);
  const load = useCallback(() => {
    get<StaffRow[]>("/api/users").then(setRows);
    get<RoleRow[]>("/api/roles").then(setRoles);
  }, []);
  useEffect(load, [load]);
  useLive(["staff", "roles"], load);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-slate-600">Each person signs in with their own PIN. What they can do depends on their role.</p>
        <Button variant="primary" onClick={() => setModal("new")} className="flex items-center gap-1.5 shrink-0"><Plus className="size-4" />Add staff</Button>
      </div>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead><tr><th className={th}>Name</th><th className={th}>Role</th><th className={th}>Status</th><th className={th}></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.active ? "" : "text-slate-400"}>
                <td className={td}>{r.name}{r.id === user.id && <span className="text-slate-500"> (you)</span>}</td>
                <td className={td}>{r.role}</td>
                <td className={td}>{r.active ? "Active" : "Disabled"}</td>
                <td className={`${td} text-right whitespace-nowrap`}>
                  <div className="inline-flex gap-2">
                    <Button onClick={() => setModal(r)} className="!py-1.5">Edit</Button>
                    {r.id !== user.id && (
                      <Button variant="danger" className="!py-1.5" onClick={async () => {
                        if (!(await confirm({ title: `Delete ${r.name}?`, body: "They will no longer be able to sign in and their PIN is freed for someone else. Their past sales and records stay on file under their name. This cannot be undone. To only stop them signing in for now, choose Edit and untick Active instead.", confirmLabel: "Delete", danger: true }))) return;
                        try { await api("DELETE", `/api/users/${r.id}`); toast({ msg: `${r.name} deleted` }); load(); }
                        catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
                      }}>Delete</Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal && <StaffForm row={modal === "new" ? null : modal} roles={roles} selfId={user.id} onClose={() => setModal(null)}
        onSaved={() => { toast({ msg: modal === "new" ? "Staff member added" : "Staff member updated" }); setModal(null); load(); }} />}
    </div>
  );
}

function StaffForm({ row, roles, selfId, onClose, onSaved }: { row: StaffRow | null; roles: RoleRow[]; selfId: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(row?.name ?? "");
  const [roleId, setRoleId] = useState<number | "">(row?.role_id ?? roles.find((r) => r.name === "Cashier")?.id ?? "");
  const [pin, setPin] = useState("");
  const [active, setActive] = useState(row ? !!row.active : true);
  const [err, setErr] = useState("");
  const self = row?.id === selfId;
  const selected = roles.find((r) => r.id === roleId);

  const save = async () => {
    if (pin && !/^\d{4,8}$/.test(pin)) return setErr("PIN must be 4 to 8 digits");
    if (roleId === "") return setErr("Choose a role");
    try {
      if (row) await patch(`/api/users/${row.id}`, { roleId, active, ...(pin ? { pin } : {}) });
      else {
        if (!name.trim() || !pin) return setErr("Name and PIN are required");
        await post("/api/users", { name: name.trim(), pin, roleId });
      }
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Modal title={row ? `Edit ${row.name}` : "Add staff member"} onClose={onClose}>
      <div className="space-y-4">
        {!row && <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>}
        <Field label="Role" hint={selected ? `${selected.description} (${selected.permissions.length} permissions)` : undefined}>
          <Select className={inputCls} value={roleId} onChange={(e) => setRoleId(Number(e.target.value))} disabled={self}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label={row ? "New PIN (leave blank to keep the current one)" : "PIN (4 to 8 digits)"} hint="Every person needs their own PIN, so it also identifies who made each sale.">
          <PinInput autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
        </Field>
        {row && !self && <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (can sign in)</label>}
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Roles & permissions
function Roles() {
  const { user, can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [sel, setSel] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; permissions: Set<Permission> }>({ name: "", description: "", permissions: new Set() });
  const [err, setErr] = useState("");

  const load = useCallback((keep?: number) => get<RoleRow[]>("/api/roles").then((r) => {
    setRoles(r);
    setSel((cur) => keep ?? (cur === null || cur === "new" ? r[0]?.id ?? null : cur));
  }), []);
  useEffect(() => { load(); }, [load]);
  useLive(["roles", "staff"], () => { load(); });

  const role = typeof sel === "number" ? roles.find((r) => r.id === sel) : undefined;
  const locked = !!role?.is_system;

  // load the chosen role into the editor
  useEffect(() => {
    setErr("");
    if (sel === "new") setDraft({ name: "", description: "", permissions: new Set() });
    else if (role) setDraft({ name: role.name, description: role.description, permissions: new Set(role.permissions) });
  }, [sel, role?.id, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (p: Permission) => setDraft((d) => {
    const next = new Set(d.permissions);
    next.has(p) ? next.delete(p) : next.add(p);
    return { ...d, permissions: next };
  });

  const body = () => ({ name: draft.name, description: draft.description, permissions: [...draft.permissions] });

  const save = async () => {
    try {
      if (sel === "new") {
        const r = await post<{ id: number }>("/api/roles", body());
        toast({ msg: `Role "${draft.name}" created` });
        await load(r.id);
      } else if (role) {
        await put(`/api/roles/${role.id}`, body());
        toast({ msg: "Role saved. It applies to staff immediately." });
        await load(role.id);
      }
      setErr("");
    } catch (e) { setErr((e as Error).message); }
  };

  const remove = async () => {
    if (!role) return;
    if (!(await confirm({ title: `Delete the "${role.name}" role?`, body: "This cannot be undone.", confirmLabel: "Delete role", danger: true }))) return;
    try { await api("DELETE", `/api/roles/${role.id}`); toast({ msg: "Role deleted" }); setSel(null); await load(); }
    catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
  };

  return (
    <div className="grid md:grid-cols-[15rem_1fr] gap-6">
      <div>
        <ul className="space-y-1">
          {roles.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSel(r.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${sel === r.id ? "bg-accent text-white" : "hover:bg-slate-100"}`}>
                <span className="flex items-center gap-2 font-semibold">{r.name}{r.is_system ? <Lock className="size-3.5 opacity-70" /> : null}</span>
                <span className={`block text-xs ${sel === r.id ? "text-slate-300" : "text-slate-500"}`}>{r.user_count} {r.user_count === 1 ? "person" : "people"} · {r.permissions.length} permissions</span>
              </button>
            </li>
          ))}
        </ul>
        <Button onClick={() => setSel("new")} className="w-full mt-3 flex items-center justify-center gap-1.5"><Plus className="size-4" />New role</Button>
      </div>

      {sel !== null && (
        <div className="bg-white border border-line rounded-xl shadow-card p-5">
          <div className="grid sm:grid-cols-2 gap-4 mb-5">
            <Field label="Role name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={locked} placeholder="e.g. Stock clerk" /></Field>
            <Field label="Description"><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={locked} placeholder="What is this role for?" /></Field>
          </div>

          {locked && <p className="rounded-lg bg-slate-100 text-slate-700 px-3 py-2 mb-4 text-sm flex items-center gap-2"><Lock className="size-4" />The Admin role runs the business but does not use the till, and it cannot be changed.</p>}

          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g} className="mb-5">
              <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{g}</legend>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {PERMISSIONS.filter((p) => p.group === g).map((p) => {
                  const mine = can(p.key) || ADMIN_EXCLUDED.includes(p.key); // the till can always be handed out
                  const off = locked || (!mine && !draft.permissions.has(p.key));
                  return (
                    <label key={p.key} className={`flex items-start gap-3 px-3 py-2.5 ${off ? "opacity-60" : "cursor-pointer hover:bg-slate-50"}`}>
                      <input type="checkbox" className="mt-1 size-4" checked={draft.permissions.has(p.key)} disabled={off} onChange={() => toggle(p.key)} />
                      <span><span className="block font-semibold">{p.label}</span><span className="block text-sm text-slate-500">{p.hint}</span>
                        {!mine && !locked && <span className="block text-xs text-slate-400 mt-0.5">You do not hold this permission, so you cannot grant it.</span>}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <ErrorLine msg={err} />
          {!locked && (
            <div className="flex items-center justify-between mt-3">
              {role && role.id !== user.roleId ? <Button variant="danger" onClick={remove} className="flex items-center gap-1.5"><Trash2 className="size-4" />Delete role</Button> : <span />}
              <Button variant="primary" onClick={save}>{sel === "new" ? "Create role" : "Save changes"}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Backup
function Backups() {
  return (
    <div className="max-w-3xl">
      <p className="text-slate-600 mb-2">Your products, sales, stock and staff are stored safely in the cloud and every change is saved the moment it happens. There is nothing to back up by hand.</p>
      <p className="text-sm text-slate-500">If you ever want a full copy of the data, ask your system administrator to export it from the data dashboard.</p>
    </div>
  );
}
