import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { assessmentSessionActions, requestAiOverview } from './assessment-sessions'

export { requestAiOverview }

export const actions: Record<string, ActionHandler<Env>> = {
  ...assessmentSessionActions,
}
