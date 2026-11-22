import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, CircleHelp, Compass, Lightbulb, RotateCcw, Search } from "lucide-react";
import { AuthCtx } from "./api";
import { Button, Input, Modal } from "./ui";
import { GUIDES, type Guide } from "./guides";
import { resetA11y, setA11y, useA11y, type TextSize } from "./a11y";

/** The "Help & accessibility" button for the footer. Pressing ? anywhere (outside a text box) opens it too. */
export function HelpButton({ variant = "text" }: { variant?: "text" | "icon" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <>
      {variant === "icon" ? (
        <button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Help and accessibility" title="Help and accessibility"
          className="size-9 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-100 hover:text-slate-900">
          <CircleHelp className="size-5" aria-hidden />
        </button>
      ) : (
        <button onClick={() => setOpen(true)} aria-haspopup="dialog" className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-slate-100 hover:text-slate-800">
          <CircleHelp className="size-3.5" aria-hidden />Help and accessibility
        </button>
      )}
      {open && <HelpPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const auth = useContext(AuthCtx) as { can: (p: never) => boolean } | null; // null on the sign-in screen
  const [tab, setTab] = useState<"guide" | "access">(auth ? "guide" : "access");
  const tabs: ["guide" | "access", string][] = auth ? [["guide", "Guide me"], ["access", "Accessibility"]] : [["access", "Accessibility"]];
  return (
    <Modal wide title="Help" onClose={onClose}>
      {tabs.length > 1 && (
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 mb-4" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${tab === id ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
          ))}
        </div>
      )}
      {tab === "guide" && auth ? <GuideMe can={auth.can as (p: string) => boolean} onClose={onClose} /> : <Accessibility />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Guide me
function GuideMe({ can, onClose }: { can: (p: string) => boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [guide, setGuide] = useState<Guide | null>(null);
  const [step, setStep] = useState(0);

  const mine = useMemo(() => GUIDES.filter((g) => !g.needs || can(g.needs)), [can]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return mine.filter((g) => words.every((w) => `${g.title} ${g.summary} ${g.steps.map((s) => s.text).join(" ")}`.toLowerCase().includes(w)));
  }, [mine, q]);
  const groups = [...new Set(shown.map((g) => g.group))];

  if (guide) {
    const last = step === guide.steps.length - 1;
    const s = guide.steps[step];
    return (
      <div>
        <button onClick={() => { setGuide(null); setStep(0); }} className="inline-flex items-center gap-1 text-sm font-semibold text-slate-600 hover:text-slate-900 mb-3"><ArrowLeft className="size-4" />All guides</button>
        <h3 className="text-xl font-bold tracking-tight">{guide.title}</h3>
        <p className="text-slate-600 mb-4">{guide.summary}</p>

        <div className="flex items-center gap-1.5 mb-1" role="progressbar" aria-valuemin={1} aria-valuemax={guide.steps.length} aria-valuenow={step + 1} aria-label={`Step ${step + 1} of ${guide.steps.length}`}>
          {guide.steps.map((_, i) => (
            <button key={i} onClick={() => setStep(i)} aria-label={`Go to step ${i + 1}`} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-accent" : "bg-slate-200 hover:bg-slate-300"}`} />
          ))}
        </div>
        <p className="text-sm text-slate-500 mb-3">Step {step + 1} of {guide.steps.length}</p>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 min-h-28" aria-live="polite">
          <div className="flex gap-3">
            <span className="size-8 shrink-0 rounded-full bg-accent text-white font-bold flex items-center justify-center">{step + 1}</span>
            <p className="text-lg leading-snug pt-0.5">{s.text}</p>
          </div>
          {s.tip && <p className="mt-3 ml-11 flex gap-2 text-sm text-slate-600"><Lightbulb className="size-4 shrink-0 mt-0.5 text-amber-600" aria-hidden /><span>{s.tip}</span></p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mt-4">
          <div className="flex gap-2">
            <Button onClick={() => setStep((n) => Math.max(0, n - 1))} disabled={step === 0} className="flex items-center gap-1.5"><ArrowLeft className="size-4" />Back</Button>
            {last
              ? <Button variant="primary" onClick={() => { setGuide(null); setStep(0); }}>Done</Button>
              : <Button variant="primary" onClick={() => setStep((n) => n + 1)} className="flex items-center gap-1.5">Next<ArrowRight className="size-4" /></Button>}
          </div>
          <Button onClick={() => { nav(guide.go); onClose(); }} className="flex items-center gap-1.5"><Compass className="size-4" />Take me there</Button>
        </div>

        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-semibold text-slate-600">Show all steps</summary>
          <ol className="mt-2 space-y-1.5 list-decimal pl-5 text-slate-700">{guide.steps.map((t, i) => <li key={i} className={i === step ? "font-semibold" : ""}>{t.text}</li>)}</ol>
        </details>
      </div>
    );
  }

  return (
    <div>
      <p className="text-slate-600 mb-3">Pick what you want to do and follow the steps. Only the things your role can do are listed.</p>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" aria-hidden />
        <Input autoFocus placeholder="What do you want to do? For example refund, stock, supplier" value={q} onChange={(e) => setQ(e.target.value)} className="!pl-9" aria-label="Search the guides" />
      </div>
      {!shown.length && <p className="text-slate-500 py-6 text-center">No guide matches "{q}". Try a simpler word, like sale, stock or customer.</p>}
      <div className="space-y-4 max-h-[55vh] overflow-auto pr-1">
        {groups.map((gr) => (
          <section key={gr}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{gr}</h4>
            <ul className="grid sm:grid-cols-2 gap-2">
              {shown.filter((g) => g.group === gr).map((g) => (
                <li key={g.id}>
                  <button onClick={() => { setGuide(g); setStep(0); }} className="w-full h-full text-left rounded-lg border border-slate-200 bg-white p-3 hover:border-slate-400 hover:bg-slate-50 transition-colors">
                    <span className="block font-semibold">{g.title}</span>
                    <span className="block text-sm text-slate-500">{g.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Accessibility
const SIZES: [TextSize, string, string][] = [["normal", "Normal", "text-base"], ["large", "Large", "text-xl"], ["xlarge", "Largest", "text-2xl"]];

function Accessibility() {
  const a = useA11y();
  return (
    <div className="space-y-5">
      <p className="text-slate-600">These choices make the screen easier to read and use. They apply at once and are kept on this device only, so each till or phone can have its own.</p>

      <section>
        <h3 className="font-semibold mb-0.5" id="a11y-size">Text size</h3>
        <p className="text-sm text-slate-500 mb-2">Makes all the writing bigger, including buttons and tables.</p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby="a11y-size">
          {SIZES.map(([id, label, cls]) => (
            <button key={id} role="radio" aria-checked={a.text === id} onClick={() => setA11y({ text: id })}
              className={`rounded-lg border p-3 text-center transition-colors ${a.text === id ? "border-accent bg-accent text-white" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
              <span className={`block font-bold ${cls}`}>Aa</span>
              <span className="block text-sm">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="space-y-2">
        <Switch label="High contrast" hint="Darker text and stronger borders, easier to read in bright light." on={a.contrast} set={(v) => setA11y({ contrast: v })} />
        <Switch label="Calm screen" hint="Turns off sliding and fading movement." on={a.calm} set={(v) => setA11y({ calm: v })} />
        <Switch label="Strong focus outline" hint="A thick outline shows which button or box you are on when using the keyboard." on={a.focus} set={(v) => setA11y({ focus: v })} />
      </div>

      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h3 className="font-semibold mb-2">Using the keyboard</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt><Key>Tab</Key></dt><dd>Move to the next button or box. Hold Shift to go back.</dd>
          <dt><Key>Enter</Key></dt><dd>Press the selected button. On the PIN pad it signs you in.</dd>
          <dt><Key>Esc</Key></dt><dd>Close a window that is open.</dd>
          <dt><Key>?</Key></dt><dd>Open this help from anywhere.</dd>
          <dt><Key>/</Key></dt><dd>Search for an item or a page.</dd>
          <dt><Key>0</Key> to <Key>9</Key></dt><dd>Type the PIN on the sign-in screen.</dd>
        </dl>
      </section>

      <div className="flex justify-end">
        <Button onClick={resetA11y} className="flex items-center gap-1.5"><RotateCcw className="size-4" />Reset to normal</Button>
      </div>
    </div>
  );
}

function Switch({ label, hint, on, set }: { label: string; hint: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => set(!on)} className="w-full flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-3 text-left hover:bg-slate-50">
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-sm text-slate-500">{hint}</span>
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-slate-300"}`} aria-hidden>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

const Key = ({ children }: { children: string }) => <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs font-semibold">{children}</kbd>;
