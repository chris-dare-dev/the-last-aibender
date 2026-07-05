import { describe, expect, it } from 'vitest';

import {
  CHANNEL,
  PROTOCOL_FREEZE,
  PROTOCOL_VERSION,
  STATIC_CHANNELS,
  isChannelName,
  isEnvelope,
  ptyChannel,
  sessionIdOfChannel,
  streamForChannel,
  transcriptChannel,
  validateEnvelope,
} from './index.js';

describe('@aibender/protocol (M6 freeze)', () => {
  // M0 asserted 'prefreeze'; M1 asserted '1.0.0-m1-core'; M2 asserted
  // '1.0.0'; M3 asserted '1.1.0'; M4 asserted '1.2.0'; M5 asserted '1.3.0';
  // M6 asserted '1.4.0'. Updated at each freeze landing — this change IS the
  // M7 account-registry generalization (ICR-0013), a validation-widening minor.
  it('imports and self-identifies as FROZEN-M7', () => {
    expect(PROTOCOL_VERSION).toBe('1.5.0');
    expect(PROTOCOL_FREEZE).toBe('FROZEN-M7');
  });

  // -- positive ------------------------------------------------------------

  it('registers exactly the seven static channels (plan §3 five + M4 workstream + M5 pipelines)', () => {
    expect([...STATIC_CHANNELS].sort()).toEqual(
      ['approvals', 'context-graph', 'control', 'events', 'pipelines', 'quota', 'workstream'].sort(),
    );
    expect(CHANNEL.CONTEXT_GRAPH).toBe('context-graph');
    expect(CHANNEL.WORKSTREAM).toBe('workstream');
    expect(CHANNEL.PIPELINES).toBe('pipelines');
  });

  it('builds session-scoped channel names', () => {
    expect(ptyChannel('s01')).toBe('pty.s01');
    expect(transcriptChannel('sess_A-1')).toBe('transcript.sess_A-1');
  });

  it('accepts a well-formed envelope', () => {
    const envelope = {
      stream: 'events',
      channel: CHANNEL.EVENTS,
      seq: 0,
      payload: { kind: 'noop' },
    };
    expect(isEnvelope(envelope)).toBe(true);
  });

  // -- negative ------------------------------------------------------------

  it('rejects unknown channel names', () => {
    expect(isChannelName('bogus')).toBe(false);
    expect(isChannelName('pty:s01')).toBe(false);
    expect(isChannelName(42)).toBe(false);
  });

  it('refuses malformed session ids in channel builders', () => {
    expect(() => ptyChannel('')).toThrow(RangeError);
    expect(() => transcriptChannel('has space')).toThrow(RangeError);
    expect(() => ptyChannel('dot.ted')).toThrow(RangeError);
  });

  it('rejects envelopes missing or corrupting required fields', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ stream: 'events', channel: 'events', payload: {} })).toBe(false); // no seq
    expect(isEnvelope({ stream: 'events', channel: 'events', seq: -1, payload: {} })).toBe(false);
    expect(isEnvelope({ stream: 'events', channel: 'events', seq: 1.5, payload: {} })).toBe(false);
    expect(isEnvelope({ stream: '', channel: 'events', seq: 0, payload: {} })).toBe(false);
    expect(isEnvelope({ stream: 'events', channel: 'nope', seq: 0, payload: {} })).toBe(false);
  });

  // -- edge ----------------------------------------------------------------

  it('treats a bare prefix as invalid but a one-char session id as valid', () => {
    expect(isChannelName('pty.')).toBe(false);
    expect(isChannelName('transcript.')).toBe(false);
    expect(isChannelName('pty.x')).toBe(true);
  });

  it('accepts seq 0 and an explicitly-undefined payload key (payload is free-form)', () => {
    expect(
      isEnvelope({ stream: 'quota', channel: 'quota', seq: 0, payload: undefined }),
    ).toBe(true);
    // ...but the payload KEY must exist:
    expect(isEnvelope({ stream: 'quota', channel: 'quota', seq: 0 })).toBe(false);
  });

  // -- M1 freeze additions: stream/channel consistency ----------------------

  it('maps channels to their stream family', () => {
    expect(streamForChannel('control')).toBe('control');
    expect(streamForChannel('pty.s01')).toBe('pty');
    expect(streamForChannel('transcript.s01')).toBe('transcript');
    expect(streamForChannel('context-graph')).toBe('context-graph');
    expect(streamForChannel('workstream')).toBe('workstream');
    expect(sessionIdOfChannel('pty.s01')).toBe('s01');
    expect(sessionIdOfChannel('events')).toBeUndefined();
  });

  it('rejects an envelope whose stream disagrees with its channel', () => {
    const result = validateEnvelope({
      stream: 'events',
      channel: 'pty.s01',
      seq: 0,
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad-envelope');
  });

  it('flags a malformed channel as unknown-channel, not bad-envelope', () => {
    const result = validateEnvelope({ stream: 'pty', channel: 'pty.', seq: 0, payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown-channel');
  });
});
