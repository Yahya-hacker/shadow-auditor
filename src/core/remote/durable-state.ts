import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { JsonObject, SessionSnapshot } from '../../protocol/generated.js';

import { sha256Digest } from '../../protocol/canonical-json.js';
import { validateProtocolDto } from '../../protocol/validate.js';
import { problem, ProtocolError } from './protocol-error.js';

export interface DurableCursor {
  eventHash: null | string;
  sequence: number;
  sessionId: string;
  updatedAt: string;
}

export interface ExecutionLedgerEntry {
  data: JsonObject;
  entryHash: string;
  entryId: string;
  occurredAt: string;
  previousEntryHash: null | string;
  proposalId: string;
  state: 'decision' | 'execution_started' | 'grant' | 'result';
}

export class ActiveSessionStore {
  private readonly activeSessionPath: string;

  constructor(targetPath: string, backendUrl: string) {
    const backendDigest = sha256Digest(backendUrl).slice('sha256:'.length);
    this.activeSessionPath = path.join(
      targetPath,
      '.shadow-auditor',
      'remote-sessions',
      `${backendDigest}.active-session.json`,
    );
  }

  async clear(sessionId: string): Promise<void> {
    const current = await this.load();
    if (current && current.sessionId !== sessionId) {
      throw this.invalidState('Active session changed before it could be cleared');
    }

    try {
      await fs.unlink(this.activeSessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async load(): Promise<null | SessionSnapshot> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.activeSessionPath, 'utf8')) as unknown;
      return validateProtocolDto<SessionSnapshot>('session-snapshot.schema.json', parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.invalidState('Durable active session is malformed', error);
    }
  }

  async persist(snapshot: SessionSnapshot): Promise<void> {
    const validated = validateProtocolDto<SessionSnapshot>(
      'session-snapshot.schema.json',
      snapshot,
    );
    const directory = path.dirname(this.activeSessionPath);
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = `${this.activeSessionPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, this.activeSessionPath);
  }

  private invalidState(detail: string, cause?: unknown): ProtocolError {
    return new ProtocolError(
      problem({
        code: 'INVALID_ACTIVE_SESSION_STATE',
        detail,
        status: 500,
        title: 'Cannot safely restore remote session',
      }),
      cause === undefined ? undefined : { cause },
    );
  }
}

export class CursorStore {
  private readonly directory: string;

  constructor(targetPath: string) {
    this.directory = path.join(targetPath, '.shadow-auditor', 'remote-sessions');
  }

  async load(sessionId: string): Promise<DurableCursor> {
    const cursorPath = this.cursorPath(sessionId);
    try {
      const parsed = JSON.parse(await fs.readFile(cursorPath, 'utf8')) as DurableCursor;
      if (
        parsed.sessionId !== sessionId ||
        !Number.isSafeInteger(parsed.sequence) ||
        parsed.sequence < 0 ||
        (parsed.eventHash !== null && typeof parsed.eventHash !== 'string')
      ) {
        throw new Error('invalid cursor fields');
      }

      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          eventHash: null,
          sequence: 0,
          sessionId,
          updatedAt: new Date(0).toISOString(),
        };
      }

      throw new ProtocolError(
        problem({
          code: 'INVALID_DURABLE_CURSOR',
          detail: `Durable cursor for session ${sessionId} is malformed`,
          status: 500,
          title: 'Cannot safely resume session',
        }),
        { cause: error },
      );
    }
  }

  async persist(cursor: DurableCursor): Promise<void> {
    await fs.mkdir(this.directory, { mode: 0o700, recursive: true });
    const destination = this.cursorPath(cursor.sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(cursor)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, destination);
  }

  private cursorPath(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('Invalid session identifier');
    }

    return path.join(this.directory, `${sessionId}.cursor.json`);
  }
}

export class ExecutionLedger {
  private readonly entries: ExecutionLedgerEntry[] = [];
  private lastEntryHash: null | string = null;

  private constructor(private readonly ledgerPath: string) {}

  static async open(targetPath: string, sessionId: string): Promise<ExecutionLedger> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session identifier');
    const directory = path.join(targetPath, '.shadow-auditor', 'execution-ledgers');
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    const ledger = new ExecutionLedger(path.join(directory, `${sessionId}.jsonl`));
    await ledger.load();
    return ledger;
  }

  async append(
    proposalId: string,
    state: ExecutionLedgerEntry['state'],
    data: JsonObject,
  ): Promise<ExecutionLedgerEntry> {
    const unsigned = {
      data,
      entryId: randomUUID(),
      occurredAt: new Date().toISOString(),
      previousEntryHash: this.lastEntryHash,
      proposalId,
      state,
    };
    const entry: ExecutionLedgerEntry = {
      ...unsigned,
      entryHash: sha256Digest(unsigned),
    };
    const handle = await fs.open(this.ledgerPath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.entries.push(entry);
    this.lastEntryHash = entry.entryHash;
    return entry;
  }

  findLatest(proposalId: string, state: ExecutionLedgerEntry['state']): ExecutionLedgerEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.proposalId === proposalId && entry.state === state) return entry;
    }

    return null;
  }

  hasGrantNonce(nonce: string): boolean {
    return this.entries.some((entry) => entry.state === 'grant' && entry.data.nonce === nonce);
  }

  private async load(): Promise<void> {
    let serialized: string;
    try {
      serialized = await fs.readFile(this.ledgerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    let expectedPreviousHash: null | string = null;
    for (const line of serialized.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as ExecutionLedgerEntry;
        const { entryHash, ...unsigned } = entry;
        if (
          entry.previousEntryHash !== expectedPreviousHash ||
          sha256Digest(unsigned) !== entryHash
        ) {
          throw new Error('ledger hash mismatch');
        }

        this.entries.push(entry);
        expectedPreviousHash = entry.entryHash;
      } catch (error) {
        throw new ProtocolError(
          problem({
            code: 'INVALID_EXECUTION_LEDGER',
            detail: `Execution ledger ${this.ledgerPath} failed integrity validation`,
            status: 500,
            title: 'Cannot safely execute local tools',
          }),
          { cause: error },
        );
      }
    }

    this.lastEntryHash = expectedPreviousHash;
  }
}
