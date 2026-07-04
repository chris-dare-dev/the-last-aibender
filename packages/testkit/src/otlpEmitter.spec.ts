/**
 * otlpEmitter suite (ICR-0010):
 *   positive — attr encodings (string/bool/int/double); batch envelope shape;
 *              api_request record carries the attribution set
 *   negative — identity-shaped free text refused (except the two sanctioned
 *              runtime-built drop-probe values)
 *   edge     — overrides appended after the base attributes
 */

import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_OTLP_ACCOUNT_UUID,
  SYNTHETIC_OTLP_API_REQUEST_TS_MS,
  SYNTHETIC_OTLP_EMAIL,
  otlpApiRequestRecord,
  otlpAttr,
  otlpLogsBatch,
} from './otlpEmitter.js';

describe('otlpAttr', () => {
  it('encodes string/bool/int/double per the OTLP JSON mapping', () => {
    expect(otlpAttr('a', 'x')).toEqual({ key: 'a', value: { stringValue: 'x' } });
    expect(otlpAttr('b', true)).toEqual({ key: 'b', value: { boolValue: true } });
    expect(otlpAttr('c', 5)).toEqual({ key: 'c', value: { intValue: '5' } });
    expect(otlpAttr('d', 0.42)).toEqual({ key: 'd', value: { doubleValue: 0.42 } });
  });

  it('REFUSES identity-shaped values, EXCEPT the sanctioned drop probes', () => {
    // Runtime-built so no scanner-shaped literal is committed (index.spec.ts
    // convention).
    const emailish = ['someone', 'gmail.com'].join('@');
    expect(() => otlpAttr('user.email', emailish)).toThrowError(/email/);
    expect(otlpAttr('user.email', SYNTHETIC_OTLP_EMAIL)).toEqual({
      key: 'user.email',
      value: { stringValue: SYNTHETIC_OTLP_EMAIL },
    });
    expect(otlpAttr('user.account_uuid', SYNTHETIC_OTLP_ACCOUNT_UUID)).toBeDefined();
  });
});

describe('otlpLogsBatch', () => {
  it('wraps records in the resourceLogs → scopeLogs envelope with the CLI scope', () => {
    const batch = otlpLogsBatch({
      resourceAttrs: [otlpAttr('account', 'MAX_A')],
      records: [{ timeUnixNano: '0' }],
    }) as {
      resourceLogs: readonly {
        resource: { attributes: readonly unknown[] };
        scopeLogs: readonly { scope: { name: string }; logRecords: readonly unknown[] }[];
      }[];
    };
    expect(batch.resourceLogs).toHaveLength(1);
    expect(batch.resourceLogs[0]?.resource.attributes).toEqual([otlpAttr('account', 'MAX_A')]);
    expect(batch.resourceLogs[0]?.scopeLogs[0]?.scope.name).toBe('com.anthropic.claude_code');
    expect(batch.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(1);
  });
});

describe('otlpApiRequestRecord', () => {
  const attrsOf = (record: Record<string, unknown>): Map<string, unknown> => {
    const attributes = record['attributes'] as readonly { key: string; value: unknown }[];
    return new Map(attributes.map((attr) => [attr.key, attr.value]));
  };

  it('carries the attribution set + the identity drop probes by default', () => {
    const record = otlpApiRequestRecord();
    expect(record['timeUnixNano']).toBe(String(SYNTHETIC_OTLP_API_REQUEST_TS_MS * 1e6));
    expect(record['body']).toEqual({ stringValue: 'api_request' });
    const attrs = attrsOf(record);
    expect(attrs.get('event.name')).toEqual({ stringValue: 'api_request' });
    expect(attrs.get('request_id')).toEqual({ stringValue: 'req_synth_0001' });
    expect(attrs.get('cost_usd')).toEqual({ doubleValue: 0.42 });
    expect(attrs.get('input_tokens')).toEqual({ intValue: '5' });
    expect(attrs.get('user.email')).toEqual({ stringValue: SYNTHETIC_OTLP_EMAIL });
    expect(attrs.get('user.account_uuid')).toEqual({
      stringValue: SYNTHETIC_OTLP_ACCOUNT_UUID,
    });
  });

  it('appends screened overrides (edge)', () => {
    const attrs = attrsOf(otlpApiRequestRecord({ 'skill.name': 'synth-override' }));
    expect(attrs.get('skill.name')).toEqual({ stringValue: 'synth-override' });
    const emailish = ['leaky', 'gmail.com'].join('@'); // runtime-built
    expect(() => otlpApiRequestRecord({ leaked: emailish })).toThrowError(/email/);
  });

  it('the drop-probe values are runtime-joined, identity-SHAPED, obviously fake', () => {
    expect(SYNTHETIC_OTLP_EMAIL.endsWith('.invalid')).toBe(true);
    expect(SYNTHETIC_OTLP_EMAIL).toContain('@');
    expect(SYNTHETIC_OTLP_ACCOUNT_UUID).toContain('synthetic');
  });
});
