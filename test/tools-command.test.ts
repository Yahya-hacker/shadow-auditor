import {expect} from 'chai';

import type {CommandContext} from '../src/ui/commands.js';

import {findCommand} from '../src/ui/commands.js';
import {useAppStore} from '../src/ui/store/appStore.js';

describe('/tools command', () => {
  it('opens the tools screen without replacing the active session state', async () => {
    const activeSession = useAppStore.getState().session;
    useAppStore.setState({screen: 'shell'});

    const command = findCommand('/tools');
    expect(command).not.to.equal(undefined);
    await command?.execute('', {} as CommandContext);

    const state = useAppStore.getState();
    expect(state.screen).to.equal('tools');
    expect(state.session).to.equal(activeSession);
  });
});
