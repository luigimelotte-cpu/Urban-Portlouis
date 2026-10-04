import { AgeGate } from "./AgeGate";

export const metadata = { title: "Welcome · Lumen" };

export default function WelcomePage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.3em] text-amber-glow">Lumen</p>
      <h1 className="mt-3 font-display text-4xl leading-tight">Characters who remember you.</h1>
      <p className="mt-4 text-sm leading-relaxed text-ink-300">
        Lumen is for adults only. Conversations can include romance, flirting and mature themes between fictional adult characters. Your chats are private — they are never
        published or shared.
      </p>
      <AgeGate />
    </main>
  );
}
