import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { EventEnvelope, JsonObject, UsageTotals } from '../protocol/generated.js';

export interface SessionMetadata {
  backendUrl: string;
  completedAt?: string;
  cursor: number;
  lastEventHash: null | string;
  protocolVersion: '1.0';
  repositoryPath: string;
  runId: string;
  sessionIds: string[];
  startedAt: string;
  status: 'cancelled' | 'completed' | 'failed' | 'running';
  usage: UsageTotals;
}

export interface LocalMessageArtifact {
  content: string;
  role: 'assistant' | 'system' | 'user';
  timestamp: string;
}

function generateRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export class RunArtifacts {
  private constructor(
    private readonly runDirectory: string,
    private metadata: SessionMetadata,
  ) {}

  static async create(
    basePath: string,
    initial: Omit<SessionMetadata, 'runId' | 'startedAt'>,
  ): Promise<RunArtifacts> {
    const runId = generateRunId();
    const runDirectory = path.join(basePath, '.shadow-auditor', 'runs', runId);
    await fs.mkdir(runDirectory, { mode: 0o700, recursive: true });
    const instance = new RunArtifacts(runDirectory, {
      ...initial,
      runId,
      startedAt: new Date().toISOString(),
    });
    await instance.writeMetadata();
    return instance;
  }

  getRunDirectory(): string {
    return this.runDirectory;
  }

  async recordEvent(envelope: EventEnvelope): Promise<void> {
    await this.appendJsonLine('events.jsonl', envelope as unknown as JsonObject);
  }

  async recordMessage(message: LocalMessageArtifact): Promise<void> {
    await this.appendJsonLine('messages.jsonl', message as unknown as JsonObject);
  }

  async updateMeta(update: Partial<Omit<SessionMetadata, 'runId' | 'startedAt'>>): Promise<void> {
    this.metadata = { ...this.metadata, ...update };
    await this.writeMetadata();
  }

  async writeReportJson(report: JsonObject): Promise<void> {
    await fs.writeFile(
      path.join(this.runDirectory, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  async writeReportMarkdown(markdown: string): Promise<void> {
    await fs.writeFile(path.join(this.runDirectory, 'report.md'), markdown, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async writeReportSarif(sarif: JsonObject): Promise<void> {
    await fs.writeFile(
      path.join(this.runDirectory, 'report.sarif'),
      `${JSON.stringify(sarif, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private async appendJsonLine(fileName: string, value: JsonObject): Promise<void> {
    const handle = await fs.open(path.join(this.runDirectory, fileName), 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeMetadata(): Promise<void> {
    const destination = path.join(this.runDirectory, 'meta.json');
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.metadata, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
  }
}
