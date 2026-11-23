import { describe, expect, it } from 'vitest'
import {
  canAccessSession,
  canCandidateMutateSession,
  canPerformAction,
  canTransitionSessionStatus,
  isTerminalSessionStatus,
} from './guards'
import type { ActorContext, SessionContext, SessionStatus } from './types'

const candidate: ActorContext = {
  userId: 'candidate-1',
  role: 'candidate',
  assignedSessionId: 'session-1',
}

const proctor: ActorContext = { userId: 'proctor-1', role: 'proctor' }

function session(status: SessionStatus = 'active'): SessionContext {
  return { sessionId: 'session-1', candidateId: 'candidate-1', status }
}

describe('session access guards', () => {
  it('limits candidates to their own assigned session', () => {
    expect(canAccessSession(candidate, session())).toBe(true)
    expect(
      canAccessSession(candidate, {
        ...session(),
        sessionId: 'session-2',
        candidateId: 'candidate-2',
      }),
    ).toBe(false)
    expect(
      canAccessSession(
        { ...candidate, assignedSessionId: 'session-other' },
        session(),
      ),
    ).toBe(false)
  })

  it('denies candidates access to review material and proctor-only actions', () => {
    expect(canPerformAction(candidate, 'view_review_notes', session())).toBe(false)
    expect(canPerformAction(candidate, 'create_integrity_flag', session())).toBe(false)
    expect(canPerformAction(candidate, 'create_assessment_session')).toBe(false)
  })

  it('allows candidate code, test, telemetry, and submission actions only while active', () => {
    for (const mutation of ['edit_code', 'run_tests', 'append_telemetry', 'submit_solution'] as const) {
      expect(canCandidateMutateSession(candidate, session('active'), mutation)).toBe(true)
      expect(canCandidateMutateSession(candidate, session('submitted'), mutation)).toBe(false)
      expect(canCandidateMutateSession(candidate, session('terminated'), mutation)).toBe(false)
    }

    expect(canPerformAction(candidate, 'view_session', session('terminated'))).toBe(true)
    expect(canPerformAction(candidate, 'view_assessment', session('submitted'))).toBe(false)
  })

  it('allows proctor review actions on completed sessions and creation without a session', () => {
    expect(canPerformAction(proctor, 'view_session', session('terminated'))).toBe(true)
    expect(canPerformAction(proctor, 'scrub_timeline', session('submitted'))).toBe(true)
    expect(canPerformAction(proctor, 'add_session_note', session('terminated'))).toBe(true)
    expect(canPerformAction(proctor, 'request_ai_overview', session('submitted'))).toBe(true)
    expect(canPerformAction(proctor, 'set_final_disposition', session('submitted'))).toBe(true)
    expect(canPerformAction(proctor, 'create_assessment_session')).toBe(true)
  })
})

describe('session lifecycle guards', () => {
  it('treats submitted and terminated sessions as terminal', () => {
    expect(isTerminalSessionStatus('submitted')).toBe(true)
    expect(isTerminalSessionStatus('terminated')).toBe(true)
    expect(isTerminalSessionStatus('pending')).toBe(false)
    expect(isTerminalSessionStatus('active')).toBe(false)
  })

  it('allows candidate submission and proctor activation or termination only', () => {
    expect(canTransitionSessionStatus(candidate, session('active'), 'submitted')).toBe(true)
    expect(canTransitionSessionStatus(candidate, session('active'), 'terminated')).toBe(false)
    expect(canTransitionSessionStatus(proctor, session('pending'), 'active')).toBe(true)
    expect(canTransitionSessionStatus(proctor, session('active'), 'terminated')).toBe(true)
    expect(canTransitionSessionStatus(proctor, session('submitted'), 'active')).toBe(false)
    expect(canTransitionSessionStatus(proctor, session('terminated'), 'active')).toBe(false)
  })
})
