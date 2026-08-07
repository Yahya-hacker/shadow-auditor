import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SecurityReport } from './output/report-schema.js';

import { recoverAtomicWrite, writeFileAtomic } from '../utils/fs-atomic.js';

/** Maximum size of a JSONL file before rotation (50 MB) */
const MAX_JSONL_SIZE = 50 * 1024 * 1024;

export interface SessionMetadata {
  completedAt?: string;
  maxOutputTokens: number;
  maxToolSteps: number;
  mcpEnabled: boolean;
  model: string;
  provider: string;
  runId: string;
  startedAt: string;
  targetPath: string;
  warnings: string[];
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

export interface PipelineArtifactBundle {
  adversarialReport: string;
  codebaseReport: string;
  finalReport: string;
  repoMap: string;
  sastReport: string;
  verdicts: unknown[];
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const shortId = randomUUID().slice(0, 8);
  return `${timestamp}-${shortId}`;
}

/**
 * Append a JSON line to a file. If the file exceeds MAX_JSONL_SIZE,
 * it is rotated to <name>.<N>.jsonl (keeping up to 3 rotated files)
 * and a fresh file is started.
 */
async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;

  // Check if rotation is needed
  try {
    const stat = await fs.stat(filePath);
    if (stat.size + Buffer.byteLength(line) > MAX_JSONL_SIZE) {
      await rotateJsonlFile(filePath);
    }
  } catch {
    // File doesn't exist yet — normal for first write
  }

  await fs.appendFile(filePath, line, 'utf8');
}

/**
 * Rotate a JSONL file: shift .2 -> .3, .1 -> .2, current -> .1
 * Keeps at most 3 rotated files to prevent unbounded disk usage.
 */
async function rotateJsonlFile(filePath: string): Promise<void> {
  for (let i = 2; i >= 1; i--) {
    const oldPath = `${filePath}.${i}`;
    const newPath = `${filePath}.${i + 1}`;
    try {
      if (i === 2) {
        await fs.rm(newPath, { force: true });
      }

      await fs.rename(oldPath, newPath);
    } catch {
      // Rotation file may not exist — that's fine
    }
  }

  await fs.rename(filePath, `${filePath}.1`);
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

  static async open(basePath: string, runId: string): Promise<RunArtifacts> {
    if (path.basename(runId) !== runId || runId === '.' || runId === '..') {
      throw new Error('Invalid run ID.');
    }

    const runDirectory = path.join(basePath, '.shadow-auditor', 'runs', runId);
    const metaPath = path.join(runDirectory, 'session-meta.json');
    await recoverAtomicWrite(metaPath);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as SessionMetadata;
    if (meta.runId !== runId) {
      throw new Error(`Run metadata does not match requested run ID "${runId}".`);
    }

    if (path.resolve(meta.targetPath) !== path.resolve(basePath)) {
      throw new Error(`Run "${runId}" belongs to a different target.`);
    }

    return new RunArtifacts(runDirectory, meta);
  }

  assertCompatible(expected: Pick<SessionMetadata, 'model' | 'provider'>): void {
    if (this.meta.provider !== expected.provider || this.meta.model !== expected.model) {
      throw new Error(
        `Run was created for ${this.meta.provider}/${this.meta.model}; ` +
        `resume requires the same provider and model, not ${expected.provider}/${expected.model}.`,
      );
    }
  }

  getRunDirectory(): string {
    return this.runDirectory;
  }

  async markActive(): Promise<void> {
    const {completedAt: _completedAt, ...activeMeta} = this.meta;
    this.meta = activeMeta;
    await this.writeMeta();
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

  async writePipelineArtifacts(artifacts: PipelineArtifactBundle): Promise<void> {
    const pipelineDirectory = path.join(this.runDirectory, 'pipeline');
    await fs.mkdir(pipelineDirectory, {recursive: true});
    await Promise.all([
      writeFileAtomic(path.join(pipelineDirectory, 'repo-map.md'), `${artifacts.repoMap}\n`),
      writeFileAtomic(path.join(pipelineDirectory, 'codebase-report.md'), `${artifacts.codebaseReport}\n`),
      writeFileAtomic(path.join(pipelineDirectory, 'sast-report.md'), `${artifacts.sastReport}\n`),
      writeFileAtomic(path.join(pipelineDirectory, 'adversarial-report.md'), `${artifacts.adversarialReport}\n`),
      writeFileAtomic(path.join(pipelineDirectory, 'verdicts.json'), `${JSON.stringify(artifacts.verdicts, null, 2)}\n`),
      writeFileAtomic(path.join(pipelineDirectory, 'final-report.md'), `${artifacts.finalReport}\n`),
    ]);
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
