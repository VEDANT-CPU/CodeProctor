import type { CollectionSchema } from 'deepspace/schema'

export const assessmentSessionsSchema: CollectionSchema = {
  name: 'assessment-sessions',
  ownerField: 'candidateId',
  columns: [
    { name: 'id', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'candidateId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'createdByProctorId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'problem', storage: 'text', interpretation: 'json', required: true },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['pending', 'active', 'submitted', 'timed_out'] },
      required: true,
    },
    { name: 'isConnected', storage: 'number', interpretation: 'boolean', required: true },
    { name: 'reconnectCount', storage: 'number', interpretation: 'plain', required: true },
    { name: 'createdAt', storage: 'number', interpretation: 'plain', required: true },
    { name: 'startedAt', storage: 'number', interpretation: 'plain', required: false, default: null },
    { name: 'submittedAt', storage: 'number', interpretation: 'plain', required: false, default: null },
    { name: 'expiresAt', storage: 'number', interpretation: 'plain', required: true },
    { name: 'lastSeenAt', storage: 'number', interpretation: 'plain', required: false, default: null },
    {
      name: 'disposition',
      storage: 'text',
      interpretation: { kind: 'select', options: ['unreviewed', 'clear', 'needs_review', 'flagged'] },
      required: false,
      default: 'unreviewed',
    },
    { name: 'dispositionedAt', storage: 'number', interpretation: 'plain', required: false, default: null },
    { name: 'dispositionedByProctorId', storage: 'text', interpretation: 'plain', required: false, default: null },
  ],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'own', create: false, update: false, delete: false },
    viewer: { read: 'own', create: false, update: false, delete: false },
  },
}
