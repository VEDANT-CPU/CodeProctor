/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { assessmentSessionsSchema } from './schemas/assessment-sessions-schema'
import { telemetryEventsSchema } from './schemas/telemetry-events-schema'
import { codeSnapshotsSchema } from './schemas/code-snapshots-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  assessmentSessionsSchema,
  telemetryEventsSchema,
  codeSnapshotsSchema,
]
