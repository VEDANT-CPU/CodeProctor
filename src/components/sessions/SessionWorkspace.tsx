import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  canAccessSession,
  canCandidateMutateSession,
  canPerformAction,
  canTransitionSessionStatus,
  isTerminalSessionStatus,
} from '../../domain/guards'
import { runCuratedTestSuite, type CuratedTestSuiteResult } from '../../domain/test-runner'
import { toSessionContext, type AssessmentSession } from '../../domain/session'
import { SNAPSHOT_INTERVAL_MS } from '../../domain/timeline'
import type { CodeEditPayload, TestRunPayload } from '../../domain/telemetry'
import { useActorContext } from '../../hooks/useActorContext'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import {
  FocusTransitionTracker,
  type FocusTelemetryTransition,
  type SessionTelemetryCollector,
} from '../../lib/session-telemetry'
import { Badge, Button, buttonVariants, ConfirmModal, Label, Textarea } from '../ui'

interface SessionWorkspaceProps {
  collector: SessionTelemetryCollector
  onTestRunCompleted?: (payload: TestRunPayload, code: string) => void | Promise<void>
}

function codeEdit(previous: string, next: string): CodeEditPayload | null {
  if (previous === next) return null
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start += 1
  }
  let suffixLength = 0
  while (
    suffixLength < previous.length - start &&
    suffixLength < next.length - start &&
    previous[previous.length - suffixLength - 1] === next[next.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }
  const end = previous.length - suffixLength
  return {
    start,
    deleteCount: end - start,
    deletedText: previous.slice(start, end),
    insertText: next.slice(start, next.length - suffixLength),
  }
}

export function SessionWorkspace({ collector, onTestRunCompleted }: SessionWorkspaceProps) {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { actor, isCandidate } = useActorContext()
  const [session, setSession] = useState<AssessmentSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [selectedSuiteId, setSelectedSuiteId] = useState('')
  const [testRun, setTestRun] = useState<CuratedTestSuiteResult | null>(null)
  const [runningTests, setRunningTests] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [pendingTelemetryCount, setPendingTelemetryCount] = useState(collector.pendingCount)
  const codeRef = useRef('')
  const lastPeriodicSnapshotCode = useRef<string | null>(null)
  const disconnectedAt = useRef<number | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setActionError(null)
    setSession(null)
    setTestRun(null)
    if (!sessionId) {
      setError('Session ID is missing.')
      setLoading(false)
      return
    }
    const controller = new AbortController()
    callWorkerAction<AssessmentSession>(
      'get_assessment_session',
      { sessionId },
      controller.signal,
    )
      .then(setSession)
      .catch((actionError: unknown) => setError(getActionErrorMessage(actionError)))
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [sessionId])

  const loadedSessionId = session?.id
  const starterCode = session?.problem.starterCode
  const firstSuiteId = session?.problem.testSuites[0]?.id ?? ''

  useEffect(() => {
    if (!loadedSessionId) return
    const initialCode = starterCode ?? ''
    codeRef.current = initialCode
    lastPeriodicSnapshotCode.current = initialCode
    setCode(initialCode)
    setSelectedSuiteId(firstSuiteId)
    setTestRun(null)
  }, [loadedSessionId, starterCode, firstSuiteId])

  const sessionContext = session ? toSessionContext(session) : null
  const canAccess = Boolean(
    actor && sessionContext && canAccessSession(actor, sessionContext),
  )
  const canEdit = Boolean(
    actor &&
      sessionContext &&
      canAccess &&
    !isTerminalSessionStatus(sessionContext.status) &&
      canCandidateMutateSession(actor, sessionContext, 'edit_code'),
  )
  const canRunTests = Boolean(
    actor &&
      sessionContext &&
      canAccess &&
      canCandidateMutateSession(actor, sessionContext, 'run_tests'),
  )
  const canSubmit = Boolean(
    actor &&
      sessionContext &&
      canAccess &&
    !isTerminalSessionStatus(sessionContext.status) &&
      canPerformAction(actor, 'submit_solution', sessionContext) &&
      canCandidateMutateSession(actor, sessionContext, 'submit_solution') &&
      canTransitionSessionStatus(actor, sessionContext, 'submitted'),
  )
  const selectedSuite = session?.problem.testSuites.find((suite) => suite.id === selectedSuiteId)

  useEffect(() => {
    collector.setErrorHandler((collectorError) => {
      setActionError(getActionErrorMessage(collectorError))
    })
    collector.setStatusHandler(setPendingTelemetryCount)
    return () => {
      collector.setErrorHandler(undefined)
      collector.setStatusHandler(undefined)
    }
  }, [collector])

  useEffect(() => {
    if (!canEdit || !session) return

    const report = (operation: Promise<unknown>) => {
      void operation.catch((telemetryError: unknown) => {
        setActionError(getActionErrorMessage(telemetryError))
      })
    }

    const handleOffline = () => {
      if (disconnectedAt.current !== null) return
      disconnectedAt.current = Date.now()
      report(
        collector
          .recordTelemetry('CONNECTION_LOST', {
            bufferedEventCount: collector.pendingTelemetryCount,
            reason: 'offline',
          })
          .then(() => collector.setConnection(false)),
      )
    }

    const handleOnline = () => {
      const disconnectedSince = disconnectedAt.current
      const flushedEventCount = collector.pendingTelemetryCount
      report(
        collector.setConnection(true).then(async () => {
          if (disconnectedSince === null) return
          await collector.recordTelemetry('CONNECTION_RECOVERED', {
            disconnectDurationMs: Math.max(0, Date.now() - disconnectedSince),
            flushedEventCount,
          })
          disconnectedAt.current = null
        }),
      )
    }

    const focusTracker = new FocusTransitionTracker()
    const recordFocusTransition = (transition: FocusTelemetryTransition | null) => {
      if (!transition) return
      if (transition.type === 'FOCUS_LOST') {
        report(collector.recordTelemetry('FOCUS_LOST', transition.payload))
      } else {
        report(collector.recordTelemetry('FOCUS_RESTORED', transition.payload))
      }
    }

    const handleBlur = () => recordFocusTransition(
      focusTracker.onBlur(document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
    )
    const handleFocus = () => recordFocusTransition(
      focusTracker.onFocus(document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
    )
    const handleVisibilityChange = () => {
      recordFocusTransition(
        focusTracker.onVisibilityChange(document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
      )
    }

    if (navigator.onLine) {
      report(collector.setConnection(true, true))
    } else {
      handleOffline()
    }
    if (document.visibilityState === 'hidden') {
      recordFocusTransition(focusTracker.onVisibilityChange('hidden'))
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (collector.connectionState !== false) {
        report(collector.setConnection(false))
      }
    }
  }, [canEdit, collector, session?.id])

  useEffect(() => {
    if (!canEdit || !session) return
    const timer = window.setInterval(() => {
      const currentCode = codeRef.current
      if (currentCode === lastPeriodicSnapshotCode.current) return
      lastPeriodicSnapshotCode.current = currentCode
      void collector
        .recordSnapshot({ trigger: 'periodic', code: currentCode })
        .catch((snapshotError: unknown) => {
          lastPeriodicSnapshotCode.current = null
          setActionError(getActionErrorMessage(snapshotError))
        })
    }, SNAPSHOT_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [canEdit, collector, session?.id])

  function updateCode(nextCode: string) {
    const patch = codeEdit(codeRef.current, nextCode)
    codeRef.current = nextCode
    setCode(nextCode)
    setTestRun(null)
    if (patch && canEdit) {
      void collector.recordTelemetry('CODE_EDIT', patch).catch((telemetryError: unknown) => {
        setActionError(getActionErrorMessage(telemetryError))
      })
    }
  }

  async function handleRunSuite() {
    if (!selectedSuite || !canRunTests) return
    setRunningTests(true)
    setActionError(null)
    let result: CuratedTestSuiteResult
    try {
      result = await runCuratedTestSuite(code, selectedSuite)
    } catch (runnerError) {
      setActionError(getActionErrorMessage(runnerError))
      setRunningTests(false)
      return
    }
    setTestRun(result)
    lastPeriodicSnapshotCode.current = code
    try {
      await onTestRunCompleted?.(result.payload, code)
    } catch (telemetryError) {
      setActionError(getActionErrorMessage(telemetryError))
    } finally {
      setRunningTests(false)
    }
  }

  async function handleSubmitSolution() {
    if (!session || !canSubmit || runningTests) return
    setSubmitting(true)
    setActionError(null)
    try {
      await collector.recordSnapshot({ trigger: 'final_submit', code })
      await collector.flush()
      if (collector.pendingCount > 0) {
        throw new Error('Reconnect to send pending session telemetry before submitting.')
      }
      await collector.setConnection(false)
      if (collector.pendingCount > 0) {
        throw new Error('Reconnect to update session connection state before submitting.')
      }
      const submittedSession = await callWorkerAction<AssessmentSession>(
        'submit_assessment_session',
        { sessionId: session.id },
      )
      setSession(submittedSession)
      setConfirmSubmit(false)
    } catch (submitError) {
      setActionError(getActionErrorMessage(submitError))
      if (navigator.onLine && session.status === 'active') {
        void collector.setConnection(true).catch((connectionError: unknown) => {
          setActionError(getActionErrorMessage(connectionError))
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <Link className={buttonVariants({ variant: 'outline' })} to="/sessions">Back to sessions</Link>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">Loading session…</p>
      ) : error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : session ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{session.problem.title}</h1>
              <p className="mt-1 break-all text-sm text-muted-foreground">Session {session.id}</p>
            </div>
            <Badge variant={session.status === 'active' ? 'success' : 'secondary'}>
              {session.status.replace('_', ' ')}
            </Badge>
          </header>
          {isCandidate && session.status !== 'active' ? (
            <p role="status" className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              {session.status === 'pending'
                ? 'This session is waiting for proctor activation.'
                : session.status === 'submitted'
                  ? `This session was submitted${session.submittedAt ? ` at ${new Date(session.submittedAt).toLocaleString()}` : ''}.`
                  : 'This session has timed out.'}
            </p>
          ) : (
            <>
              <section className="rounded-xl border border-border bg-card p-5">
                <h2 className="font-semibold">Assessment prompt</h2>
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{session.problem.prompt}</p>
              </section>
              <section className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-semibold">JavaScript workspace</h2>
                  {canSubmit && (
                    <Button disabled={runningTests} onClick={() => setConfirmSubmit(true)}>
                      Submit Solution
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Tests run in a time-limited browser Worker. This client-side runner is not a security boundary or server-side verification.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Monitoring is limited to browser tab focus, paste bursts, test runs, and connection status. There is no OS lockdown, webcam monitoring, or screen recording.
                </p>
                {pendingTelemetryCount > 0 && (
                  <p role="status" className="mt-2 text-sm text-muted-foreground">
                    {pendingTelemetryCount} telemetry item{pendingTelemetryCount === 1 ? '' : 's'} queued and will retry when the connection is available.
                  </p>
                )}
                {!canAccess && actor && (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    Your current actor is not authorized to use this session.
                  </p>
                )}
                {actor?.role === 'proctor' && (
                  <p className="mt-3 text-sm text-muted-foreground">Proctor view is read-only.</p>
                )}
                {actionError && (
                  <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {actionError}
                  </p>
                )}
                {session.status === 'submitted' && (
                  <p role="status" className="mt-3 text-sm text-muted-foreground">
                    Solution submitted{session.submittedAt ? ` at ${new Date(session.submittedAt).toLocaleString()}` : ''}. Editing and submission are locked.
                  </p>
                )}
                <div className="mt-4 space-y-2">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <Label htmlFor="candidate-code">Your code</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit || code === session.problem.starterCode}
                      onClick={() => {
                        updateCode(session.problem.starterCode)
                      }}
                    >
                      Reset to Starter
                    </Button>
                  </div>
                  <Textarea
                    id="candidate-code"
                    aria-label="JavaScript code"
                    className="min-h-72 font-mono text-sm"
                    rows={16}
                    spellCheck={false}
                    readOnly={!canEdit}
                    value={code}
                    onChange={(event) => updateCode(event.target.value)}
                    onPaste={(event) => {
                      if (!canEdit) return
                      const pastedText = event.clipboardData.getData('text/plain')
                      const characterCount = pastedText.length
                      if (characterCount <= 120) return
                      void collector
                        .recordTelemetry('LARGE_PASTE', {
                          characterCount,
                          lineCount: pastedText.split(/\r\n|\r|\n/).length,
                          source: 'clipboard',
                        })
                        .catch((telemetryError: unknown) => {
                          setActionError(getActionErrorMessage(telemetryError))
                        })
                    }}
                  />
                </div>
                {canRunTests ? (
                  <section className="mt-6 space-y-4 border-t border-border pt-5" aria-labelledby="curated-tests-heading">
                    <h3 id="curated-tests-heading" className="font-semibold">Curated tests</h3>
                    <p className="text-sm text-muted-foreground">
                      Assertion cases are JavaScript expressions evaluated with candidate functions in scope. Array inputs are passed as positional arguments.
                    </p>
                    {session.problem.testSuites.length > 0 ? (
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-52 flex-1 space-y-2">
                          <Label htmlFor="test-suite">Test suite</Label>
                          <select
                            id="test-suite"
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={selectedSuiteId}
                            onChange={(event) => {
                              setSelectedSuiteId(event.target.value)
                              setTestRun(null)
                            }}
                          >
                            {session.problem.testSuites.map((suite) => (
                              <option key={suite.id} value={suite.id}>{suite.name}</option>
                            ))}
                          </select>
                        </div>
                        <Button disabled={!selectedSuite || runningTests} loading={runningTests} onClick={handleRunSuite}>
                          Run Suite
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No curated test suites are configured.</p>
                    )}
                    {testRun && (
                      <div className="space-y-3" aria-live="polite">
                        <p role="status" className="text-sm">
                          {testRun.payload.passedCount} passed, {testRun.payload.failedCount} failed in {testRun.payload.durationMs} ms.
                        </p>
                        <ul className="space-y-2">
                          {testRun.caseResults.map((result, index) => (
                            <li
                              key={`${result.caseId}-${index}`}
                              className="flex flex-wrap items-start gap-2 rounded-md border border-border p-3 text-sm"
                            >
                              <Badge variant={result.status === 'passed' ? 'success' : result.status === 'error' ? 'secondary' : 'destructive'}>
                                {result.status}
                              </Badge>
                              <div>
                                <p className="font-medium">{result.name}</p>
                                {result.message && <p className="mt-1 text-muted-foreground">{result.message}</p>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                ) : canEdit ? null : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {actor?.role === 'proctor'
                      ? 'Only the assigned candidate can run or submit code.'
                      : 'Code editing, tests, and submission are available only to the assigned candidate during an active session.'}
                  </p>
                )}
              </section>
            </>
          )}
        </>
      ) : null}
      <ConfirmModal
        open={confirmSubmit}
        onClose={() => setConfirmSubmit(false)}
        onConfirm={handleSubmitSolution}
        title="Submit this solution?"
        description="This ends the active session. The current code remains in this browser and is not persisted in the session record."
        confirmText="Submit Solution"
        variant="default"
        loading={submitting}
      />
    </main>
  )
}
