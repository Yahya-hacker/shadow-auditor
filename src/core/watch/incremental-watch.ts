import { type FSWatcher, watch } from 'chokidar';
import path from 'node:path';

import type { EnhancedFinding } from '../output/finding-schema.js';

const IGNORED_ROOT_ENTRIES = new Set([
  '.git',
  '.shadow-auditor',
  'coverage',
  'dist',
  'node_modules',
]);

export interface SecurityDelta {
  introduced: EnhancedFinding[];
  resolved: EnhancedFinding[];
  unchanged: EnhancedFinding[];
}

export interface IncrementalWatchOptions {
  canProcess?: () => boolean;
  debounceMs?: number;
  maxBatchSize?: number;
  onBatch: (relativePaths: string[]) => Promise<void>;
  onError?: (error: Error) => void;
  root: string;
}

export class IncrementalWatchService {
  private readonly canProcess: () => boolean;
  private readonly changedPaths = new Set<string>();
  private readonly debounceMs: number;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private flushPromise?: Promise<void>;
  private readonly maxBatchSize: number;
  private readonly onBatch: (relativePaths: string[]) => Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly root: string;
  private running = false;
  private stopped = false;
  private watcher?: FSWatcher;

  constructor(options: IncrementalWatchOptions) {
    this.root = path.resolve(options.root);
    this.onBatch = options.onBatch;
    this.onError = options.onError ?? (() => {});
    this.canProcess = options.canProcess ?? (() => true);
    this.debounceMs = options.debounceMs ?? 750;
    this.maxBatchSize = options.maxBatchSize ?? 200;
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1) {
      throw new Error('Incremental watch maxBatchSize must be a positive integer.');
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.changedPaths.clear();
    await this.watcher?.close();
    await this.flushPromise;
  }

  async start(): Promise<void> {
    if (this.watcher) throw new Error('Incremental watch service is already running.');
    this.watcher = watch(this.root, {
      awaitWriteFinish: { pollInterval: 100, stabilityThreshold: 300 },
      ignored: (candidate) => this.isIgnored(candidate),
      ignoreInitial: true,
      persistent: true,
    });
    this.watcher.on('add', (candidate) => this.enqueue(candidate));
    this.watcher.on('change', (candidate) => this.enqueue(candidate));
    this.watcher.on('unlink', (candidate) => this.enqueue(candidate));
    await new Promise<void>((resolve, reject) => {
      this.watcher?.once('ready', resolve);
      this.watcher?.once('error', reject);
    });
  }

  private enqueue(candidate: string): void {
    if (this.stopped) return;
    const relativePath = path.relative(this.root, path.resolve(candidate));
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;
    this.changedPaths.add(relativePath.split(path.sep).join('/'));
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.flushPromise = this.flush().catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.running || this.stopped || this.changedPaths.size === 0) return;
    if (!this.canProcess()) {
      this.scheduleFlush();
      return;
    }

    const batch = [...this.changedPaths].sort().slice(0, this.maxBatchSize);
    for (const changedPath of batch) this.changedPaths.delete(changedPath);
    this.running = true;
    try {
      await this.onBatch(batch);
    } finally {
      this.running = false;
      if (!this.stopped && this.changedPaths.size > 0) {
        if (this.canProcess()) {
          await this.flush();
        } else {
          this.scheduleFlush();
        }
      }
    }
  }

  private isIgnored(candidate: string): boolean {
    const relativePath = path.relative(this.root, path.resolve(candidate));
    if (!relativePath) return false;
    const firstSegment = relativePath.split(path.sep, 1)[0];
    return firstSegment ? IGNORED_ROOT_ENTRIES.has(firstSegment) : false;
  }

  private scheduleFlush(): void {
    if (this.stopped || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.flushPromise = this.flush().catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }
}

export function calculateSecurityDelta(
  previous: readonly EnhancedFinding[],
  current: readonly EnhancedFinding[],
  auditedPaths?: readonly string[],
): SecurityDelta {
  const previousById = new Map(previous.map((finding) => [finding.vulnId, finding]));
  const currentById = new Map(current.map((finding) => [finding.vulnId, finding]));
  const normalizedScope = auditedPaths
    ? new Set(auditedPaths.map((file) => file.replaceAll('\\', '/')))
    : null;
  const wasFullyReaudited = (finding: EnhancedFinding) =>
    normalizedScope === null ||
    (finding.locations.length > 0 && finding.locations.every(
      ({filePath}) => normalizedScope.has(filePath.replaceAll('\\', '/')),
    ));
  const outOfScope = previous.filter(
    (finding) => !currentById.has(finding.vulnId) && !wasFullyReaudited(finding),
  );

  return {
    introduced: current.filter((finding) => !previousById.has(finding.vulnId)),
    resolved: previous.filter(
      (finding) => !currentById.has(finding.vulnId) && wasFullyReaudited(finding),
    ),
    unchanged: [
      ...current.filter((finding) => previousById.has(finding.vulnId)),
      ...outOfScope,
    ],
  };
}

export function updateWatchBaseline(delta: SecurityDelta): EnhancedFinding[] {
  const findings = new Map<string, EnhancedFinding>();
  for (const finding of [...delta.unchanged, ...delta.introduced]) {
    findings.set(finding.vulnId, finding);
  }

  return [...findings.values()];
}

export function formatSecurityDelta(delta: SecurityDelta): string {
  const lines = [
    `**Security delta:** ${delta.introduced.length} introduced, ${delta.resolved.length} resolved, ${delta.unchanged.length} unchanged.`,
  ];
  if (delta.introduced.length > 0) {
    lines.push(`Introduced: ${delta.introduced.map((finding) => finding.vulnId).join(', ')}`);
  }

  if (delta.resolved.length > 0) {
    lines.push(`Resolved: ${delta.resolved.map((finding) => finding.vulnId).join(', ')}`);
  }

  return lines.join('\n');
}
