import type { CollectionSchema } from 'deepspace/schema'

export const codeSnapshotsSchema: CollectionSchema = {
  name: 'code-snapshots',
  ownerField: 'candidateId',
  columns: [
    { name: 'snapshotId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'candidateId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'seq', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'clientTimestamp', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'serverReceivedAt', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    {
      name: 'trigger',
      storage: 'text',
      interpretation: { kind: 'select', options: ['periodic', 'test_run', 'final_submit'] },
      required: true,
      immutable: true,
    },
    { name: 'code', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'suiteId', storage: 'text', interpretation: 'plain', required: false, immutable: true },
  ],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'own', create: false, update: false, delete: false },
    viewer: { read: 'own', create: false, update: false, delete: false },
  },
}
