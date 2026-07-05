/**
 * RESOURCE-HEALTH SNAPSHOT PUBLICATION (BE-9; blueprint §11, M6 freeze). The
 * governor's {@link ResourceHealthSnapshot} rides the EXISTING `events`
 * channel as the eleventh `read-model-snapshot` kind (readModels.ts, frozen
 * M6) — exactly like the ten §6.3 observability leads publish (BE-6
 * publisher.ts), so the FE consumes it through the SAME events-channel path.
 *
 * SELF-VALIDATION (the BE-6 discipline, copied deliberately): every snapshot
 * is passed through the frozen `validateEventsPayload` BEFORE publication. An
 * invalid snapshot is a PROGRAMMER error (the governor built a malformed frame)
 * so it THROWS (RangeError) — it is never a wire condition and never a
 * fabricated frame.
 *
 * The sink is a structural subset of the BE-3 GatewayHandle (`publishEvent`);
 * the composition root passes the live handle straight in.
 */

import { validateEventsPayload, type ResourceHealthSnapshot } from '@aibender/protocol';

/** Structural subset of the BE-3 GatewayHandle (the events publish surface). */
export interface ResourceHealthSink {
  publishEvent(payload: Readonly<Record<string, unknown>>): void;
}

export interface ResourceHealthPublisherOptions {
  readonly sink: ResourceHealthSink;
}

export interface ResourceHealthPublisher {
  /** Validate + publish one resource-health snapshot onto the events channel. */
  publish(snapshot: ResourceHealthSnapshot): void;
}

export function createResourceHealthPublisher(
  options: ResourceHealthPublisherOptions,
): ResourceHealthPublisher {
  return {
    publish: (snapshot) => {
      const result = validateEventsPayload(snapshot);
      if (!result.ok) {
        throw new RangeError(
          `refusing to publish an invalid resource-health snapshot: ${result.message}`,
        );
      }
      // The handle's pass-through takes the pre-M3 opaque record shape; the
      // union was validated above, so the widening is sound (mirrors
      // readmodels/publisher.ts).
      options.sink.publishEvent(snapshot as unknown as Readonly<Record<string, unknown>>);
    },
  };
}
