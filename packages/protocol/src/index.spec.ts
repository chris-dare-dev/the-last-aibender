import { describe, expect, it } from 'vitest';

import {
  CHANNEL,
  PROTOCOL_VERSION,
  STATIC_CHANNELS,
  isChannelName,
  isEnvelope,
  ptyChannel,
  transcriptChannel,
} from './index.js';

describe('@aibender/protocol (pre-freeze draft)', () => {
  it('imports and self-identifies as pre-freeze', () => {
    expect(PROTOCOL_VERSION).toContain('prefreeze');
  });

  // -- positive ------------------------------------------------------------

  it('registers exactly the five static channels from plan §3', () => {
    expect([...STATIC_CHANNELS].sort()).toEqual(
      ['approvals', 'context-graph', 'control', 'events', 'quota'].sort(),
    );
    expect(CHANNEL.CONTEXT_GRAPH).toBe('context-graph');
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
});
