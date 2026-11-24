import { useState, type FormEvent } from 'react'
import type { AssessmentSession, ProblemPrompt } from '../../domain/session'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import { Button, Input, Label, Textarea } from '../ui'

const sampleProblem: ProblemPrompt = {
  title: 'Add two values',
  prompt: 'Implement add(a, b) so it returns the sum of two numeric values.',
  starterCode: 'function add(a, b) {\n  // Return the sum of a and b.\n}',
  testSuites: [
    {
      id: 'examples',
      name: 'Examples',
      cases: [
        {
          id: 'positive-values',
          name: 'Adds positive values',
          kind: 'input_output',
          input: [2, 3],
          expectedOutput: 5,
        },
      ],
    },
    {
      id: 'behavior',
      name: 'Behavior',
      cases: [
        {
          id: 'returns-number',
          name: 'Returns a number',
          kind: 'assertion',
          assertion: 'typeof add(2, 3) === "number"',
        },
      ],
    },
  ],
}

interface CreateSessionFormProps {
  onCreated: (session: AssessmentSession) => void
}

export function CreateSessionForm({ onCreated }: CreateSessionFormProps) {
  const [candidateId, setCandidateId] = useState('')
  const [problem, setProblem] = useState<ProblemPrompt>(sampleProblem)
  const [durationMinutes, setDurationMinutes] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const session = await callWorkerAction<AssessmentSession>('create_assessment_session', {
        candidateId: candidateId.trim(),
        problem,
        expiresAt: Date.now() + durationMinutes * 60_000,
      })
      onCreated(session)
    } catch (actionError) {
      setError(getActionErrorMessage(actionError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold">Create an assessment</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign a candidate and set a deadline. The server verifies your proctor role.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="candidate-id">Candidate user ID</Label>
        <Input
          id="candidate-id"
          value={candidateId}
          onChange={(event) => setCandidateId(event.target.value)}
          placeholder="candidate user ID"
          required
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Problem</h3>
          <p className="text-xs text-muted-foreground">
            {problem.testSuites.length} sample suites ·{' '}
            {problem.testSuites.reduce((count, suite) => count + suite.cases.length, 0)} curated tests
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setProblem(sampleProblem)}>
          Load sample problem
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="problem-title">Title</Label>
        <Input
          id="problem-title"
          value={problem.title}
          onChange={(event) => setProblem({ ...problem, title: event.target.value })}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="problem-prompt">Prompt</Label>
        <Textarea
          id="problem-prompt"
          value={problem.prompt}
          onChange={(event) => setProblem({ ...problem, prompt: event.target.value })}
          rows={3}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="starter-code">Starter code</Label>
        <Textarea
          id="starter-code"
          value={problem.starterCode}
          onChange={(event) => setProblem({ ...problem, starterCode: event.target.value })}
          rows={4}
          className="font-mono text-sm"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="session-duration">Session duration</Label>
        <div className="flex items-center gap-2">
          <Input
            id="session-duration"
            type="number"
            min={5}
            max={240}
            step={5}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            required
          />
          <span className="text-sm text-muted-foreground">minutes</span>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" loading={loading} disabled={!candidateId.trim() || durationMinutes < 5 || durationMinutes > 240}>
        Create session
      </Button>
    </form>
  )
}
