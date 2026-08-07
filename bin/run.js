#!/usr/bin/env node

import {execute} from '@oclif/core'
import {realpathSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

import {routeDefaultCommand} from '../dist/cli-argv.js'

process.argv[1] = realpathSync(process.argv[1])
process.argv = routeDefaultCommand(process.argv)

const executableUrl = pathToFileURL(process.argv[1]).href
await execute({args: process.argv.slice(2), dir: executableUrl})
