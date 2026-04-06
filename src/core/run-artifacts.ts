import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SecurityReport } from './output/report-schema.js';

export interface SessionMetadata {
  completedAt?: string;
  mcpEnabled: boolean;
  model: string;
  provider: string;
  runId: string;
  startedAt: string;
  targetPath: string;
  warnings: string[];
  maxOutputTokens: number;
  maxToolSteps: number;
}

export interface MessageArtifactEvent {
  content: unknown;
  role: 'assistant' | 'system' | 'tool' | 'user';
  timestamp: string;
}

export interface ToolArtifactEvent {
  data: unknown;
  event: 'call' | 'result';
  timestamp: string;
  toolCallId: string;
  toolName: string;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    const renameError = error as NodeJS.ErrnoException;

    if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
      return;
    }

    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const shortId = randomUUID().slice(0, 8);
  return `${timestamp}-${shortId}`;
}

async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;
  await fs.appendFile(filePath, line, 'utf8');
}

export class RunArtifacts {
  private readonly messagesPath: string;
  private meta: SessionMetadata;
  private readonly metaPath: string;
  private readonly reportJsonPath: string;
  private readonly reportMarkdownPath: string;
  private readonly reportSarifPath: string;
  private readonly toolEventsPath: string;

  private constructor(
    private readonly runDirectory: string,
    initialMeta: SessionMetadata,
  ) {
    this.meta = initialMeta;
    this.metaPath = path.join(runDirectory, 'session-meta.json');
    this.messagesPath = path.join(runDirectory, 'messages.jsonl');
    this.toolEventsPath = path.join(runDirectory, 'tool-events.jsonl');
    this.reportMarkdownPath = path.join(runDirectory, 'report.md');
    this.reportJsonPath = path.join(runDirectory, 'report.json');
    this.reportSarifPath = path.join(runDirectory, 'report.sarif');
  }

  static async create(basePath: string, initialMeta: Omit<SessionMetadata, 'runId' | 'startedAt'>): Promise<RunArtifacts> {
    const runId = createRunId();
    const startedAt = new Date().toISOString();
    const runDirectory = path.join(basePath, '.shadow-auditor', 'runs', runId);
    await fs.mkdir(runDirectory, { recursive: true });

    const instance = new RunArtifacts(runDirectory, {
      ...initialMeta,
      runId,
      startedAt,
    });

    await instance.writeMeta();
    return instance;
  }

  getRunDirectory(): string {
    return this.runDirectory;
  }

  async markCompleted(): Promise<void> {
    this.meta = {
      ...this.meta,
      completedAt: new Date().toISOString(),
    };
    await this.writeMeta();
  }

  async recordMessage(event: MessageArtifactEvent): Promise<void> {
    await appendJsonLine(this.messagesPath, event);
  }

  async recordToolEvent(event: ToolArtifactEvent): Promise<void> {
    await appendJsonLine(this.toolEventsPath, event);
  }

  async updateMeta(partial: Partial<SessionMetadata>): Promise<void> {
    this.meta = {
      ...this.meta,
      ...partial,
    };
    await this.writeMeta();
  }

  async writeReportJson(report: SecurityReport): Promise<void> {
    await writeFileAtomic(this.reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  async writeReportMarkdown(markdown: string): Promise<void> {
    await writeFileAtomic(this.reportMarkdownPath, `${markdown}\n`);
  }

  async writeReportSarif(sarif: Record<string, unknown>): Promise<void> {
    await writeFileAtomic(this.reportSarifPath, `${JSON.stringify(sarif, null, 2)}\n`);
  }

  private async writeMeta(): Promise<void> {
    await writeFileAtomic(this.metaPath, `${JSON.stringify(this.meta, null, 2)}\n`);
  }
}
