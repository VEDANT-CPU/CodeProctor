import { describe, expect, it } from 'vitest'
import type { TestSuiteDescriptor } from './session'
import {
  runCuratedTestSuite,
  type CuratedTestRunnerOptions,
} from './test-runner'

interface NodeWorkerHandle {
  on(event: 'message', handler: (data: unknown) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  postMessage(message: unknown): void
  terminate(): Promise<number>
}

interface NodeWorkerModule {
  Worker: new (source: string, options: { eval: true }) => NodeWorkerHandle
}

const workerThreadsModuleName: string = 'node:worker_threads'
const workerThreadsModule: unknown = await import(workerThreadsModuleName)

function isNodeWorkerModule(value: unknown): value is NodeWorkerModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Worker' in value &&
    typeof value.Worker === 'function'
  )
}

if (!isNodeWorkerModule(workerThreadsModule)) {
  throw new Error('Node worker_threads is required for curated test runner tests')
}

const workerFactory: NonNullable<CuratedTestRunnerOptions['workerFactory']> = (source) => {
  const worker = new workerThreadsModule.Worker(source, { eval: true })
  let messageHandler: ((event: { data: unknown }) => void) | null = null
  let errorHandler: ((event: { message?: string }) => void) | null = null
  worker.on('message', (data: unknown) => messageHandler?.({ data }))
  worker.on('error', (error: Error) => errorHandler?.({ message: error.message }))

  return {
    get onmessage() {
      return messageHandler
    },
    set onmessage(handler) {
      messageHandler = handler
    },
    get onerror() {
      return errorHandler
    },
    set onerror(handler) {
      errorHandler = handler
    },
    postMessage(message) {
      worker.postMessage(message)
    },
    terminate() {
      void worker.terminate()
    },
  }
}

function suite(cases: TestSuiteDescriptor['cases']): TestSuiteDescriptor {
  return { id: 'suite-1', name: 'Examples', cases }
}

describe('runCuratedTestSuite', () => {
  it('runs input/output cases and compares structured results', async () => {
    const result = await runCuratedTestSuite(
      'export function add(a, b) { return { sum: a + b }; }',
      suite([
        {
          id: 'add',
          name: 'Adds values',
          kind: 'input_output',
          input: [2, 3],
          expectedOutput: { sum: 5 },
        },
      ]),
      { workerFactory },
    )

    expect(result.caseResults[0].status).toBe('passed')
    expect(result.payload).toMatchObject({ suiteId: 'suite-1', passedCount: 1, failedCount: 0 })
    expect(result.payload.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('marks a mismatched input/output result as failed', async () => {
    const result = await runCuratedTestSuite(
      'function solve(input) { return input + 1; }',
      suite([
        {
          id: 'wrong',
          name: 'Wrong output',
          kind: 'input_output',
          input: 2,
          expectedOutput: 4,
        },
      ]),
      { workerFactory },
    )

    expect(result.caseResults[0]).toMatchObject({ status: 'failed', message: 'Expected 4, received 3.' })
    expect(result.payload.failedCount).toBe(1)
  })

  it('compares array length during deep equality checks', async () => {
    const result = await runCuratedTestSuite(
      'function solve() { return [1]; }',
      suite([
        {
          id: 'array-length',
          name: 'Array length matters',
          kind: 'input_output',
          input: null,
          expectedOutput: [1, 2],
        },
      ]),
      { workerFactory },
    )

    expect(result.caseResults[0].status).toBe('failed')
  })

  it('evaluates assertion expressions with candidate declarations in scope', async () => {
    const result = await runCuratedTestSuite(
      'function add(a, b) { return a + b; }',
      suite([
        {
          id: 'assertion',
          name: 'Adds two values',
          kind: 'assertion',
          assertion: 'add(2, 3) === 5',
        },
      ]),
      { workerFactory },
    )

    expect(result.caseResults[0].status).toBe('passed')
  })

  it('reports a false assertion as failed', async () => {
    const result = await runCuratedTestSuite(
      'function add(a, b) { return a + b; }',
      suite([
        {
          id: 'assertion',
          name: 'False assertion',
          kind: 'assertion',
          assertion: 'add(2, 3) === 6',
        },
      ]),
      { workerFactory },
    )

    expect(result.caseResults[0]).toMatchObject({
      status: 'failed',
      message: 'Assertion evaluated to false.',
    })
  })

  it('captures syntax and runtime errors per case', async () => {
    const syntax = await runCuratedTestSuite(
      'function solve( {',
      suite([
        {
          id: 'syntax',
          name: 'Syntax error',
          kind: 'input_output',
          input: 1,
          expectedOutput: 1,
        },
      ]),
      { workerFactory },
    )
    const runtime = await runCuratedTestSuite(
      'function solve() { throw new Error("broken"); }',
      suite([
        {
          id: 'runtime',
          name: 'Runtime error',
          kind: 'input_output',
          input: 1,
          expectedOutput: 1,
        },
      ]),
      { workerFactory },
    )

    expect(syntax.caseResults[0].status).toBe('error')
    expect(runtime.caseResults[0]).toMatchObject({ status: 'error', message: 'broken' })
  })

  it('returns an empty successful summary for a suite with no cases', async () => {
    const result = await runCuratedTestSuite('function solve() {}', suite([]), { workerFactory })

    expect(result).toEqual({
      payload: { suiteId: 'suite-1', passedCount: 0, failedCount: 0, durationMs: 0 },
      caseResults: [],
    })
  })

  it('terminates code that exceeds the suite time limit', async () => {
    const result = await runCuratedTestSuite(
      'function solve() { while (true) {} }',
      suite([
        {
          id: 'hang',
          name: 'Non-terminating test',
          kind: 'input_output',
          input: null,
          expectedOutput: null,
        },
      ]),
      { workerFactory, timeoutMs: 250 },
    )

    expect(result.caseResults[0]).toMatchObject({
      status: 'error',
      message: 'Test suite exceeded the 250 ms time limit.',
    })
    expect(result.payload.durationMs).toBeGreaterThanOrEqual(0)
  })
})
