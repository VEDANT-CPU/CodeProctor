import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { assessmentSessionActions } from './assessment-sessions'

export const actions: Record<string, ActionHandler<Env>> = {
  ...assessmentSessionActions,
}
