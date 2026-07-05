/**
 * §9.3 BE↔SI #3 + #4 (synthetic halves) — SI-3's telemetry wiring lands in
 * BE-5's collector exactly as the contract says.
 *
 *   #3s: a hook POST shaped by SI-3's settings template is accepted by BE-5's
 *        hooks endpoint and normalized into `events`. We drive the FROZEN
 *        golden hook-POST corpus (the anti-drift device the contract-of-record
 *        note names) against the REAL loopback endpoint AND assert the SI-3
 *        template actually declares an `http` hook for the events the corpus
 *        exercises — so the fixtures aren't testing a vocabulary the template
 *        would never emit.
 *   #4s: SI-3's OTel env block (`OTEL_RESOURCE_ATTRIBUTES=account=<LABEL>`,
 *        `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`) → BE-5's OTLP receiver
 *        rows carry `account=<LABEL>`. We build an OTLP batch stamped the way
 *        that env produces and POST it to the REAL receiver.
 *
 * BE-1's OTel injection (buildOtelEnvBlock) and SI-3's template must agree on
 * the attribution key — asserted here as a cross-department equality.
 *
 * [X2]: golden corpus + fixture builders are synthesized; the [X2] audit that
 * NO identity enters the store is asserted after every ingest.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GOLDEN_HOOK_CORPUS_FREEZE,
  GOLDEN_HOOK_FIXTURES,
  otlpAttr,
  otlpLogsBatch,
  SYNTHETIC_OTLP_ACCOUNT_UUID,
  SYNTHETIC_OTLP_EMAIL,
} from '@aibender/testkit';
import { PROTOCOL_FREEZE } from '@aibender/protocol';
import { openEventsStore, type EventsStore } from '@aibender/schema';

import { startHooksServer, type HooksServer } from '../../../../core/src/collector/hooks/server.ts';
import { startOtlpReceiver, type OtlpReceiver } from '../../../../core/src/collector/otlp/receiver.ts';
import { createApiRequestJoiner } from '../../../../core/src/collector/ingest.ts';
import { buildOtelEnvBlock } from '../../../../core/src/kernel/env.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SI3_TEMPLATE = join(REPO_ROOT, 'infra/hooks/templates/settings.fragment.json.template');

let store: EventsStore;
const teardown: Array<() => Promise<void> | void> = [];
beforeEach(async () => {
  store = await openEventsStore({ path: ':memory:' });
});
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
  store.close();
});

function post(url: string, path: string, body: string | object): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Hook fixtures pass exact JSON strings (replay verbatim); OTLP batches
    // pass objects (built by the testkit emitter) — stringify those.
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** [X2] audit: no committed store row carries an AWS-account run or email. */
function assertNoIdentityInStore(): void {
  const twelve = /(?<!\d)\d{12}(?!\d)/;
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  for (const row of store.events.list()) {
    const serialized = JSON.stringify(row);
    expect(twelve.test(serialized), 'events row carries a 12-digit run').toBe(false);
    expect(email.test(serialized), 'events row carries an email').toBe(false);
  }
}

describe('BE↔SI #3 — SI-3 hook templates → BE-5 hooks endpoint → events', () => {
  it('the SI-3 template declares http hooks for the events the golden corpus exercises', async () => {
    const raw = await readFile(SI3_TEMPLATE, 'utf8');
    const template = JSON.parse(raw) as { hooks: Record<string, unknown> };
    // Every ACCEPTED golden fixture's hook_event_name must be a hook SI-3
    // installs (else the corpus would be testing vocabulary SI never emits).
    const declaredEvents = new Set(Object.keys(template.hooks));
    let checked = 0;
    for (const fixture of GOLDEN_HOOK_FIXTURES) {
      if (!fixture.expect.accepted) continue;
      // Skip forward-tolerance probes: a MAPPED accept has a real
      // HookEventGroup; an `unmapped` accept is a deliberately-unknown event
      // (a minor-bump future event) the reader tolerates but SI never emits —
      // it is NOT expected to be in SI-3's declared hook set.
      if (fixture.expect.group === 'unmapped') continue;
      const body = JSON.parse(fixture.bodyJson) as { hook_event_name?: string };
      const name = body.hook_event_name;
      if (name === undefined) continue;
      expect(declaredEvents.has(name), `SI-3 template declares no hook for ${name}`).toBe(true);
      checked += 1;
    }
    expect(checked, 'no mapped-accept fixtures were checked').toBeGreaterThan(0);
  });

  it('the golden hook corpus replays into events against the real endpoint (freeze == protocol)', async () => {
    // The freeze constant is the anti-drift device; assert it tracks the
    // protocol freeze (the corpus and the endpoint move together).
    expect(GOLDEN_HOOK_CORPUS_FREEZE).toBe(PROTOCOL_FREEZE);

    const server: HooksServer = await startHooksServer({
      events: store.events,
      port: 0,
      nowMs: () => 4242,
    });
    teardown.push(() => server.close());
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);

    let accepted = 0;
    for (const fixture of GOLDEN_HOOK_FIXTURES) {
      const response = await post(server.url, `/hooks/v1/${fixture.accountSegment}`, fixture.bodyJson);
      if (fixture.expect.accepted) {
        accepted += 1;
        // No floor wired → gating-capable accepts still answer 204 (the
        // contract default: no opinion) — the hooks.spec.ts precedent.
        expect(response.status, fixture.name).toBe(204);
      } else {
        expect(response.status, fixture.name).toBe(fixture.expect.httpStatus);
      }
    }
    expect(accepted).toBeGreaterThan(0);
    // Every accepted post that maps to an events row landed one, source `hooks`.
    const rows = store.events.list();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.source).toBe('hooks');
    assertNoIdentityInStore();
  });
});

describe('BE↔SI #4 — SI-3 OTel env → BE-5 OTLP rows carry account=<LABEL>', () => {
  it('BE-1 OTel injection and the attribution key agree with SI-3', async () => {
    // BE-1's env block stamps `account=<LABEL>`; SI-3's template renders
    // `OTEL_RESOURCE_ATTRIBUTES=account={{ACCOUNT_LABEL}}`. Same key.
    const block = buildOtelEnvBlock('MAX_A');
    expect(block['OTEL_RESOURCE_ATTRIBUTES']).toBe('account=MAX_A');

    const raw = await readFile(SI3_TEMPLATE, 'utf8');
    const template = JSON.parse(raw) as { env: Record<string, string> };
    expect(template.env['OTEL_RESOURCE_ATTRIBUTES']).toBe('account={{ACCOUNT_LABEL}}');
    // Account-UUID attribution is OFF (identity never stamped, [X2]).
    expect(template.env['OTEL_METRICS_INCLUDE_ACCOUNT_UUID']).toBe('false');
  });

  it('an OTLP batch stamped account=<LABEL> ingests with that attribution; identity dropped', async () => {
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0, windowMs: 0 });
    const receiver: OtlpReceiver = await startOtlpReceiver({
      events: store.events,
      joiner,
      port: 0,
    });
    teardown.push(() => receiver.close());
    expect(receiver.url.startsWith('http://127.0.0.1:')).toBe(true);

    // The batch the SI-3 OTel env produces: a harness-stamped `account`
    // resource attribute, PLUS identity-shaped record attrs that MUST be
    // dropped (the [X2] ingest guard).
    const body = otlpLogsBatch({
      resourceAttrs: [otlpAttr('account', 'ENT'), otlpAttr('service.name', 'claude-code')],
      records: [
        {
          timeUnixNano: String(1_767_225_600_000 * 1e6),
          attributes: [
            otlpAttr('event.name', 'user_prompt'),
            otlpAttr('session.id', 'synth-native-ent-1'),
            // Identity drop-probes (runtime-built in the testkit) [X2]:
            otlpAttr('user.email', SYNTHETIC_OTLP_EMAIL),
            otlpAttr('account.uuid', SYNTHETIC_OTLP_ACCOUNT_UUID),
          ],
        },
      ],
    });

    const response = await post(receiver.url, '/v1/logs', body);
    expect(response.status).toBe(200);

    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account).toBe('ENT');
    // Identity attrs never entered the store.
    assertNoIdentityInStore();
  });

  it('a label-less OTLP batch is DROPPED, never guessed', async () => {
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0, windowMs: 0 });
    const receiver: OtlpReceiver = await startOtlpReceiver({
      events: store.events,
      joiner,
      port: 0,
    });
    teardown.push(() => receiver.close());

    const body = otlpLogsBatch({
      resourceAttrs: [otlpAttr('service.name', 'claude-code')], // NO account
      records: [
        {
          timeUnixNano: String(1_767_225_600_000 * 1e6),
          attributes: [otlpAttr('event.name', 'x')],
        },
      ],
    });
    const response = await post(receiver.url, '/v1/logs', body);
    expect(response.status).toBe(200); // accepted-then-dropped, not an error
    expect(store.events.list()).toHaveLength(0);
    expect(receiver.stats().batchesDroppedNoLabel).toBe(1);
  });
});
