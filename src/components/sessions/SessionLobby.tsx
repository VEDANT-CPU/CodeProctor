import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from 'deepspace'
import type { RecordData } from 'deepspace'
import type { ReviewDisposition } from '../../domain/review'
import { getEffectiveSessionStatus, type AssessmentSession } from '../../domain/session'
import type { CodeSnapshot, TelemetryEvent } from '../../domain/telemetry'
import { useActorContext } from '../../hooks/useActorContext'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import { Badge, Button, buttonVariants } from '../ui'
import { CandidateSessionEntry, SessionStatus } from './CandidateSessionEntry'
import { CreateSessionForm } from './CreateSessionForm'
import {
  SessionTimelineInspector,
  dispositionBadgeVariant,
} from './SessionTimelineInspector'

type PersistedTelemetryEvent = TelemetryEvent & { candidateId: string }
type PersistedCodeSnapshot = CodeSnapshot & { candidateId: string }

function timestamp(value: number | null): string {
  return value === null ? 'Not set' : new Date(value).toLocaleString()
}

function SessionDispositionBadge({ disposition }: { disposition: ReviewDisposition }) {
  return (
    <Badge variant={dispositionBadgeVariant(disposition)}>
      {disposition.replace('_', ' ')}
    </Badge>
  )
}

function ProctorSessionList() {
  const { records, status, error } = useQuery<AssessmentSession>('assessment-sessions', {
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 50,
  })
  const {
    records: telemetryRecords,
    status: telemetryStatus,
    error: telemetryError,
  } = useQuery<PersistedTelemetryEvent>('telemetry-events', {
    orderBy: 'serverReceivedAt',
    orderDir: 'desc',
    limit: 200,
  })
  const {
    records: snapshotRecords,
    status: snapshotStatus,
    error: snapshotError,
  } = useQuery<PersistedCodeSnapshot>('code-snapshots', {
    orderBy: 'serverReceivedAt',
    orderDir: 'desc',
    limit: 200,
  })
  const [createdSessions, setCreatedSessions] = useState<AssessmentSession[]>([])
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null)
  const [updatingDispositionId, setUpdatingDispositionId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  const storedSessions = records.map((record: RecordData<AssessmentSession>) => ({
    ...record.data,
    id: record.recordId,
  }))
  const sessions = new Map<string, AssessmentSession>()
  for (const session of [...storedSessions, ...createdSessions]) sessions.set(session.id, session)
  const listedSessions = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt)

  async function updateDisposition(sessionId: string, disposition: ReviewDisposition) {
    setUpdatingDispositionId(sessionId)
    setActionError(null)
    try {
      const updated = await callWorkerAction<AssessmentSession>('set_session_disposition', {
        sessionId,
        disposition,
      })
      setCreatedSessions((previous) => [
        updated,
        ...previous.filter((session) => session.id !== updated.id),
      ])
    } catch (error) {
      setActionError(getActionErrorMessage(error))
    } finally {
      setUpdatingDispositionId(null)
    }
  }

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
        {telemetryStatus === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {telemetryError ?? 'Could not load recent telemetry.'}
          </p>
        )}
        {snapshotStatus === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {snapshotError ?? 'Could not load recent code snapshots.'}
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
            {listedSessions.map((session) => {
              const recentTelemetry = telemetryRecords
                .map((record: RecordData<PersistedTelemetryEvent>) => record.data)
                .filter((event) => event.sessionId === session.id)
              const recentSnapshots = snapshotRecords
                .map((record: RecordData<PersistedCodeSnapshot>) => record.data)
                .filter((snapshot) => snapshot.sessionId === session.id)
              const latestEvent = recentTelemetry.reduce<PersistedTelemetryEvent | null>(
                (latest, event) => !latest || event.seq > latest.seq ? event : latest,
                null,
              )
              const latestSnapshot = recentSnapshots.reduce<PersistedCodeSnapshot | null>(
                (latest, snapshot) => !latest || snapshot.seq > latest.seq ? snapshot : latest,
                null,
              )

              const effectiveStatus = getEffectiveSessionStatus(session)

              return (
                <article key={session.id} className="space-y-4 rounded-xl border border-border bg-card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{session.problem.title}</h3>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {session.id} · candidate {session.candidateId}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SessionDispositionBadge disposition={session.disposition ?? 'unreviewed'} />
                      <SessionStatus status={effectiveStatus} />
                    </div>
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-3">
                    <div><dt className="text-muted-foreground">Created</dt><dd>{timestamp(session.createdAt)}</dd></div>
                    <div><dt className="text-muted-foreground">Started</dt><dd>{timestamp(session.startedAt)}</dd></div>
                    <div><dt className="text-muted-foreground">Deadline</dt><dd>{timestamp(session.expiresAt)}</dd></div>
                    <div><dt className="text-muted-foreground">Connection</dt><dd>{session.isConnected ? 'Connected' : 'Disconnected'}</dd></div>
                    <div><dt className="text-muted-foreground">Reconnects</dt><dd>{session.reconnectCount}</dd></div>
                    <div><dt className="text-muted-foreground">Last seen</dt><dd>{timestamp(session.lastSeenAt)}</dd></div>
                  </dl>
                  {(session.status === 'active' || recentTelemetry.length > 0 || recentSnapshots.length > 0) && (
                    <div className="rounded-md bg-muted/50 p-3 text-sm">
                      <p className="font-medium">Live activity</p>
                      <p className="mt-1 text-muted-foreground">
                        {recentTelemetry.length} recent telemetry events · {recentSnapshots.length} recent snapshots (from latest 200 per collection)
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        Latest event: {latestEvent ? `${latestEvent.type} · seq ${latestEvent.seq}` : 'None'}
                      </p>
                      <p className="text-muted-foreground">
                        Latest snapshot: {latestSnapshot ? `${latestSnapshot.trigger} · seq ${latestSnapshot.seq}` : 'None'}
                      </p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {effectiveStatus === 'pending' && (
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
                    <Button
                      variant={selectedSessionId === session.id ? 'default' : 'outline'}
                      aria-expanded={selectedSessionId === session.id}
                      onClick={() =>
                        setSelectedSessionId((selected) =>
                          selected === session.id ? null : session.id,
                        )
                      }
                    >
                      {selectedSessionId === session.id ? 'Timeline open' : 'Inspect timeline'}
                    </Button>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">Review:</span>
                      <select
                        aria-label={`Update disposition for session ${session.id}`}
                        className="h-8 rounded-md border border-border bg-background px-2 py-1 text-xs"
                        value={session.disposition ?? 'unreviewed'}
                        disabled={updatingDispositionId === session.id}
                        onChange={(e) =>
                          void updateDisposition(session.id, e.target.value as ReviewDisposition)
                        }
                      >
                        <option value="unreviewed">Unreviewed</option>
                        <option value="clear">Clear</option>
                        <option value="needs_review">Needs review</option>
                        <option value="flagged">Flagged</option>
                      </select>
                    </div>
                  </div>
                  {selectedSessionId === session.id && (
                    <SessionTimelineInspector
                      session={session}
                      onClose={() => setSelectedSessionId(null)}
                      onSessionUpdated={(updated) =>
                        setCreatedSessions((previous) => [
                          updated,
                          ...previous.filter((s) => s.id !== updated.id),
                        ])
                      }
                    />
                  )}
                </article>
              )
            })}
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
