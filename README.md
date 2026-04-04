shadow-auditor
=================

A new CLI generated with oclif


[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/shadow-auditor.svg)](https://npmjs.org/package/shadow-auditor)
[![Downloads/week](https://img.shields.io/npm/dw/shadow-auditor.svg)](https://npmjs.org/package/shadow-auditor)


<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g shadow-auditor
$ shadow-auditor COMMAND
running command...
$ shadow-auditor (--version)
shadow-auditor/0.0.0 linux-x64 node-v22.22.0
$ shadow-auditor --help [COMMAND]
USAGE
  $ shadow-auditor COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`shadow-auditor hello PERSON`](#shadow-auditor-hello-person)
* [`shadow-auditor hello world`](#shadow-auditor-hello-world)
* [`shadow-auditor help [COMMAND]`](#shadow-auditor-help-command)
* [`shadow-auditor plugins`](#shadow-auditor-plugins)
* [`shadow-auditor plugins add PLUGIN`](#shadow-auditor-plugins-add-plugin)
* [`shadow-auditor plugins:inspect PLUGIN...`](#shadow-auditor-pluginsinspect-plugin)
* [`shadow-auditor plugins install PLUGIN`](#shadow-auditor-plugins-install-plugin)
* [`shadow-auditor plugins link PATH`](#shadow-auditor-plugins-link-path)
* [`shadow-auditor plugins remove [PLUGIN]`](#shadow-auditor-plugins-remove-plugin)
* [`shadow-auditor plugins reset`](#shadow-auditor-plugins-reset)
* [`shadow-auditor plugins uninstall [PLUGIN]`](#shadow-auditor-plugins-uninstall-plugin)
* [`shadow-auditor plugins unlink [PLUGIN]`](#shadow-auditor-plugins-unlink-plugin)
* [`shadow-auditor plugins update`](#shadow-auditor-plugins-update)

## `shadow-auditor hello PERSON`

Say hello

```
USAGE
  $ shadow-auditor hello PERSON -f <value>

ARGUMENTS
  PERSON  Person to say hello to

FLAGS
  -f, --from=<value>  (required) Who is saying hello

DESCRIPTION
  Say hello

EXAMPLES
  $ shadow-auditor hello friend --from oclif
  hello friend from oclif! (./src/commands/hello/index.ts)
```

_See code: [src/commands/hello/index.ts](https://github.com/Yahya-hacker/shadow-auditor/blob/v0.0.0/src/commands/hello/index.ts)_

## `shadow-auditor hello world`

Say hello world

```
USAGE
  $ shadow-auditor hello world

DESCRIPTION
  Say hello world

EXAMPLES
  $ shadow-auditor hello world
  hello world! (./src/commands/hello/world.ts)
```

_See code: [src/commands/hello/world.ts](https://github.com/Yahya-hacker/shadow-auditor/blob/v0.0.0/src/commands/hello/world.ts)_

## `shadow-auditor help [COMMAND]`

Display help for shadow-auditor.

```
USAGE
  $ shadow-auditor help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for shadow-auditor.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/6.2.42/src/commands/help.ts)_

## `shadow-auditor plugins`

List installed plugins.

```
USAGE
  $ shadow-auditor plugins [--json] [--core]

FLAGS
  --core  Show core plugins.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List installed plugins.

EXAMPLES
  $ shadow-auditor plugins
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/index.ts)_

## `shadow-auditor plugins add PLUGIN`

Installs a plugin into shadow-auditor.

```
USAGE
  $ shadow-auditor plugins add PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into shadow-auditor.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SHADOW_AUDITOR_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SHADOW_AUDITOR_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ shadow-auditor plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ shadow-auditor plugins add myplugin

  Install a plugin from a github url.

    $ shadow-auditor plugins add https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ shadow-auditor plugins add someuser/someplugin
```

## `shadow-auditor plugins:inspect PLUGIN...`

Displays installation properties of a plugin.

```
USAGE
  $ shadow-auditor plugins inspect PLUGIN...

ARGUMENTS
  PLUGIN...  [default: .] Plugin to inspect.

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Displays installation properties of a plugin.

EXAMPLES
  $ shadow-auditor plugins inspect myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/inspect.ts)_

## `shadow-auditor plugins install PLUGIN`

Installs a plugin into shadow-auditor.

```
USAGE
  $ shadow-auditor plugins install PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into shadow-auditor.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SHADOW_AUDITOR_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SHADOW_AUDITOR_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ shadow-auditor plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ shadow-auditor plugins install myplugin

  Install a plugin from a github url.

    $ shadow-auditor plugins install https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ shadow-auditor plugins install someuser/someplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/install.ts)_

## `shadow-auditor plugins link PATH`

Links a plugin into the CLI for development.

```
USAGE
  $ shadow-auditor plugins link PATH [-h] [--install] [-v]

ARGUMENTS
  PATH  [default: .] path to plugin

FLAGS
  -h, --help          Show CLI help.
  -v, --verbose
      --[no-]install  Install dependencies after linking the plugin.

DESCRIPTION
  Links a plugin into the CLI for development.

  Installation of a linked plugin will override a user-installed or core plugin.

  e.g. If you have a user-installed or core plugin that has a 'hello' command, installing a linked plugin with a 'hello'
  command will override the user-installed or core plugin implementation. This is useful for development work.


EXAMPLES
  $ shadow-auditor plugins link myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/link.ts)_

## `shadow-auditor plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ shadow-auditor plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ shadow-auditor plugins unlink
  $ shadow-auditor plugins remove

EXAMPLES
  $ shadow-auditor plugins remove myplugin
```

## `shadow-auditor plugins reset`

Remove all user-installed and linked plugins.

```
USAGE
  $ shadow-auditor plugins reset [--hard] [--reinstall]

FLAGS
  --hard       Delete node_modules and package manager related files in addition to uninstalling plugins.
  --reinstall  Reinstall all plugins after uninstalling.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/reset.ts)_

## `shadow-auditor plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ shadow-auditor plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ shadow-auditor plugins unlink
  $ shadow-auditor plugins remove

EXAMPLES
  $ shadow-auditor plugins uninstall myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/uninstall.ts)_

## `shadow-auditor plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ shadow-auditor plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ shadow-auditor plugins unlink
  $ shadow-auditor plugins remove

EXAMPLES
  $ shadow-auditor plugins unlink myplugin
```

## `shadow-auditor plugins update`

Update installed plugins.

```
USAGE
  $ shadow-auditor plugins update [-h] [-v]

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Update installed plugins.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.59/src/commands/plugins/update.ts)_
<!-- commandsstop -->
