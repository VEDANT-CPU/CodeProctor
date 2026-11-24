import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SessionWorkspace } from '../../../../components/sessions/SessionWorkspace'
import type { TestRunPayload } from '../../../../domain/telemetry'
import { Button } from '../../../../components/ui'
import { callWorkerAction, getActionErrorMessage } from '../../../../lib/action-client'
import { SessionTelemetryCollector } from '../../../../lib/session-telemetry'

export default function SessionWorkspacePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [seededCollector, setSeededCollector] = useState<SessionTelemetryCollector | null>(null)
  const [sequenceError, setSequenceError] = useState<string | null>(null)
  const [seedAttempt, setSeedAttempt] = useState(0)
  const collector = useMemo(
    () =>
      sessionId
        ? new SessionTelemetryCollector(sessionId, {
            callAction: (name, params) => callWorkerAction<unknown>(name, params),
            isOnline: () => navigator.onLine,
          })
        : null,
    [sessionId],
  )

  useEffect(() => () => collector?.dispose(), [collector])

  useEffect(() => {
    let cancelled = false
    setSequenceError(null)
    if (!collector) {
      setSeededCollector(null)
      return () => {
        cancelled = true
      }
    }
    if (collector.hasPersistedSequenceState) {
      setSeededCollector(collector)
      return () => {
        cancelled = true
      }
    }

    setSeededCollector(null)
    callWorkerAction<{ nextSeq: number }>('get_session_timeline_sequence', { sessionId })
      .then(({ nextSeq }) => {
        if (cancelled) return
        collector.seedNextSequence(nextSeq)
        setSeededCollector(collector)
      })
      .catch((error: unknown) => {
        if (!cancelled) setSequenceError(getActionErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [collector, seedAttempt, sessionId])

  const onTestRunCompleted = useCallback(
    async (payload: TestRunPayload, code: string) => {
      if (!collector) return
      await collector.recordTelemetry('TEST_RUN', payload)
      await collector.recordSnapshot({
        trigger: 'test_run',
        suiteId: payload.suiteId,
        code,
      })
    },
    [collector],
  )

  return collector && seededCollector === collector ? (
    <SessionWorkspace
      collector={collector}
      onTestRunCompleted={onTestRunCompleted}
    />
  ) : collector && sequenceError ? (
    <main className="mx-auto w-full max-w-3xl space-y-3 p-6">
      <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        Could not initialize the session timeline sequence: {sequenceError}
      </p>
      <Button variant="outline" onClick={() => setSeedAttempt((attempt) => attempt + 1)}>
        Retry
      </Button>
    </main>
  ) : collector ? (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Preparing the session timeline…
    </p>
  ) : (
    <p role="alert" className="p-6 text-sm text-destructive">Session ID is missing.</p>
  )
}
