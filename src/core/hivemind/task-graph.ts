/**
 * Task Graph - Dependency-aware task management.
 */

import * as crypto from 'node:crypto';

import { err, ok, type Result } from '../schema/base.js';
import {
  type AgentRole,
  type Task,
  type TaskPriority,
  taskSchema,
  type TaskStatus,
} from './hivemind-schema.js';

export interface CreateTaskInput {
  dependencies?: string[];
  description: string;
  parameters?: Record<string, unknown>;
  priority?: TaskPriority;
  requiredRole?: AgentRole;
  taskType: string;
  timeout?: number;
}

/**
 * Manages tasks with dependency tracking.
 */
export class TaskGraph {
  private taskDependents: Map<string, Set<string>> = new Map(); // taskId -> tasks that depend on it
private tasks: Map<string, Task> = new Map();
  // Indexes for efficient queries
  private tasksByStatus: Map<TaskStatus, Set<string>> = new Map();

  constructor() {
    // Initialize status indexes
    const statuses: TaskStatus[] = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled'];
    for (const status of statuses) {
      this.tasksByStatus.set(status, new Set());
    }
  }

  /**
   * Cancel a task.
   */
  cancelTask(taskId: string): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    if (task.status === 'completed' || task.status === 'failed') {
      return err(`Cannot cancel completed/failed task`);
    }

    const updated: Task = {
      ...task,
      completedAt: new Date().toISOString(),
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);
    return ok(updated);
  }

  /**
   * Claim a task for an agent.
   */
  claimTask(taskId: string, agentId: string): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    if (task.status !== 'pending') {
      return err(`Task is not claimable (status: ${task.status})`);
    }

    if (!this.areDependenciesSatisfied(task)) {
      return err('Task dependencies are not satisfied');
    }

    const updated: Task = {
      ...task,
      assignedAgent: agentId,
      claimedAt: new Date().toISOString(),
      status: 'claimed',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);
    return ok(updated);
  }

  /**
   * Complete a task.
   */
  completeTask(taskId: string, result?: unknown): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    if (task.status !== 'in_progress') {
      return err(`Task must be in progress (status: ${task.status})`);
    }

    const updated: Task = {
      ...task,
      completedAt: new Date().toISOString(),
      result,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);

    // Check if this unblocks any dependent tasks
    this.updateBlockedDependents(taskId);

    return ok(updated);
  }

  /**
   * Create a new task.
   */
  createTask(input: CreateTaskInput): Result<Task, string> {
    const now = new Date().toISOString();
    const taskId = `task_${crypto.randomBytes(8).toString('hex')}`;

    // Validate dependencies exist
    for (const depId of input.dependencies ?? []) {
      if (!this.tasks.has(depId)) {
        return err(`Dependency task not found: ${depId}`);
      }
    }

    // Check for cyclic dependencies
    if (this.wouldCreateCycle(taskId, input.dependencies ?? [])) {
      return err('Task dependencies would create a cycle');
    }

    const task: Task = {
      createdAt: now,
      dependencies: input.dependencies ?? [],
      description: input.description,
      parameters: input.parameters ?? {},
      priority: input.priority ?? 'medium',
      requiredRole: input.requiredRole,
      status: this.determineInitialStatus(input.dependencies ?? []),
      taskId,
      taskType: input.taskType,
      timeout: input.timeout,
      updatedAt: now,
    };

    const validation = taskSchema.safeParse(task);
    if (!validation.success) {
      return err(`Invalid task: ${validation.error.message}`);
    }

    this.tasks.set(taskId, task);
    this.indexTask(task);

    return ok(task);
  }

  /**
   * Export tasks for persistence.
   */
  exportTasks(): Task[] {
    return this.getAllTasks();
  }

  /**
   * Fail a task.
   */
  failTask(taskId: string, errorMessage: string): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    const updated: Task = {
      ...task,
      completedAt: new Date().toISOString(),
      errorMessage,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);
    return ok(updated);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /**
   * Get tasks that are ready to be claimed (pending with satisfied dependencies).
   */
  getClaimableTasks(role?: AgentRole): Task[] {
    const pending = this.getTasksByStatus('pending');

    return pending.filter((task) => {
      // Check role requirement
      if (role && task.requiredRole && task.requiredRole !== role) {
        return false;
      }

      // Check dependencies are satisfied
      return this.areDependenciesSatisfied(task);
    });
  }

  /**
   * Get tasks sorted by priority.
   */
  getPrioritizedTasks(): Task[] {
    const priorityOrder: Record<TaskPriority, number> = {
      critical: 0,
      high: 1,
      low: 3,
      medium: 2,
    };

    return this.getAllTasks().sort((a, b) => {
      // First by status (pending/in_progress first)
      const statusOrder = ['in_progress', 'claimed', 'pending', 'blocked', 'completed', 'failed', 'cancelled'];
      const statusDiff = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
      if (statusDiff !== 0) return statusDiff;

      // Then by priority
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Get task statistics.
   */
  getStats(): Record<TaskStatus, number> {
    const stats: Record<TaskStatus, number> = {
      blocked: 0,
      cancelled: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      in_progress: 0,
      pending: 0,
    };

    for (const [status, ids] of this.tasksByStatus) {
      stats[status] = ids.size;
    }

    return stats;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get tasks by status.
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    const ids = this.tasksByStatus.get(status);
    if (!ids) return [];
    return [...ids].map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  /**
   * Import tasks from persistence.
   */
  importTasks(tasks: Task[]): void {
    this.tasks.clear();
    for (const set of this.tasksByStatus.values()) set.clear();
    this.taskDependents.clear();

    for (const task of tasks) {
      this.tasks.set(task.taskId, task);
      this.indexTask(task);
    }
  }

  /**
   * Release a claimed task back to pending.
   */
  releaseTask(taskId: string): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    if (task.status !== 'claimed' && task.status !== 'in_progress') {
      return err(`Task must be claimed or in progress`);
    }

    const updated: Task = {
      ...task,
      assignedAgent: undefined,
      claimedAt: undefined,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);
    return ok(updated);
  }

  /**
   * Start working on a claimed task.
   */
  startTask(taskId: string): Result<Task, string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(`Task not found: ${taskId}`);
    }

    if (task.status !== 'claimed') {
      return err(`Task must be claimed first (status: ${task.status})`);
    }

    const updated: Task = {
      ...task,
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    };

    this.updateTaskInternal(updated);
    return ok(updated);
  }

  private areDependenciesSatisfied(task: Task): boolean {
    return task.dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'completed';
    });
  }

  private determineInitialStatus(dependencies: string[]): TaskStatus {
    if (dependencies.length === 0) {
      return 'pending';
    }

    // Check if all dependencies are completed
    const allCompleted = dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'completed';
    });

    return allCompleted ? 'pending' : 'blocked';
  }

  private indexTask(task: Task): void {
    // Index by status
    this.tasksByStatus.get(task.status)?.add(task.taskId);

    // Index dependents
    for (const depId of task.dependencies) {
      const dependents = this.taskDependents.get(depId) ?? new Set();
      dependents.add(task.taskId);
      this.taskDependents.set(depId, dependents);
    }
  }

  private updateBlockedDependents(completedTaskId: string): void {
    const dependents = this.taskDependents.get(completedTaskId);
    if (!dependents) return;

    for (const dependentId of dependents) {
      const dependent = this.tasks.get(dependentId);
      if (!dependent || dependent.status !== 'blocked') continue;

      if (this.areDependenciesSatisfied(dependent)) {
        const updated: Task = {
          ...dependent,
          status: 'pending',
          updatedAt: new Date().toISOString(),
        };
        this.updateTaskInternal(updated);
      }
    }
  }

  private updateTaskInternal(task: Task): void {
    const old = this.tasks.get(task.taskId);
    if (old) {
      // Remove from old status index
      this.tasksByStatus.get(old.status)?.delete(task.taskId);
    }

    this.tasks.set(task.taskId, task);
    this.tasksByStatus.get(task.status)?.add(task.taskId);
  }

  private wouldCreateCycle(newTaskId: string, dependencies: string[]): boolean {
    // BFS to check if any dependency transitively depends on newTaskId
    const visited = new Set<string>();
    const queue = [...dependencies];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const task = this.tasks.get(current);
      if (!task) continue;

      for (const depId of task.dependencies) {
        if (depId === newTaskId) {
          return true; // Cycle detected
        }

        queue.push(depId);
      }
    }

    return false;
  }
}
