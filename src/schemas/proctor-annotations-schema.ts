import type { CollectionSchema } from 'deepspace/schema'

export const proctorAnnotationsSchema: CollectionSchema = {
  name: 'proctor-annotations',
  ownerField: 'proctorId',
  columns: [
    { name: 'id', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'sessionId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'proctorId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'notes', storage: 'text', interpretation: 'plain', required: true },
    {
      name: 'disposition',
      storage: 'text',
      interpretation: { kind: 'select', options: ['unreviewed', 'clear', 'needs_review', 'flagged'] },
      required: true,
    },
    { name: 'incidentId', storage: 'text', interpretation: 'plain', required: false },
    { name: 'anchor', storage: 'text', interpretation: 'json', required: false },
    { name: 'createdAt', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'updatedAt', storage: 'number', interpretation: 'plain', required: true },
  ],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: false, create: false, update: false, delete: false },
    viewer: { read: false, create: false, update: false, delete: false },
  },
}
