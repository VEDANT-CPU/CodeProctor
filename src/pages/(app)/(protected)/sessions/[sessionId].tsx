import { useCallback, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { SessionWorkspace } from '../../../../components/sessions/SessionWorkspace'
import type { TestRunPayload } from '../../../../domain/telemetry'
import { callWorkerAction } from '../../../../lib/action-client'
import { SessionTelemetryCollector } from '../../../../lib/session-telemetry'

export default function SessionWorkspacePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
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

  return collector ? (
    <SessionWorkspace
      collector={collector}
      onTestRunCompleted={onTestRunCompleted}
    />
  ) : (
    <p role="alert" className="p-6 text-sm text-destructive">Session ID is missing.</p>
  )
}
