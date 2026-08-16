import { expect } from 'chai';

import { routeDefaultCommand } from '../src/cli-argv.js';
import Shell from '../src/commands/shell.js';

describe('CLI argument routing', () => {
  it('routes root-level options to the default shell command', () => {
    expect(routeDefaultCommand(['node', 'bin/run.js', '--ci', '--fail-on', 'high']))
      .to.deep.equal(['node', 'bin/run.js', 'shell', '--ci', '--fail-on', 'high']);
  });

  it('preserves explicit commands', () => {
    expect(routeDefaultCommand(['node', 'bin/run.js', 'help']))
      .to.deep.equal(['node', 'bin/run.js', 'help']);
  });

  it('routes root help and normalizes root version flags', () => {
    expect(routeDefaultCommand(['node', 'bin/run.js', '--help']))
      .to.deep.equal(['node', 'bin/run.js', 'shell', '--help']);
    expect(routeDefaultCommand(['node', 'bin/run.js', '--version']))
      .to.deep.equal(['node', 'bin/run.js', '--version']);
    expect(routeDefaultCommand(['node', 'bin/run.js', '-v']))
      .to.deep.equal(['node', 'bin/run.js', '--version']);
  });

  it('routes positional targets to the default command', () => {
    expect(routeDefaultCommand(['node', 'bin/run.js', './src', '--ci']))
      .to.deep.equal(['node', 'bin/run.js', 'shell', './src', '--ci']);
  });

  it('accepts and routes a prompt for CI checkpoint recovery', () => {
    const argv = [
      'node',
      'bin/run.js',
      '--ci',
      '--resume-run',
      'run-123',
      '--prompt',
      'yes',
    ];

    expect(routeDefaultCommand(argv)).to.deep.equal([
      'node',
      'bin/run.js',
      'shell',
      '--ci',
      '--resume-run',
      'run-123',
      '--prompt',
      'yes',
    ]);
    expect(Shell.flags.prompt).to.exist;
  });

  it('routes --resume <id> to --resume-run <id>', () => {
    expect(routeDefaultCommand(['node', 'bin/run.js', '--resume', 'run-123']))
      .to.deep.equal(['node', 'bin/run.js', 'shell', '--resume-run', 'run-123']);
  });

  it('throws a helpful error for bare --resume when no runs exist', () => {
    expect(() => routeDefaultCommand(['node', 'bin/run.js', '--resume']))
      .to.throw('No previous session found to resume');
  });
});
