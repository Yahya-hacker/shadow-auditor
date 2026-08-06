/**
 * Event Store - Append-only event log for audit trail and replay.
 * Persists to JSONL format for streaming and recovery.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logToStderr } from '../../utils/stderr-logger.js';
import { err, ok, type Result, safeParseJson } from '../schema/base.js';
import { type Event, eventSchema, type EventType } from './memory-schema.js';

export interface EventStoreOptions {
  runId: string;
  storagePath: string;
}

export interface EventFilter {
  afterTimestamp?: string;
  beforeTimestamp?: string;
  eventTypes?: EventType[];
  limit?: number;
}

/**
 * Append-only event store with JSONL persistence.
 * Supports streaming reads and atomic appends.
 */
export class EventStore {
  private readonly eventsPath: string;
  private readonly runId: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: EventStoreOptions) {
    this.runId = options.runId;
    this.eventsPath = path.join(options.storagePath, 'events.jsonl');
  }

  /**
   * Create or open an event store.
   */
  static async create(options: EventStoreOptions): Promise<EventStore> {
    await fs.mkdir(options.storagePath, { recursive: true });
    const store = new EventStore(options);
    await store.repairInterruptedTail();
    return store;
  }

  /**
   * Append an event to the log.
   * Thread-safe via write queue serialization.
   */
  async append(eventType: EventType, payload: Record<string, unknown>): Promise<Result<Event, string>> {
    const event: Event = {
      eventId: this.generateEventId(),
      eventType,
      payload,
      runId: this.runId,
      schemaVersion: '1.0.0',
      timestamp: new Date().toISOString(),
    };

    // Validate before persisting
    const validation = eventSchema.safeParse(event);
    if (!validation.success) {
      return err(`Event validation failed: ${validation.error.message}`);
    }

    // Serialize writes to prevent interleaving
    const write = this.writeQueue.then(async () => {
      const line = `${JSON.stringify(event)}\n`;
      await fs.appendFile(this.eventsPath, line, 'utf8');
    });
    this.writeQueue = write.catch(() => {});

    try {
      await write;
      return ok(event);
    } catch (error) {
      return err(`Failed to append event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Count total events.
   */
  async count(): Promise<number> {
    const result = await this.read();
    if (!result.ok) throw new Error(result.error);
    return result.value.length;
  }

  /**
   * Get events of a specific type.
   */
  async getByType(eventType: EventType, limit?: number): Promise<Result<Event[], string>> {
    return this.read({ eventTypes: [eventType], limit });
  }

  /**
   * Read all events, optionally filtered.
   */
  async read(filter?: EventFilter): Promise<Result<Event[], string>> {
    try {
      const content = await fs.readFile(this.eventsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (!content.trim()) {
        return ok([]);
      }

      const lines = content.trim().split('\n');
      const events: Event[] = [];
      const parseErrors: string[] = [];

      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;

        const result = safeParseJson(eventSchema, line);
        if (!result.ok) {
          parseErrors.push(`Line ${i + 1}: ${result.error}`);
          continue;
        }

        const event = result.value;

        // Apply filters
        if (filter?.eventTypes && !filter.eventTypes.includes(event.eventType)) {
          continue;
        }

        if (filter?.afterTimestamp && event.timestamp <= filter.afterTimestamp) {
          continue;
        }

        if (filter?.beforeTimestamp && event.timestamp >= filter.beforeTimestamp) {
          continue;
        }

        events.push(event);

        if (filter?.limit && events.length >= filter.limit) {
          break;
        }
      }

      // Report parse errors but don't fail - allow partial recovery
      if (parseErrors.length > 0) {
        logToStderr(`[EventStore] ${parseErrors.length} parse errors encountered`);
      }

      return ok(events);
    } catch (error) {
      return err(`Failed to read events: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate a unique event ID.
   */
  private generateEventId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `evt_${timestamp}_${random}`;
  }

  /**
   * A process crash can leave the final append partially written. Remove only
   * that unterminated tail so a later append cannot corrupt the next event.
   */
  private async repairInterruptedTail(): Promise<void> {
    const content = await fs.readFile(this.eventsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!content || content.length === 0 || content.at(-1) === 0x0A) return;

    const lastNewline = content.lastIndexOf(0x0A);
    await fs.truncate(this.eventsPath, lastNewline + 1);
    logToStderr('[EventStore] Removed an interrupted trailing event record.');
  }
}
