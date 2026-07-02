import { expect } from 'chai';
import { describe, it } from 'mocha';

import { EvidenceTracker } from '../../src/core/hivemind/evidence-tracker.js';

describe('EvidenceTracker', () => {
  it('accumulates event and entity IDs', () => {
    const tracker = new EvidenceTracker();
    tracker.addEvent('event_abc123');
    tracker.addEvents(['event_def456', 'event_abc123']);
    tracker.addEntity('ent_abc123');
    tracker.addEntities(['ent_def456', 'ent_abc123']);

    expect(tracker.getLinkedEventIds()).to.deep.equal(['event_abc123', 'event_def456']);
    expect(tracker.getLinkedEntityIds()).to.deep.equal(['ent_abc123', 'ent_def456']);
  });

  it('deduplicates IDs and returns sorted arrays', () => {
    const tracker = new EvidenceTracker();
    tracker.addEvent('event_z');
    tracker.addEvent('event_a');
    tracker.addEntity('ent_z');
    tracker.addEntity('ent_a');

    expect(tracker.getLinkedEventIds()).to.deep.equal(['event_a', 'event_z']);
    expect(tracker.getLinkedEntityIds()).to.deep.equal(['ent_a', 'ent_z']);
  });

  it('resets for a new task', () => {
    const tracker = new EvidenceTracker();
    tracker.addEvent('event_abc123');
    tracker.addEntity('ent_abc123');
    tracker.reset();

    expect(tracker.getLinkedEventIds()).to.deep.equal([]);
    expect(tracker.getLinkedEntityIds()).to.deep.equal([]);
  });
});
