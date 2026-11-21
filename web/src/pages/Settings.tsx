import { useCallback, useEffect, useState } from "react";
import { Download, Lock, Plus, Trash2 } from "lucide-react";
import { OWNER_EXCLUDED, PERMISSIONS, PERMISSION_GROUPS, type Permission } from "../../../shared/permissions";
import { api, get, getToken, patch, post, put, useAuth } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, PageHead, inputCls, td, th } from "../lib/ui";
import { useConfirm, useToast } from "../lib/toast";

type Tab = "business" | "staff" | "roles" | "backup";

export default function Settings() {
  const { can } = useAuth();
  const tabs = [
    can("settings.manage") && { id: "business" as Tab, label: "Business" },
    can("users.manage") && { id: "staff" as Tab, label: "Staff" },
    can("roles.manage") && { id: "roles" as Tab, label: "Roles & permissions" },
    can("settings.manage") && { id: "backup" as Tab, label: "Backup" },
  ].filter(Boolean) as { id: Tab; label: string }[];
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? "business");

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <PageHead title="Settings" />
      <div className="flex gap-1 border-b border-slate-200 mb-6 overflow-x-auto" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 font-semibold -mb-px border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-900"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "business" && <Business />}
      {tab === "staff" && <Staff />}
      {tab === "roles" && <Roles />}
      {tab === "backup" && <Backups />}
      <p className="text-sm text-slate-500 mt-10">eTIMS connection: not configured. Sales are recorded with status "pending" until the KRA integration is added.</p>
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
    try { await put("/api/settings", s); toast({ msg: "Settings saved" }); setErr(""); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="max-w-2xl">
      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <Field label="Business name"><Input value={s.business_name ?? ""} onChange={(e) => set("business_name", e.target.value)} /></Field>
        <Field label="KRA PIN"><Input value={s.kra_pin ?? ""} onChange={(e) => set("kra_pin", e.target.value.toUpperCase())} /></Field>
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

// ---------------------------------------------------------------- Staff
interface StaffRow { id: number; name: string; role: string; role_id: number; active: number }
interface RoleRow { id: number; name: string; description: string; is_system: number; user_count: number; permissions: Permission[] }

function Staff() {
  const { user } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [modal, setModal] = useState<StaffRow | "new" | null>(null);
  const load = useCallback(() => {
    get<StaffRow[]>("/api/users").then(setRows);
    get<RoleRow[]>("/api/roles").then(setRoles);
  }, []);
  useEffect(load, [load]);

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
                <td className={`${td} text-right`}><Button onClick={() => setModal(r)} className="!py-1.5">Edit</Button></td>
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
          <select className={inputCls} value={roleId} onChange={(e) => setRoleId(Number(e.target.value))} disabled={self}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label={row ? "New PIN (leave blank to keep the current one)" : "PIN (4 to 8 digits)"} hint="Every person needs their own PIN, so it also identifies who made each sale.">
          <Input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
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
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${sel === r.id ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}>
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

          {locked && <p className="rounded-lg bg-slate-100 text-slate-700 px-3 py-2 mb-4 text-sm flex items-center gap-2"><Lock className="size-4" />The Owner role runs the business but does not use the till, and it cannot be changed.</p>}

          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g} className="mb-5">
              <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{g}</legend>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {PERMISSIONS.filter((p) => p.group === g).map((p) => {
                  const mine = can(p.key) || OWNER_EXCLUDED.includes(p.key); // the till can always be handed out
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
interface BackupInfo { folder: string; keep: number; backups: { name: string; size: number; created_at: string }[] }

function Backups() {
  const toast = useToast();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get<BackupInfo>("/api/backups").then(setInfo), []);
  useEffect(() => { load(); }, [load]);

  const backUp = async () => {
    setBusy(true);
    try { await post("/api/backups"); toast({ msg: "Backup created" }); await load(); }
    catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
    setBusy(false);
  };

  const download = async (name: string) => {
    try {
      const res = await fetch(`/api/backups/${name}`, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error("Could not download the backup");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
  };

  const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  return (
    <div className="max-w-3xl">
      <p className="text-slate-600 mb-1">A backup is a complete copy of your products, sales, stock and staff. One is made automatically every day, and the last {info?.keep ?? 30} are kept.</p>
      <p className="text-sm text-slate-500 mb-4">They are stored on this computer{info ? ` in ${info.folder}` : ""}. Download one regularly and keep it on a flash disk or another computer, because backups on the same disk do not protect you if the disk fails.</p>
      <Button variant="primary" onClick={backUp} disabled={busy} className="mb-4">{busy ? "Backing up" : "Back up now"}</Button>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead><tr><th className={th}>Backup</th><th className={th}>Created</th><th className={`${th} text-right`}>Size</th><th className={th}></th></tr></thead>
          <tbody>
            {info?.backups.map((b) => (
              <tr key={b.name}>
                <td className={td}>{b.name}</td>
                <td className={td}>{new Date(b.created_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td className={`${td} num`}>{fmtSize(b.size)}</td>
                <td className={`${td} text-right`}><Button onClick={() => download(b.name)} className="!py-1.5 inline-flex items-center gap-1.5"><Download className="size-4" />Download</Button></td>
              </tr>
            ))}
            {info && !info.backups.length && <tr><td className={`${td} text-slate-500`} colSpan={4}>No backups yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
