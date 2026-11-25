import { ArrowRight, BookOpenCheck, CircleHelp, Settings2, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuthProfileReady } from 'deepspace'
import { Badge, buttonVariants } from '../../components/ui'
import { useActorContext } from '../../hooks/useActorContext'

export default function HomePage() {
  const { isLoaded, isSignedIn, user } = useAuthProfileReady({ requireUser: true })
  const { domainRole, isProctor, isCandidate } = useActorContext()

  const name = user?.name?.trim() || user?.email || 'there'
  const roleLabel = !isLoaded
    ? 'Loading profile'
    : !isSignedIn
      ? 'Sign in required'
      : isProctor
        ? 'Proctor'
        : isCandidate
          ? 'Candidate'
          : 'Role not mapped'
  const roleDescription = isProctor
    ? 'Create and monitor assessments, inspect ordered session timelines, and record review decisions.'
    : isCandidate
      ? 'Open your assigned assessment, work through the coding prompt, run tests, and submit your solution.'
      : 'Your account is signed in, but it does not have a CodeProctor candidate or proctor role yet.'
  const welcome = isProctor
    ? 'Your review desk is ready.'
    : isCandidate
      ? 'Your assessment workspace is ready.'
      : 'Welcome to CodeProctor.'

  return (
    <main className="relative min-h-full overflow-hidden bg-[#090d16] px-5 py-10 text-slate-100 sm:px-8 sm:py-14">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-36 -top-32 size-[32rem] rounded-full bg-indigo-500/[0.08] blur-3xl" />
        <div className="absolute left-1/4 top-48 h-80 w-80 rounded-full bg-emerald-500/[0.035] blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl">
        <header className="flex flex-col gap-6 border-b border-slate-800/80 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
                CodeProctor workspace
              </span>
              <span className="text-slate-700" aria-hidden="true">/</span>
              <Badge
                variant={domainRole ? 'outline' : isLoaded && isSignedIn ? 'warning' : 'outline'}
                className={
                  domainRole
                    ? 'border-indigo-300/20 bg-indigo-400/5 text-indigo-200'
                    : isLoaded && isSignedIn
                      ? ''
                      : 'border-slate-700 text-slate-300'
                }
              >
                {roleLabel}
              </Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {isLoaded && isSignedIn ? `Hello, ${name}.` : welcome}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              {isLoaded && isSignedIn ? roleDescription : 'Sign in to access your assessment workspace and session tools.'}
            </p>
          </div>

          <nav aria-label="Workspace shortcuts" className="flex flex-col gap-2 sm:flex-row">
            <Link
              to="/sessions"
              className={buttonVariants({
                size: 'lg',
                className:
                  'h-11 rounded-xl bg-indigo-400 px-5 text-slate-950 hover:bg-indigo-300',
              })}
            >
              Open sessions <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link
              to="/settings"
              className={buttonVariants({
                variant: 'outline',
                size: 'lg',
                className: 'h-11 rounded-xl border-slate-700 bg-slate-900/60 px-5 text-slate-200 hover:bg-slate-800',
              })}
            >
              <Settings2 aria-hidden="true" className="size-4" /> Settings
            </Link>
          </nav>
        </header>

        <section aria-labelledby="workspace-overview" className="grid gap-5 py-8 lg:grid-cols-[1.05fr_0.95fr]">
          <article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/10 sm:p-7">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-indigo-300/15 bg-indigo-400/10 text-indigo-200">
                {isProctor ? (
                  <ShieldCheck aria-hidden="true" className="size-5" />
                ) : isCandidate ? (
                  <BookOpenCheck aria-hidden="true" className="size-5" />
                ) : (
                  <CircleHelp aria-hidden="true" className="size-5" />
                )}
              </span>
              <div>
                <h2 id="workspace-overview" className="text-lg font-semibold text-white">
                  {isProctor ? 'Assessment review' : isCandidate ? 'Candidate workspace' : 'Workspace access'}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-300">{roleDescription}</p>
              </div>
            </div>

            {!domainRole && isLoaded && isSignedIn && (
              <p role="status" className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100/90">
                Ask your assessment administrator to assign a candidate or proctor role. Session access is still enforced by the server.
              </p>
            )}

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-[#090d16]/70 p-4">
                <Badge variant="success">Active</Badge>
                <p className="mt-3 text-xs font-medium text-slate-200">Live session</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Connected work is tracked in order.</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#090d16]/70 p-4">
                <Badge variant="warning">Needs review</Badge>
                <p className="mt-3 text-xs font-medium text-slate-200">Reviewer decision</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Signals guide human review, not verdicts.</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-[#090d16]/70 p-4">
                <Badge variant="destructive">Disconnected</Badge>
                <p className="mt-3 text-xs font-medium text-slate-200">Connection status</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Reconnects are represented in session history.</p>
              </div>
            </div>
          </article>

          <aside className="rounded-2xl border border-slate-800 bg-[#0f172a]/75 p-5 sm:p-7">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Session lifecycle
                </p>
                <h2 className="mt-2 text-lg font-semibold text-white">One ordered record</h2>
              </div>
              <span className="grid size-10 place-items-center rounded-xl bg-slate-800 text-indigo-200">
                <BookOpenCheck aria-hidden="true" className="size-5" />
              </span>
            </div>

            <div className="mt-6">
              <h3 className="text-xs font-medium text-slate-400">Lifecycle states</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge variant="warning">Pending</Badge>
                <Badge variant="success">Active</Badge>
                <Badge variant="info">Submitted</Badge>
                <Badge variant="outline" className="border-slate-700 text-slate-300">Timed out</Badge>
              </div>
            </div>

            <div className="mt-5">
              <h3 className="text-xs font-medium text-slate-400">Review dispositions</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge variant="outline" className="border-slate-700 text-slate-300">Unreviewed</Badge>
                <Badge variant="success">Clear</Badge>
                <Badge variant="warning">Needs review</Badge>
                <Badge variant="destructive">Flagged</Badge>
              </div>
            </div>

            <div className="mt-6 border-t border-slate-800 pt-5">
              <p className="text-xs leading-5 text-slate-400">
                Timeline points share a monotonic sequence. Snapshots and code edits let reviewers scrub to a prior state and inspect the surrounding browser events.
              </p>
            </div>
          </aside>
        </section>

        <footer className="flex flex-col gap-2 rounded-xl border border-amber-300/10 bg-amber-300/[0.035] px-4 py-4 text-xs leading-5 text-slate-300 sm:flex-row sm:items-center sm:gap-3 sm:px-5">
          <Badge variant="warning" className="w-fit shrink-0">Transparent monitoring</Badge>
          <p>
            Telemetry is limited to browser events such as tab focus, paste bursts, test runs, and connection state. CodeProctor does not use OS lockdown, webcams, or screen recording.
          </p>
        </footer>
      </div>
    </main>
  )
}
