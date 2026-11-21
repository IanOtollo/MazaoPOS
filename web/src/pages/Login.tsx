import { useEffect, useState } from "react";
import { Delete } from "lucide-react";
import { get, post, type User } from "../lib/api";
import { brandOr, setBrand, setLogo, useLogoUrl } from "../lib/brand";

const MAX_PIN = 8;

export default function Login({ onLogin }: { onLogin: (u: User, token: string) => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const logo = useLogoUrl();

  useEffect(() => {
    get<{ business_name: string; logo_version: string }>("/api/auth/info")
      .then((s) => { setName(s.business_name); setBrand(s.business_name); setLogo(s.logo_version); })
      .catch((e) => setErr(e.message)); // tells the cashier straight away if the server is down
  }, []);

  const submit = async (p = pin) => {
    if (p.length < 4 || busy) return;
    setBusy(true);
    try {
      const r = await post<{ token: string; user: User }>("/api/auth/login", { pin: p });
      onLogin(r.user, r.token);
    } catch (e) {
      setErr((e as Error).message);
      setPin("");
      setBusy(false);
    }
  };

  const press = (d: string) => { setErr(""); setPin((p) => (p.length < MAX_PIN ? p + d : p)); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") submit();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const key = "h-14 rounded-lg border border-slate-300 bg-white text-xl font-semibold text-slate-900 hover:bg-slate-50 active:bg-slate-100 transition-colors";

  return (
    <div className="h-full flex items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-[20rem]">
        {logo && <img src={logo} alt="" className="mx-auto mb-3 h-20 max-w-[12rem] object-contain" />}
        <h1 className="text-center text-2xl font-bold tracking-tight mb-1">{brandOr(name)}</h1>
        <p className="text-center text-slate-500 mb-6">Enter your PIN</p>

        <div className="bg-white rounded-xl border border-slate-200 shadow-card p-5">
          <div className="flex justify-center gap-3 h-4 mb-5" role="img" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
              <span key={i} className={`size-3.5 rounded-full border-2 transition-colors ${i < pin.length ? "bg-slate-900 border-slate-900" : "border-slate-300"}`} />
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} onClick={() => press(d)} className={key}>{d}</button>)}
            <span />
            <button onClick={() => press("0")} className={key}>0</button>
            <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete last digit" className={`${key} flex items-center justify-center`}><Delete className="size-5" /></button>
          </div>

          <button onClick={() => submit()} disabled={pin.length < 4 || busy}
            className="mt-3 w-full h-12 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-700 disabled:opacity-40 transition-colors">
            {busy ? "Please wait" : "Enter"}
          </button>
          <p role="alert" className="mt-3 min-h-5 text-center text-sm font-medium text-danger">{err}</p>
        </div>
      </div>
    </div>
  );
}
