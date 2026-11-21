import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Compass } from "lucide-react";
import { Button } from "../lib/ui";

/** Shown for any address the app does not have. */
export default function NotFound({ home }: { home: string }) {
  const nav = useNavigate();
  return (
    <div className="h-full min-h-[24rem] flex items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 size-14 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center"><Compass className="size-7" /></div>
        <p className="text-sm font-semibold text-slate-500 tracking-wide">ERROR 404</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">This page does not exist</h1>
        <p className="mt-2 text-slate-600">The address may be mistyped, or the page has been moved. Nothing has been lost.</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button onClick={() => nav(-1)} className="flex items-center gap-1.5"><ArrowLeft className="size-4" />Go back</Button>
          <Link to={home}><Button variant="primary">Go to home</Button></Link>
        </div>
      </div>
    </div>
  );
}
