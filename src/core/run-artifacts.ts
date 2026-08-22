import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
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
 * A process crash can leave the final JSONL append partially written, so the
 * file ends in a truncated line with no terminator. Left alone, the next
 * append would produce a corrupted merged line. Remove only that unterminated
 * tail before appending the next record.
 */
async function repairInterruptedTail(filePath: string): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const finalByte = Buffer.allocUnsafe(1);
    await handle.read(finalByte, 0, 1, size - 1);
    if (finalByte[0] === 0x0A) return;

    const chunkSize = 64 * 1024;
    let cursor = size;
    let lastNewline = -1;
    while (cursor > 0 && lastNewline === -1) {
      const length = Math.min(chunkSize, cursor);
      cursor -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, cursor);
      const relative = chunk.lastIndexOf(0x0A);
      if (relative !== -1) lastNewline = cursor + relative;
    }

    await handle.truncate(lastNewline + 1);
  } finally {
    await handle.close();
  }
}

/**
 * Append a JSON line to a file. If the file exceeds MAX_JSONL_SIZE,
 * it is rotated to <name>.<N>.jsonl (keeping up to 3 rotated files)
 * and a fresh file is started.
 */
async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;

  // Heal a truncated trailing line left by a crash before appending, so the
  // new record never merges into a corrupted partial line.
  await repairInterruptedTail(filePath);

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

  /**
   * Enumerate all persisted runs for a target, most recent first.
   * Returns run IDs plus their metadata so callers can pick a run to resume.
   * Runs whose metadata is unreadable or missing are skipped.
   */
  static async listRuns(basePath: string): Promise<Array<{ meta: SessionMetadata; runId: string }>> {
    const runsDirectory = path.join(basePath, '.shadow-auditor', 'runs');
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const runs: Array<{ meta: SessionMetadata; runId: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (path.basename(runId) !== runId || runId === '.' || runId === '..') continue;
      const metaPath = path.join(runsDirectory, runId, 'session-meta.json');
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as SessionMetadata;
        if (meta.runId !== runId) continue;
        runs.push({ meta, runId });
      } catch {
        // Unreadable or malformed metadata — skip this run.
      }
    }

    runs.sort((a, b) => {
      const aTime = a.meta.startedAt ?? '';
      const bTime = b.meta.startedAt ?? '';
      return bTime.localeCompare(aTime);
    });
    return runs;
  }

  /**
   * Synchronously find the most recent run ID for a target, or null if none.
   * Used by the CLI argv router, which must resolve a bare `--resume` before
   * oclif parses flags (oclif v4 string flags require a value).
   */
  static findMostRecentRunIdSync(basePath: string): string | null {
    const runsDirectory = path.join(basePath, '.shadow-auditor', 'runs');
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(runsDirectory, { withFileTypes: true });
    } catch {
      return null;
    }

    let best: { runId: string; startedAt: string } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (path.basename(runId) !== runId || runId === '.' || runId === '..') continue;
      const metaPath = path.join(runsDirectory, runId, 'session-meta.json');
      let startedAt = '';
      try {
        const meta = JSON.parse(fsSync.readFileSync(metaPath, 'utf8')) as SessionMetadata;
        if (meta.runId !== runId) continue;
        startedAt = meta.startedAt ?? '';
      } catch {
        continue;
      }
      if (!best || startedAt.localeCompare(best.startedAt) > 0) {
        best = { runId, startedAt };
      }
    }
    return best?.runId ?? null;
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

  /**
   * Read the full persisted transcript for this run, oldest first.
   *
   * Reads the current `messages.jsonl` plus any rotated `.1`/`.2`/`.3`
   * files (rotation keeps the newest content in the base file and shifts
   * older content into numbered suffixes). Malformed or truncated lines —
   * the tail of a crash-interrupted append — are skipped rather than thrown.
   */
  async readMessages(): Promise<MessageArtifactEvent[]> {
    const files: string[] = [];
    for (let i = 3; i >= 1; i--) {
      const rotated = `${this.messagesPath}.${i}`;
      try {
        await fs.access(rotated);
        files.push(rotated);
      } catch {
        // No rotated file at this index — stop scanning older suffixes.
      }
    }
    files.push(this.messagesPath);

    const events: MessageArtifactEvent[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as MessageArtifactEvent);
        } catch {
          // Skip a malformed or crash-truncated line.
        }
      }
    }
    return events;
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
