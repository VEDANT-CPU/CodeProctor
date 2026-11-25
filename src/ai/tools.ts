/**
 * AI Tool Definitions — converts DeepSpace BUILT_IN_TOOLS to Vercel AI SDK tools.
 *
 * The assistant can read AND modify data. Per-collection RBAC at the DO
 * layer is the actual security boundary — the user's role determines what
 * each tool call is allowed to do, regardless of what's in this allowlist.
 * Trim entries below if you want a stricter assistant for your app.
 */

import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod/v4'
import { BUILT_IN_TOOLS, applyAiToolDefaults } from 'deepspace/worker'
import type { ToolSchema, CollectionSchema } from 'deepspace/worker'

type ToolExecutor = (toolName: string, params: Record<string, unknown>) => Promise<unknown>

const ALLOWED_TOOL_NAMES = [
  'schema.list',
  'schema.describe',
  'records.query',
  'records.get',
  'records.create',
  'records.update',
  'records.delete',
  'user.current',
  'ai_brief.request',
]

// ============================================================================
// System prompt
// ============================================================================

type Interpretation = CollectionSchema['columns'][number]['interpretation']

/**
 * Interpretation is `string | Record<string, unknown>`. When it's an object
 * the convention across the SDK's schemas is `{ kind: string, ... }`.
 * Narrow safely to a human-readable name.
 */
function interpretationLabel(interpretation: Interpretation): string {
  if (typeof interpretation === 'string') return interpretation
  const kind = interpretation.kind
  return typeof kind === 'string' ? kind : 'object'
}

export function buildSystemPrompt(appName: string, schemas: CollectionSchema[]): string {
  const schemaSummary = schemas
    .map((s) => {
      const cols = (s.columns ?? [])
        .map((c) => `${c.name}:${interpretationLabel(c.interpretation)}${c.required ? '!' : ''}`)
        .join(', ')
      return `- ${s.name}${cols ? ` (${cols})` : ''}`
    })
    .join('\n')

  return [
    `You are the assistant for the "${appName}" app on DeepSpace.`,
    "You can read and modify the user's data via the available tools. The",
    "user's own role and permissions still apply at the data layer — your",
    'tool calls run as the calling user, so you can only do what they could.',
    '',
    'Be careful with mutations:',
    '- Confirm intent before destructive actions (delete, bulk update).',
    '- Operate only on collections the user explicitly mentioned.',
    '- After a successful write, briefly confirm what changed.',
    '- If a write is denied (RBAC), tell the user plainly — do not retry blindly.',
    '',
    'Use tools to look up facts before answering. Do not invent data.',
    'If data is missing, say so plainly. Keep answers concise.',
    '',
    '## AI Incident Briefs (Proctors only)',
    'Use the `ai_brief_request` tool to generate an AiIncidentBrief for a session window.',
    'The brief contains:',
    '  - `summary`: concise text grounded only in browser-level telemetry signals',
    '  - `citations`: an array of IncidentCitation references, each of which has:',
    '      - `source`: one of "telemetry_event" | "snapshot" | "code_diff"',
    '      - `sessionId`, `seq`, `timestamp`: exact (session, sequence, epoch-ms) position',
    '      - for telemetry_event: `eventType` (e.g. "FOCUS_LOST", "LARGE_PASTE")',
    '      - for snapshot: `snapshotId`',
    '  - `startSeq` / `endSeq` / `startTimestamp` / `endTimestamp`: the window reviewed',
    '  - `incidentKind` (optional): the deterministic rule kind (e.g. "PASTE_AFTER_TAB_ABSENCE")',
    'When presenting a brief, always render citations with their seq and timestamp so the',
    'proctor can jump directly to the evidence in the timeline inspector.',
    'Only cite records from the target sessionId within the requested window.',
    'Never claim these signals are proof of misconduct — they are browser-level triage aids.',
    '',
    'Available collections:',
    schemaSummary || '(none)',
  ].join('\n')
}

// ============================================================================
// Tool definitions
// ============================================================================

export function buildTools(executor: ToolExecutor): ToolSet {
  const tools: ToolSet = {}

  for (const def of BUILT_IN_TOOLS) {
    if (!ALLOWED_TOOL_NAMES.includes(def.name)) continue
    const safeName = def.name.replace('.', '_')
    tools[safeName] = tool({
      description: def.description,
      inputSchema: buildInputSchema(def),
      // Apply assistant-only param defaults (e.g. records.query page size) here
      // in the AI tool layer, so internal record readers that hit the tools
      // dispatch directly stay unbounded.
      execute: async (params: Record<string, unknown>) =>
        executor(def.name, applyAiToolDefaults(def.name, params)),
    })
  }

  // Register the AI incident brief action as a first-class tool so the
  // in-app assistant and local agent can invoke `request_ai_overview` through
  // the same executor pathway that all other actions use.  The name is
  // intentionally distinct from the kebab-case action name so it does not
  // collide with built-in tool names.
  tools['ai_brief_request'] = tool({
    description:
      'Generate an AI-assisted incident brief for a session window. ' +
      'Accepts sessionId (required), incidentId (optional — narrows to a specific deterministic incident), ' +
      'and optional sequence/timestamp bounds (startSeq, endSeq, startTimestamp, endTimestamp). ' +
      'Returns an AiIncidentBrief with a summary grounded in browser-level telemetry signals ' +
      'and IncidentCitation references (telemetry_event, snapshot, code_diff) that link back to ' +
      'exact (seq, timestamp) positions in the session timeline. ' +
      'Only proctors may call this tool; candidates receive a forbidden error.',
    inputSchema: jsonSchema<Record<string, unknown>>(
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Assessment session ID to summarize.' },
          incidentId: {
            type: 'string',
            description: 'Optional deterministic incident ID to focus the brief on.',
          },
          startSeq: { type: 'number', description: 'Inclusive start of the sequence window.' },
          endSeq: { type: 'number', description: 'Inclusive end of the sequence window.' },
          startTimestamp: {
            type: 'number',
            description: 'Inclusive start epoch-ms timestamp for the review window.',
          },
          endTimestamp: {
            type: 'number',
            description: 'Inclusive end epoch-ms timestamp for the review window.',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      {
        validate: async (value) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            typeof (value as Record<string, unknown>).sessionId !== 'string'
          ) {
            return { success: false, error: new Error('sessionId is required') }
          }
          return { success: true, value: value as Record<string, unknown> }
        },
      },
    ),
    execute: async (params: Record<string, unknown>) =>
      executor('request_ai_overview', params),
  })

  return tools
}

// ============================================================================
// Convert ToolSchema params → Zod validator + derived provider JSON Schema
// ============================================================================

/**
 * The Zod validator is the single source; the provider-facing JSON Schema is
 * derived from it with Zod's native conversion, which keeps z.record()
 * objects open (`additionalProperties: {}`). The AI SDK's own Zod conversion
 * closes every object, which would incorrectly advertise the free-form
 * `data` and `where` objects as empty — so the conversion happens here.
 */
function buildInputSchema(def: ToolSchema) {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [name, param] of Object.entries(def.params)) {
    let s: z.ZodTypeAny
    switch (param.type) {
      case 'string':
        s = z.string()
        break
      case 'number':
        s = z.number()
        break
      case 'boolean':
        s = z.boolean()
        break
      case 'object':
        s = z.record(z.string(), z.unknown())
        break
      case 'array':
        s = z.array(z.unknown())
        break
    }
    if (param.description) s = s.describe(param.description)
    if (!param.required) s = s.optional()
    shape[name] = s
  }

  const validator = z.object(shape)
  return jsonSchema<Record<string, unknown>>(
    z.toJSONSchema(validator) as Parameters<typeof jsonSchema>[0],
    {
      validate: async (value) => {
        const result = await validator.safeParseAsync(value)
        return result.success
          ? { success: true, value: result.data }
          : { success: false, error: result.error }
      },
    },
  )
}
