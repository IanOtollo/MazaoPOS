import { brandOr, useBrand } from "./brand";

export const MAKER = (
  <a href="https://marabimadeit.co.ke" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-slate-800">Marabi made it</a>
);

/**
 * Bottom line with the rights notice: centred on the sign-in screen, one small line inside the app.
 * The maker's link (MAKER) is shown only under the PIN card on the sign-in screen.
 */
export function SiteFooter({ variant = "app" }: { variant?: "app" | "auth" }) {
  const rights = `© ${new Date().getFullYear()} ${brandOr(useBrand())}. All rights reserved.`;
  if (variant === "auth") {
    return <footer className="shrink-0 px-4 py-3 text-center text-xs text-slate-500 print:hidden">{rights}</footer>;
  }
  return (
    <footer className="shrink-0 px-4 py-4 text-center text-[11px] leading-4 text-slate-500 print:hidden">
      {rights}
    </footer>
  );
}
