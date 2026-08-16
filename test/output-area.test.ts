import { expect } from 'chai';

import {
  resolveBottomRelativeScroll,
  selectRecentActivity,
} from '../src/ui/components/OutputArea.js';
import { useAppStore } from '../src/ui/store/appStore.js';

describe('OutputArea activity filtering', () => {
  const activity = Array.from({ length: 4 }, (_, index) => ({
    id: String(index),
    kind: 'tool_result',
    text: `result ${index}`,
    timestamp: '12:00:00',
  }));

  it('hides tool activity when the Tool Calls filter is disabled', () => {
    expect(selectRecentActivity(activity, {agent: true, tool_calls: false})).to.deep.equal([]);
  });

  it('shows tagged tool activity by default', () => {
    expect(useAppStore.getState().filters.tool_calls).to.equal(true);
  });

  it('clears Show All when an individual filter is disabled', () => {
    const store = useAppStore.getState();
    store.setFilter('all', true);
    store.setFilter('errors', false);
    expect(useAppStore.getState().filters).to.include({all: false, errors: false});
    useAppStore.getState().setFilter('all', false);
  });

  it('keeps all retained tool events available for transcript scrolling', () => {
    expect(selectRecentActivity(activity, {agent: true, tool_calls: true}).map((event) => event.id)).to.deep.equal(['0', '1', '2', '3']);
  });

  it('keeps a scrolled viewport anchored while streamed content grows', () => {
    expect(resolveBottomRelativeScroll(12, 100, 125)).to.equal(37);
  });

  it('keeps zero offset pinned to the latest streamed output', () => {
    expect(resolveBottomRelativeScroll(0, 100, 125)).to.equal(0);
  });

  it('does not mistake initial measurement for streamed growth after remounting', () => {
    expect(resolveBottomRelativeScroll(12, null, 125)).to.equal(12);
  });

  it('preserves prior activity when a new prompt starts streaming', () => {
    const store = useAppStore.getState();
    store.clearActivity();
    store.addActivityEvent({
      kind: 'agent_progress',
      message: 'Repository map complete',
      stage: 'codebase_intelligence',
      timestamp: '12:00:00',
    });

    store.startStreaming();

    expect(useAppStore.getState().activity).to.have.length(1);
    expect(useAppStore.getState().activity[0]?.text).to.equal('Repository map complete');
    useAppStore.getState().finishStreaming();
  });

  it('keeps agent progress visible independently of tool filtering', () => {
    const progress = {
      agent: 'SAST Auditor',
      id: 'progress',
      kind: 'agent_progress',
      text: 'Tracing the request path.',
      timestamp: '12:00:00',
    };

    expect(selectRecentActivity([progress], {agent: true, tool_calls: false})).to.deep.equal([progress]);
  });

  it('updates a tool call in place when its result arrives', () => {
    const store = useAppStore.getState();
    store.clearActivity();
    const previousSequence = useAppStore.getState().timelineSequence;
    store.addActivityEvent({
      kind: 'tool_call',
      message: 'Reading src/index.ts',
      stage: 'sast_audit',
      timestamp: '12:00:00',
      toolCallId: 'call-1',
      toolName: 'read_file_content',
    });
    store.addActivityEvent({
      kind: 'tool_result',
      message: 'Read src/index.ts',
      resultPreview: '42 lines',
      stage: 'sast_audit',
      succeeded: true,
      timestamp: '12:00:01',
      toolCallId: 'call-1',
      toolName: 'read_file_content',
    });

    expect(useAppStore.getState().activity).to.deep.include({
      id: 'tool-sast_audit-call-1',
      kind: 'tool_result',
      resultPreview: '42 lines',
      sequence: previousSequence + 1,
      stage: 'sast_audit',
      succeeded: true,
      text: 'Read src/index.ts',
      timestamp: '12:00:00',
      toolCallId: 'call-1',
    });
    expect(useAppStore.getState().activity).to.have.length(1);
  });

  it('#19 keeps two identity-less events that share kind/timestamp/message distinct', () => {
    const store = useAppStore.getState();
    store.clearActivity();
    const base = {
          kind: 'agent_progress',
      message: 'Reasoning about taint propagation',
      stage: 'sast_audit',
      timestamp: '12:00:00',
        } as const;
    store.addActivityEvent({...base});
    store.addActivityEvent({...base});

    const activity = useAppStore.getState().activity;
    expect(activity).to.have.length(2);
    const ids = new Set(activity.map((item) => item.id));
    expect(ids.size).to.equal(2);
    expect(activity.every((item) => item.text === 'Reasoning about taint propagation')).to.equal(true);
  });  it('uses structured finding IDs instead of presentation labels', () => {
    const finding = {
      agent: 'SAST Auditor',
      id: 'finding',
      kind: 'agent_progress',
      text: 'Confirmed VULN-004 in the authorization boundary.',
      timestamp: '12:00:00',
    };

    expect(selectRecentActivity(
      [finding],
      {agent: false, findings: true, tool_calls: false},
      new Set(['VULN-004']),
    )).to.deep.equal([finding]);
  });
});
