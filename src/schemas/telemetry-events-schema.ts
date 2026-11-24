import type { CollectionSchema } from 'deepspace/schema'

export const telemetryEventsSchema: CollectionSchema = {
  name: 'telemetry-events',
  ownerField: 'candidateId',
  columns: [
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'candidateId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'seq', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'clientTimestamp', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'serverReceivedAt', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    {
      name: 'type',
      storage: 'text',
      interpretation: {
        kind: 'select',
        options: [
          'FOCUS_LOST',
          'FOCUS_RESTORED',
          'LARGE_PASTE',
          'CODE_EDIT',
          'TEST_RUN',
          'CONNECTION_LOST',
          'CONNECTION_RECOVERED',
        ],
      },
      required: true,
      immutable: true,
    },
    { name: 'payload', storage: 'text', interpretation: 'json', required: true, immutable: true },
  ],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'own', create: false, update: false, delete: false },
    viewer: { read: 'own', create: false, update: false, delete: false },
  },
}
