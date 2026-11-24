import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from 'deepspace'
import type { RecordData } from 'deepspace'
import type { AssessmentSession } from '../../domain/session'
import { useActorContext } from '../../hooks/useActorContext'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import { Badge, Button, buttonVariants } from '../ui'
import { CandidateSessionEntry, SessionStatus } from './CandidateSessionEntry'
import { CreateSessionForm } from './CreateSessionForm'

function timestamp(value: number | null): string {
  return value === null ? 'Not set' : new Date(value).toLocaleString()
}

function ProctorSessionList() {
  const { records, status, error } = useQuery<AssessmentSession>('assessment-sessions', {
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 50,
  })
  const [createdSessions, setCreatedSessions] = useState<AssessmentSession[]>([])
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const storedSessions = records.map((record: RecordData<AssessmentSession>) => ({
    ...record.data,
    id: record.recordId,
  }))
  const sessions = new Map<string, AssessmentSession>()
  for (const session of [...storedSessions, ...createdSessions]) sessions.set(session.id, session)
  const listedSessions = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt)

  async function startSession(sessionId: string) {
    setStartingSessionId(sessionId)
    setActionError(null)
    try {
      const updated = await callWorkerAction<AssessmentSession>('start_assessment_session', {
        sessionId,
      })
      setCreatedSessions((previous) => [
        updated,
        ...previous.filter((session) => session.id !== updated.id),
      ])
    } catch (error) {
      setActionError(getActionErrorMessage(error))
    } finally {
      setStartingSessionId(null)
    }
  }

  return (
    <>
      <CreateSessionForm
        onCreated={(session) =>
          setCreatedSessions((previous) => [
            session,
            ...previous.filter((existing) => existing.id !== session.id),
          ])
        }
      />

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Assessment sessions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Showing the latest 50 sessions. Updates arrive through the RecordRoom subscription.
            </p>
          </div>
          <Badge variant="outline">{listedSessions.length}</Badge>
        </div>

        {actionError && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {actionError}
          </p>
        )}
        {status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : status === 'error' ? (
          <p role="alert" className="text-sm text-destructive">{error ?? 'Could not load sessions.'}</p>
        ) : listedSessions.length === 0 ? (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No sessions yet. Create one above to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {listedSessions.map((session) => (
              <article key={session.id} className="space-y-4 rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{session.problem.title}</h3>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {session.id} · candidate {session.candidateId}
                    </p>
                  </div>
                  <SessionStatus status={session.status} />
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div><dt className="text-muted-foreground">Created</dt><dd>{timestamp(session.createdAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Started</dt><dd>{timestamp(session.startedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Deadline</dt><dd>{timestamp(session.expiresAt)}</dd></div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  {session.status === 'pending' && (
                    <Button
                      onClick={() => void startSession(session.id)}
                      loading={startingSessionId === session.id}
                      disabled={startingSessionId !== null && startingSessionId !== session.id}
                    >
                      Start session
                    </Button>
                  )}
                  <Link
                    className={buttonVariants({ variant: 'outline' })}
                    to={`/sessions/${encodeURIComponent(session.id)}`}
                  >
                    Open workspace
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export function SessionLobby() {
  const { isProctor, isCandidate, domainRole } = useActorContext()

  if (isProctor) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
        <header>
          <h1 className="text-2xl font-semibold">Proctor session lobby</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an assessment, activate pending sessions, and open a session workspace.
          </p>
        </header>
        <ProctorSessionList />
      </main>
    )
  }

  if (isCandidate) return <CandidateSessionEntry />

  return (
    <main className="mx-auto w-full max-w-3xl space-y-3 p-6">
      <h1 className="text-2xl font-semibold">Session lobby unavailable</h1>
      <p role="status" className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        {domainRole === null
          ? 'Your account does not have an active candidate or proctor role. Contact an assessment administrator.'
          : 'This account cannot access the session lobby.'}
      </p>
      <Link className={buttonVariants({ variant: 'outline' })} to="/home">Return home</Link>
    </main>
  )
}
