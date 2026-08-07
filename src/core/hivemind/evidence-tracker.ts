/**
 * EvidenceTracker - Collects audit-trail IDs produced during a worker task.
 *
 * As an agent works through a task it touches events (EventStore) and knowledge
 * graph entities. This lightweight tracker accumulates those IDs so that any
 * evidence claim submitted by the worker can be cryptographically linked to the
 * actual artifacts it interacted with, rather than claiming to have evidence
 * while passing an empty list.
 */

export class EvidenceTracker {
  private readonly entityIds: Set<string> = new Set();
  private readonly eventIds: Set<string> = new Set();

  /**
   * Record multiple entity IDs.
   */
  addEntities(entityIds: string[]): void {
    for (const id of entityIds) {
      this.entityIds.add(id);
    }
  }

  /**
   * Record a knowledge-graph entity ID that the worker touched.
   */
  addEntity(entityId: string): void {
    this.entityIds.add(entityId);
  }

  /**
   * Record an event ID that the worker produced or observed.
   */
  addEvent(eventId: string): void {
    this.eventIds.add(eventId);
  }

  /**
   * Record multiple event IDs.
   */
  addEvents(eventIds: string[]): void {
    for (const id of eventIds) {
      this.eventIds.add(id);
    }
  }

  /**
   * Return the currently tracked entity IDs as a sorted array.
   */
  getLinkedEntityIds(): string[] {
    return [...this.entityIds].sort();
  }

  /**
   * Return the currently tracked event IDs as a sorted array.
   */
  getLinkedEventIds(): string[] {
    return [...this.eventIds].sort();
  }

  /**
   * Reset the tracker. Useful when a worker starts a fresh task.
   */
  reset(): void {
    this.eventIds.clear();
    this.entityIds.clear();
  }
}
