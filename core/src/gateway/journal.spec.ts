/**
 * ChannelJournal / JournalSet unit suite (ws-protocol.md §2/§8 mechanics —
 * plan §9.2 BE-3 row: "reconnect replays from watermark exactly-once" is the
 * integration half in serverStreaming.spec.ts; this file pins the journal
 * math: per-(boot, channel) seq, bounded retention, floor semantics).
 */

import { describe, expect, it } from 'vitest';

import { ChannelJournal, DEFAULT_JOURNAL_MAX_ENTRIES, JournalSet } from './journal.js';

describe('ChannelJournal (positive)', () => {
  it('assigns monotonically increasing seqs from 0', () => {
    const journal = new ChannelJournal(8);
    expect(journal.append('a')).toBe(0);
    expect(journal.append('b')).toBe(1);
    expect(journal.append('c')).toBe(2);
    expect(journal.nextSeq).toBe(3);
    expect(journal.floorSeq).toBe(0);
  });

  it('replays retained entries in order with ORIGINAL seq values', () => {
    const journal = new ChannelJournal(8);
    for (const payload of ['a', 'b', 'c', 'd']) journal.append(payload);
    const replay = journal.replayFrom(1);
    if (!replay.ok) throw new Error('expected ok replay');
    expect(replay.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(replay.entries.map((entry) => entry.payload)).toEqual(['b', 'c', 'd']);
  });

  it('fromSeq === nextSeq is the legal "I am current" no-op', () => {
    const journal = new ChannelJournal(8);
    journal.append('a');
    const replay = journal.replayFrom(1);
    if (!replay.ok) throw new Error('expected ok replay');
    expect(replay.entries).toEqual([]);
  });

  it('fromSeq 0 on a never-written journal is a legal empty replay', () => {
    const journal = new ChannelJournal(8);
    const replay = journal.replayFrom(0);
    if (!replay.ok) throw new Error('expected ok replay');
    expect(replay.entries).toEqual([]);
  });
});

describe('ChannelJournal (negative)', () => {
  it('fromSeq beyond nextSeq answers watermark-out-of-range', () => {
    const journal = new ChannelJournal(8);
    journal.append('a');
    const replay = journal.replayFrom(2); // nextSeq is 1
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('expected refusal');
    expect(replay.code).toBe('watermark-out-of-range');
  });

  it('fromSeq below the retention floor answers watermark-out-of-range', () => {
    const journal = new ChannelJournal(2);
    for (const payload of ['a', 'b', 'c', 'd']) journal.append(payload); // retains seqs 2,3
    expect(journal.floorSeq).toBe(2);
    const replay = journal.replayFrom(1);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('expected refusal');
    expect(replay.code).toBe('watermark-out-of-range');
  });

  it('rejects a non-positive maxEntries at construction', () => {
    expect(() => new ChannelJournal(0)).toThrow(RangeError);
    expect(() => new ChannelJournal(1.5)).toThrow(RangeError);
  });
});

describe('ChannelJournal (edge: bounded retention)', () => {
  it('never retains more than maxEntries and the floor tracks eviction', () => {
    const journal = new ChannelJournal(3);
    for (let i = 0; i < 10; i += 1) journal.append(`p${i}`);
    expect(journal.size).toBe(3);
    expect(journal.nextSeq).toBe(10);
    expect(journal.floorSeq).toBe(7);
    const replay = journal.replayFrom(7);
    if (!replay.ok) throw new Error('expected ok replay');
    expect(replay.entries.map((entry) => entry.seq)).toEqual([7, 8, 9]);
    // One below the floor: unrecoverable by design.
    expect(journal.replayFrom(6).ok).toBe(false);
  });

  it('replay at exactly the floor succeeds; at nextSeq succeeds; between works', () => {
    const journal = new ChannelJournal(2);
    for (const payload of ['a', 'b', 'c']) journal.append(payload); // floor 1, next 3
    expect(journal.replayFrom(1).ok).toBe(true);
    expect(journal.replayFrom(2).ok).toBe(true);
    expect(journal.replayFrom(3).ok).toBe(true); // no-op
    expect(journal.replayFrom(4).ok).toBe(false);
  });
});

describe('JournalSet', () => {
  it('scopes seq per channel and shares the bound', () => {
    const set = new JournalSet(4);
    expect(set.journalFor('events').append('e0')).toBe(0);
    expect(set.journalFor('quota').append('q0')).toBe(0);
    expect(set.journalFor('events').append('e1')).toBe(1);
    expect(set.journalFor('transcript.ses_fake_1').append('t0')).toBe(0);
  });

  it('defaults the per-channel bound', () => {
    const set = new JournalSet();
    const journal = set.journalFor('events');
    for (let i = 0; i < DEFAULT_JOURNAL_MAX_ENTRIES + 5; i += 1) journal.append(i);
    expect(journal.size).toBe(DEFAULT_JOURNAL_MAX_ENTRIES);
  });

  it('rejects a non-positive bound', () => {
    expect(() => new JournalSet(0)).toThrow(RangeError);
  });
});
