import { useState } from "react";
import { LockOpen } from "lucide-react";
import { toCents } from "../../../shared/money";
import { post, useAuth } from "../lib/api";
import { Button, ErrorLine, Field, NumInput } from "../lib/ui";
import { useToast } from "../lib/toast";

export function OpenShift({ onOpened }: { onOpened: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [float, setFloat] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (float == null) return setErr("Enter the cash in the drawer. Use 0 if it is empty.");
    setBusy(true);
    try {
      await post("/api/shifts/open", { floatCents: toCents(float) });
      toast({ msg: "Shift opened. Ready to sell." });
      onOpened();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-card border border-slate-200 w-full max-w-md p-8">
        <span className="size-14 rounded-xl bg-blue-50 text-accent flex items-center justify-center mb-5"><LockOpen className="size-7" /></span>
        <h1 className="text-2xl font-bold tracking-tight">Good to see you, {user.name}</h1>
        <p className="text-slate-600 mt-1 mb-6">Count the cash in your drawer and enter it below to start your shift. This is your opening float.</p>
        <Field label="Opening float (KES)">
          <NumInput value={float} onChange={(n) => { setFloat(n); setErr(""); }} autoFocus placeholder="0.00" className="num !text-2xl !font-bold !py-3"
            onKeyDown={(e) => e.key === "Enter" && open()} />
        </Field>
        <div className="mt-3 min-h-5"><ErrorLine msg={err} /></div>
        <Button variant="primary" className="w-full !py-3.5 !text-base mt-2" onClick={open} disabled={busy}>Start shift</Button>
      </div>
    </div>
  );
}
