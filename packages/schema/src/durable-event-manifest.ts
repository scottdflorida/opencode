export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { Orchestration } from "./orchestration"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const OrchestrationDurable = {
  definitions: Event.durable(Orchestration.Definitions),
  schema: Orchestration.Events,
} as const

export const Durable = Event.durable([
  ...Orchestration.Definitions,
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
