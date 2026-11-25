/**
 * Public static landing page. Keep it independent of the (app) providers and
 * browser-only APIs so it remains safe for logged-out visitors and prerendering.
 */

import { ArrowDown, ArrowRight, Check, Code2, Eye, Radio, ScanLine, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge, buttonVariants } from '../components/ui'
import { Seo } from '../components/Seo'

const workflow = [
  {
    step: '01',
    icon: Code2,
    title: 'Run a focused assessment',
    description:
      'Give candidates a clear problem, a coding workspace, and curated tests in one place.',
    status: 'Candidate workspace',
    statusVariant: 'outline' as const,
  },
  {
    step: '02',
    icon: Radio,
    title: 'Capture useful browser signals',
    description:
      'Record focus changes, paste bursts, test runs, edits, and connection state with sequence numbers.',
    status: 'Live signals',
    statusVariant: 'success' as const,
  },
  {
    step: '03',
    icon: ScanLine,
    title: 'Review the complete timeline',
    description:
      'Reconstruct code from snapshots and deltas, inspect deterministic incidents, and add reviewer notes.',
    status: 'Human review',
    statusVariant: 'warning' as const,
  },
]

export default function Landing() {
  return (
    <>
      <Seo
        title="CodeProctor | Live coding assessments"
        description="Run coding assessments with browser-level integrity telemetry, deterministic session timelines, and transparent human review."
        path="/"
      />
      <main className="relative min-h-screen overflow-hidden bg-[#090d16] text-slate-100">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_14%_0%,rgba(99,102,241,0.18),transparent_48%)]" />
          <div className="absolute -right-32 top-28 h-96 w-96 rounded-full bg-indigo-500/10 blur-3xl" />
          <div className="absolute -left-40 top-[34rem] h-96 w-96 rounded-full bg-blue-500/5 blur-3xl" />
        </div>

        <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 sm:px-8">
          <header className="flex items-center justify-between border-b border-slate-800/80 py-5">
            <Link to="/" className="flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
              <span className="grid size-9 place-items-center rounded-xl border border-indigo-400/25 bg-indigo-400/10 text-indigo-200">
                <Code2 aria-hidden="true" className="size-5" />
              </span>
              <span className="font-semibold tracking-tight text-white">CodeProctor</span>
            </Link>
            <Link
              to="/home"
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Sign in <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </header>

          <section className="grid flex-1 items-center gap-14 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-20">
            <div className="max-w-2xl">
              <Badge
                variant="outline"
                className="gap-2 border-indigo-300/20 bg-indigo-400/5 px-3 py-1.5 text-indigo-200"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-400" />
                Assess with clarity. Review with evidence.
              </Badge>
              <h1 className="mt-7 text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
                Coding assessments,
                <span className="mt-2 block bg-gradient-to-r from-indigo-200 via-indigo-300 to-slate-100 bg-clip-text text-transparent">
                  with a clear audit trail.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                CodeProctor brings live coding, browser-level integrity telemetry, and deterministic
                timeline reconstruction into one transparent review workflow.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  to="/home"
                  className={buttonVariants({
                    size: 'lg',
                    className:
                      'h-12 rounded-xl bg-indigo-400 px-6 text-slate-950 shadow-lg shadow-indigo-950/30 hover:bg-indigo-300',
                  })}
                >
                  Enter CodeProctor <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
                <a
                  href="#workflow"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/50 px-5 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  See how it works <ArrowDown aria-hidden="true" className="size-4" />
                </a>
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
                <span className="inline-flex items-center gap-2">
                  <Check aria-hidden="true" className="size-3.5 text-emerald-400" />
                  Ordered events and snapshots
                </span>
                <span className="inline-flex items-center gap-2">
                  <Check aria-hidden="true" className="size-3.5 text-emerald-400" />
                  Reviewer-controlled decisions
                </span>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-xl">
              <div aria-hidden="true" className="absolute -inset-5 rounded-[2rem] bg-indigo-500/10 blur-2xl" />
              <section
                aria-label="Illustrative assessment review"
                className="relative overflow-hidden rounded-2xl border border-slate-700/80 bg-[#0f172a]/95 shadow-2xl shadow-black/40"
              >
                <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-lg bg-slate-800 text-indigo-200">
                      <ShieldCheck aria-hidden="true" className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-slate-100">Session review</p>
                      <p className="text-xs text-slate-400">Illustrative workflow preview</p>
                    </div>
                  </div>
                  <Badge variant="success" className="gap-1.5">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-950/70" />
                    Active
                  </Badge>
                </div>

                <div className="space-y-5 p-5 sm:p-6">
                  <div className="rounded-xl border border-slate-800 bg-[#090d16] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium text-slate-300">Reconstructed code</p>
                        <p className="mt-1 text-[11px] text-slate-500">Snapshot + ordered edits</p>
                      </div>
                      <Badge variant="outline" className="border-slate-700 text-slate-300">
                        seq 024
                      </Badge>
                    </div>
                    <div className="mt-4 space-y-2 font-mono text-xs">
                      <p className="text-slate-500"><span className="text-indigo-300">function</span> solve(input) {'{'}</p>
                      <p className="pl-4 text-slate-300"><span className="text-indigo-300">return</span> input.reduce(sum, 0)</p>
                      <p className="text-slate-500">{'}'}</p>
                    </div>
                  </div>

                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-xs font-medium text-slate-300">Review signals</p>
                      <span className="text-[11px] text-slate-500">Sequence ordered</span>
                    </div>
                    <ol className="space-y-2.5">
                      <li className="flex items-center justify-between gap-3 rounded-lg border border-emerald-400/10 bg-emerald-400/[0.04] px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5 text-xs text-slate-300">
                          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                          Candidate connected
                        </span>
                        <Badge variant="success" size="sm">seq 018</Badge>
                      </li>
                      <li className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5 text-xs text-slate-300">
                          <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                          Focus change to review
                        </span>
                        <Badge variant="warning" size="sm">seq 021</Badge>
                      </li>
                      <li className="flex items-center justify-between gap-3 rounded-lg border border-rose-400/10 bg-rose-400/[0.04] px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2.5 text-xs text-slate-300">
                          <span className="size-1.5 shrink-0 rounded-full bg-rose-400" />
                          Paste burst flagged
                        </span>
                        <Badge variant="destructive" size="sm">seq 024</Badge>
                      </li>
                    </ol>
                  </div>
                  <p className="border-t border-slate-800 pt-4 text-[11px] leading-5 text-slate-500">
                    Example signals only — a reviewer interprets the timeline and makes the decision.
                  </p>
                </div>
              </section>
            </div>
          </section>

          <section id="workflow" className="scroll-mt-8 border-t border-slate-800/80 py-12 sm:py-14">
            <div className="mb-7 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">A transparent workflow</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  From first edit to informed review.
                </h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-slate-400">
                Every signal is tied to session history so reviewers can inspect the underlying events.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {workflow.map(({ step, icon: Icon, title, description, status, statusVariant }) => (
                <article
                  key={step}
                  className="group rounded-xl border border-slate-800 bg-slate-900/55 p-5 transition hover:border-slate-700 hover:bg-slate-900/80"
                >
                  <div className="flex items-center justify-between">
                    <span className="grid size-10 place-items-center rounded-xl border border-slate-700/80 bg-slate-800/70 text-indigo-200">
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <span className="font-mono text-xs text-slate-600">{step}</span>
                  </div>
                  <h3 className="mt-5 text-sm font-semibold text-slate-100">{title}</h3>
                  <p className="mt-2 min-h-12 text-xs leading-5 text-slate-400">{description}</p>
                  <Badge variant={statusVariant} className="mt-4">{status}</Badge>
                </article>
              ))}
            </div>
          </section>

          <footer className="flex flex-col gap-3 border-t border-slate-800/80 py-6 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <p className="inline-flex items-center gap-2">
              <Eye aria-hidden="true" className="size-4 shrink-0 text-amber-300" />
              Monitoring is limited to browser telemetry. No OS lockdown, webcam, or screen recording.
            </p>
            <span className="text-slate-500">Signals support human review; they are not proof of misconduct.</span>
          </footer>
        </div>
      </main>
    </>
  )
}
