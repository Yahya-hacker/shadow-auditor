import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

export default [
	includeIgnoreFile(gitignorePath),
	...oclif,
	prettier,
	{
		files: ['**/*.{ts,tsx,js,mjs,cjs}'],
		rules: {
			'@typescript-eslint/no-unused-vars': 'off',
			camelcase: 'off',
			'no-await-in-loop': 'off',
			'prefer-destructuring': 'off',
			'unicorn/filename-case': 'off',
			'unicorn/import-style': 'off',
			'unicorn/no-useless-switch-case': 'off',
			'unicorn/prefer-spread': 'off',
			'unicorn/prefer-ternary': 'off',
			'unicorn/text-encoding-identifier-case': 'off',
		},
	},
]
