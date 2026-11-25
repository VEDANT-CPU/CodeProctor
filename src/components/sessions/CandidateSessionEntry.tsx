import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { getEffectiveSessionStatus, type AssessmentSession } from '../../domain/session'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import { Badge, Button, Input, Label, buttonVariants } from '../ui'

type SessionStatusVariant = 'warning' | 'success' | 'secondary' | 'destructive'
const statusVariants: Record<AssessmentSession['status'], SessionStatusVariant> = {
  pending: 'warning',
  active: 'success',
  submitted: 'secondary',
  timed_out: 'destructive',
}

function formatTime(value: number | null): string {
  return value === null ? 'Not set' : new Date(value).toLocaleString()
}

function SessionStatus({ status }: { status: AssessmentSession['status'] }) {
  return <Badge variant={statusVariants[status]}>{status.replace('_', ' ')}</Badge>
}

function SessionSummary({ session }: { session: AssessmentSession }) {
  const effectiveStatus = getEffectiveSessionStatus(session)

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{session.problem.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Session ID: {session.id}</p>
        </div>
        <SessionStatus status={effectiveStatus} />
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Deadline</dt>
          <dd>{formatTime(session.expiresAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{formatTime(session.startedAt)}</dd>
        </div>
      </dl>
      {effectiveStatus === 'pending' && (
        <p className="text-sm text-muted-foreground">Waiting for the proctor to activate this session.</p>
      )}
      {effectiveStatus === 'active' ? (
        <Link
          className={buttonVariants()}
          to={`/sessions/${encodeURIComponent(session.id)}`}
        >
          Enter session workspace
        </Link>
      ) : (
        <p className="text-sm text-muted-foreground">
          {effectiveStatus === 'submitted'
            ? 'This assessment has been submitted.'
            : effectiveStatus === 'timed_out'
              ? 'This assessment has timed out.'
              : 'The workspace will be available after activation.'}
        </p>
      )}
    </section>
  )
}

export function CandidateSessionEntry() {
  const [assignedSession, setAssignedSession] = useState<AssessmentSession | null>(null)
  const [assignedLoading, setAssignedLoading] = useState(true)
  const [assignedError, setAssignedError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [joinedSession, setJoinedSession] = useState<AssessmentSession | null>(null)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    callWorkerAction<AssessmentSession | null>('get_my_assigned_session', {}, controller.signal)
      .then((session) => {
        if (!controller.signal.aborted) setAssignedSession(session)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setAssignedError(getActionErrorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setAssignedLoading(false)
      })
    return () => controller.abort()
  }, [])

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setJoining(true)
    setJoinError(null)
    try {
      const session = await callWorkerAction<AssessmentSession>('get_assessment_session', {
        sessionId: sessionId.trim(),
      })
      setAssignedError(null)
      setJoinedSession(session)
    } catch (error) {
      setJoinedSession(null)
      setJoinError(getActionErrorMessage(error))
    } finally {
      setJoining(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Candidate session lobby</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your session access is verified by the server. Enter a session ID if your proctor shared one.
        </p>
      </header>

      {assignedLoading ? (
        <p role="status" className="text-sm text-muted-foreground">Checking for an assigned session…</p>
      ) : assignedError ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {assignedError}
        </p>
      ) : assignedSession ? (
        <SessionSummary session={assignedSession} />
      ) : (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          No pending or active session is currently assigned to your account.
        </p>
      )}

      <form onSubmit={handleJoin} className="space-y-3 rounded-xl border border-border bg-card p-5">
        <div>
          <h2 className="text-lg font-semibold">Join by session ID</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The server will confirm that the session belongs to you or that you are its proctor.
          </p>
        </div>
        <Label htmlFor="join-session-id">Session ID</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="join-session-id"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="Paste the session ID"
            required
          />
          <Button type="submit" loading={joining} disabled={!sessionId.trim()}>
            Load session
          </Button>
        </div>
        {joinError && (
          <p role="alert" className="text-sm text-destructive">{joinError}</p>
        )}
      </form>

      {joinedSession && <SessionSummary session={joinedSession} />}
    </div>
  )
}

export { SessionStatus }
