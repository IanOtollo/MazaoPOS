import { brandOr, useBrand } from "./brand";
import { HelpButton } from "./Help";

export const MAKER = (
  <a href="https://marabimadeit.co.ke" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-slate-800">Marabi made it</a>
);

/**
 * Bottom bar. On the sign-in screen the rights notice sits in the centre and the maker's link at the right.
 * Inside the app it is one small line so it never takes space from the work.
 */
export function SiteFooter({ variant = "app" }: { variant?: "app" | "auth" }) {
  const rights = `© ${new Date().getFullYear()} ${brandOr(useBrand())}. All rights reserved.`;
  if (variant === "auth") {
    return (
      <footer className="shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3 text-xs text-slate-500 print:hidden">
        <span><HelpButton /></span>
        <span className="text-center">{rights}</span>
        <span />
      </footer>
    );
  }
  return (
    <footer className="shrink-0 flex items-center justify-between gap-3 px-4 py-1.5 text-[11px] leading-4 text-slate-400 border-t border-slate-200 bg-white print:hidden">
      <span className="truncate hidden sm:block">{rights}</span>
      <HelpButton />
      <span className="shrink-0">{MAKER}</span>
    </footer>
  );
}
