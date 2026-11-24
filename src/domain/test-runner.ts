import type { CuratedTestCase, TestSuiteDescriptor } from './session.js'
import type { TestRunPayload } from './telemetry.js'

const DEFAULT_TIMEOUT_MS = 1_000

export type CuratedTestCaseResult = {
  caseId: string
  name: string
  status: 'passed' | 'failed' | 'error'
  message?: string
}

export interface CuratedTestSuiteResult {
  payload: TestRunPayload
  caseResults: CuratedTestCaseResult[]
}

export interface CuratedTestRunnerWorker {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: { message?: string }) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}

export interface CuratedTestRunnerOptions {
  timeoutMs?: number
  workerFactory?: (source: string) => CuratedTestRunnerWorker
}

interface WorkerMessage {
  type: 'case-start' | 'case-result' | 'done' | 'fatal'
  index?: number
  result?: CuratedTestCaseResult
  message?: string
}

const workerSource = String.raw`
const browserWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function';
const nodePort = browserWorker ? null : require('node:worker_threads').parentPort;
const postToParent = browserWorker ? self.postMessage.bind(self) : null;
const send = browserWorker
  ? (message) => postToParent(message)
  : (message) => nodePort.postMessage(message);

for (const api of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'postMessage']) {
  Object.defineProperty(globalThis, api, {
    value: undefined,
    configurable: false,
    writable: false,
  });
}

function normalizeCode(code) {
  return code
    .replace(/^\s*export\s+default\s+(?=(?:async\s+)?function\b)/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?function\b|(?:const|let|var)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

function findFunctionNames(code) {
  const names = new Set(['solve', 'solution']);
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

function sameValue(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right) ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
  ) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;

  if (seen.get(left) === right) return true;
  seen.set(left, right);

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key], seen));
}

function describe(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[unprintable value]';
  }
}

function resultFor(testCase, status, message) {
  return {
    caseId: testCase.id,
    name: testCase.name,
    status,
    ...(message ? { message } : {}),
  };
}

async function evaluateCase(code, testCase) {
  try {
    const normalizedCode = normalizeCode(code);
    if (testCase.kind === 'input_output') {
      const names = findFunctionNames(normalizedCode);
      const entry = names
        .map((name) => '(typeof ' + name + ' === "function" ? ' + name + ' : null)')
        .join(' || ') || 'null';
      const invoke = new Function(
        '__codeproctorInput',
        '"use strict";\n' + normalizedCode +
          '\n; const __codeproctorEntry = ' + entry +
          ';\nif (typeof __codeproctorEntry !== "function") throw new Error("No entry function found (define solve, solution, or a function declaration).");' +
          '\nreturn Array.isArray(__codeproctorInput) ? __codeproctorEntry(...__codeproctorInput) : __codeproctorEntry(__codeproctorInput);',
      );
      const actual = await invoke(testCase.input);
      return sameValue(actual, testCase.expectedOutput)
        ? resultFor(testCase, 'passed')
        : resultFor(
            testCase,
            'failed',
            'Expected ' + describe(testCase.expectedOutput) + ', received ' + describe(actual) + '.',
          );
    }

    const evaluateAssertion = new Function(
      '"use strict";\n' + normalizedCode + '\n; return Boolean(' + testCase.assertion + ');',
    );
    return await evaluateAssertion()
      ? resultFor(testCase, 'passed')
      : resultFor(testCase, 'failed', 'Assertion evaluated to false.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return resultFor(testCase, 'error', message);
  }
}

async function run(request) {
  for (let index = 0; index < request.suite.cases.length; index += 1) {
    send({ type: 'case-start', index });
    const result = await evaluateCase(request.code, request.suite.cases[index]);
    send({ type: 'case-result', index, result });
  }
  send({ type: 'done' });
}

function receive(request) {
  run(request).catch((error) => {
    send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  });
}

if (browserWorker) self.onmessage = (event) => receive(event.data);
else nodePort.on('message', receive);
`

function createBrowserWorker(source: string): CuratedTestRunnerWorker {
  const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const browserWorker = new Worker(objectUrl)
    const runnerWorker: CuratedTestRunnerWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        browserWorker.postMessage(message)
      },
      terminate() {
        browserWorker.terminate()
        URL.revokeObjectURL(objectUrl)
      },
    }
    browserWorker.onmessage = (event) => runnerWorker.onmessage?.({ data: event.data })
    browserWorker.onerror = (event) => runnerWorker.onerror?.({ message: event.message })
    return runnerWorker
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const message = value as { type?: unknown; index?: unknown; result?: unknown; message?: unknown }
  if (
    message.type !== 'case-start' &&
    message.type !== 'case-result' &&
    message.type !== 'done' &&
    message.type !== 'fatal'
  ) return false
  if (
    (message.type === 'case-start' || message.type === 'case-result') &&
    (!Number.isInteger(message.index) || (message.index as number) < 0)
  ) return false
  if (message.type === 'fatal' && typeof message.message !== 'string') return false
  if (message.type === 'case-result' && typeof message.result !== 'object') return false
  return true
}

function errorResult(testCase: CuratedTestCase, message: string): CuratedTestCaseResult {
  return { caseId: testCase.id, name: testCase.name, status: 'error', message }
}

function buildSuiteResult(
  suite: TestSuiteDescriptor,
  caseResults: CuratedTestCaseResult[],
  durationMs: number,
): CuratedTestSuiteResult {
  const passedCount = caseResults.filter((result) => result.status === 'passed').length
  return {
    payload: {
      suiteId: suite.id,
      passedCount,
      failedCount: caseResults.length - passedCount,
      durationMs: Math.max(0, Math.round(durationMs)),
    },
    caseResults,
  }
}

/**
 * Runs each curated case in a disposable, time-limited browser Worker.
 * Array inputs are treated as positional arguments; other inputs are passed
 * as one argument. This is a client-side test aid, not a trusted sandbox.
 */
export async function runCuratedTestSuite(
  code: string,
  suite: TestSuiteDescriptor,
  options: CuratedTestRunnerOptions = {},
): Promise<CuratedTestSuiteResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive safe integer')
  }
  if (suite.cases.length === 0) {
    return buildSuiteResult(suite, [], 0)
  }

  const startedAt = performance.now()
  const results: Array<CuratedTestCaseResult | undefined> = new Array(suite.cases.length)
  let activeIndex: number | null = null
  let worker: CuratedTestRunnerWorker

  try {
    worker = options.workerFactory
      ? options.workerFactory(workerSource)
      : createBrowserWorker(workerSource)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildSuiteResult(
      suite,
      suite.cases.map((testCase) => errorResult(testCase, `Could not start test runner: ${message}`)),
      performance.now() - startedAt,
    )
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (pendingMessage?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      const caseResults = suite.cases.map(
        (testCase, index) =>
          results[index] ??
          errorResult(testCase, pendingMessage ?? 'The test runner did not return a result.'),
      )
      resolve(buildSuiteResult(suite, caseResults, performance.now() - startedAt))
    }

    const timeout = setTimeout(() => {
      const message = `Test suite exceeded the ${timeoutMs} ms time limit.`
      for (let index = 0; index < suite.cases.length; index += 1) {
        if (results[index]) continue
        results[index] = errorResult(
          suite.cases[index],
          index === activeIndex ? message : 'Not run because the suite exceeded its time limit.',
        )
      }
      finish()
    }, timeoutMs)

    worker.onmessage = (event) => {
      if (!isWorkerMessage(event.data)) {
        finish('The test runner returned an invalid response.')
        return
      }
      if (event.data.type === 'case-start') {
        activeIndex = event.data.index ?? null
        return
      }
      if (event.data.type === 'case-result' && event.data.result) {
        const index = event.data.index as number
        if (index >= suite.cases.length) {
          finish('The test runner returned an out-of-range case result.')
          return
        }
        results[index] = event.data.result
        if (activeIndex === index) activeIndex = null
        return
      }
      if (event.data.type === 'fatal') {
        finish(`Test runner failed: ${event.data.message}`)
        return
      }
      if (event.data.type === 'done') finish()
    }
    worker.onerror = (event) => {
      finish(`Test runner failed: ${event.message ?? 'unknown worker error'}`)
    }

    try {
      worker.postMessage({ code, suite })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish(`Could not send tests to the runner: ${message}`)
    }
  })
}
