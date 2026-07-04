/**
 * Fake `opencode.db` builder (plan §3 testkit deliverable — promoted from
 * core/src/adapters/testing/ via ICR-0008, the ICR-0001 path).
 *
 * Mirrors the probed schema (opencode-serve-event-probe §4): the
 * event-sourcing store (`event`, `event_sequence`), the `migration` head,
 * AND — deliberately — `account`/`credential` tables seeded with OBVIOUSLY
 * SYNTHETIC values, so the [X2] guard tests can prove those tables are
 * unreadable through the guarded helper while remaining physically present.
 *
 * FIXTURE POLICY [X2]: every value synthesized; the credential strings are
 * screamingly fake on purpose (they must never look like a real secret to a
 * scanner or a human).
 */

import { DatabaseSync } from 'node:sqlite';

export interface FakeOpencodeDbOptions {
  /** Absolute path for the db file (tests use a tmp dir). */
  readonly path: string;
  /** Sessions to seed durable events for. */
  readonly sessions?: readonly FakeOpencodeDbSession[];
}

export interface FakeOpencodeDbSession {
  readonly sessionId: string;
  /** Durable event types in seq order (e.g. 'session.created.1'). */
  readonly eventTypes: readonly string[];
}

export interface FakeOpencodeDb {
  readonly path: string;
  readonly eventCount: number;
}

export const SYNTHETIC_CREDENTIAL_VALUE =
  'SYNTHETIC-FAKE-CREDENTIAL-VALUE-NOT-A-REAL-SECRET-0000';

/** Build a synthetic opencode.db on disk and close it. */
export function buildFakeOpencodeDb(options: FakeOpencodeDbOptions): FakeOpencodeDb {
  const db = new DatabaseSync(options.path);
  db.exec(`
    CREATE TABLE event (
      id           TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      type         TEXT NOT NULL,
      data         TEXT NOT NULL
    );
    CREATE TABLE event_sequence (
      aggregate_id TEXT PRIMARY KEY,
      seq          INTEGER NOT NULL,
      owner_id     TEXT
    );
    CREATE TABLE migration (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE account (
      id       TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email    TEXT NOT NULL,
      token    TEXT NOT NULL
    );
    CREATE TABLE credential (
      id      TEXT PRIMARY KEY,
      kind    TEXT NOT NULL,
      secret  TEXT NOT NULL
    );
  `);

  const insertEvent = db.prepare(
    'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSeq = db.prepare(
    'INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)',
  );

  let eventCount = 0;
  let idCounter = 0;
  for (const session of options.sessions ?? []) {
    session.eventTypes.forEach((type, seq) => {
      idCounter += 1;
      insertEvent.run(
        `evt_synthdb${String(idCounter).padStart(8, '0')}`,
        session.sessionId,
        seq,
        type,
        JSON.stringify({ sessionID: session.sessionId, synthesized: true }),
      );
      eventCount += 1;
    });
    insertSeq.run(session.sessionId, session.eventTypes.length - 1);
  }

  db.prepare('INSERT INTO migration (id) VALUES (?)').run('00000000000000_synthetic_head');
  db.prepare('INSERT INTO account (id, provider, email, token) VALUES (?, ?, ?, ?)').run(
    'acc_synth00000001',
    'synthetic-provider',
    'synthetic-account@example.invalid',
    SYNTHETIC_CREDENTIAL_VALUE,
  );
  db.prepare('INSERT INTO credential (id, kind, secret) VALUES (?, ?, ?)').run(
    'crd_synth00000001',
    'synthetic-kind',
    SYNTHETIC_CREDENTIAL_VALUE,
  );
  db.close();

  return { path: options.path, eventCount };
}
