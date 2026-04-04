The current implementation works, but the UX is too traditional. We need to pivot from a standard "CLI command with flags" to a fully immersive **Agentic Shell / Interactive Workspace** (similar to `claude-code` or `github copilot cli`).

**Phase 3 Mission: The Interactive REPL & Root Command**

Please refactor the project with the following architectural shifts:

### 1. Hijack the Root Command
- The user must NOT need to type `shadow-auditor scan <path>`. They should just type `shadow-auditor`.
- In Oclif, modify `package.json` to set the default command, or rename `src/commands/scan.ts` to `src/index.ts` (or `src/commands/index.ts` depending on your Oclif setup) so it becomes the root execution point.

### 2. The Immersive Welcome & Onboarding
When the user types `shadow-auditor`, the following must happen in order:
- **Welcome Banner:** Print a sleek, hacker-styled welcome message (use `console.log` with ASCII art or styling if possible, keeping it professional).
- **Configuration Check:** Run the `setup.ts` logic. If no config exists, run the interactive `@clack/prompts` wizard to get the Provider, Model, and API Key.
- **Target Selection:** Ask the user interactively: "Which directory would you like to audit?" (Provide `.` as the default current directory). 
- **Initialization:** Generate the Tree-sitter Repo Map silently in the background with a loading spinner.

### 3. The Interactive REPL (Read-Eval-Print Loop)
Do not automatically start the vulnerability scan. Instead, enter a continuous chat UI.
- Implement a `while (true)` loop in the main execution flow.
- Use `@clack/prompts` (specifically `p.text()`) to display a persistent input prompt: `Shadow Auditor > `
- The agent waits for the user to type a command (e.g., "Analyze the authentication flow based on the repo map" or "Find logic flaws in the user controller").
- If the user types 'exit', 'quit', or presses Ctrl+C, gracefully exit the shell.

### 4. Memory & Execution (Vercel AI SDK)
- Maintain an array of `CoreMessage[]` initialized with the System Prompt (the Senior Security Researcher persona) and a system message containing the Repo Map.
- When the user types a message, push it to the array.
- Call the `streamText` API. Stream the output beautifully to the terminal.
- Ensure the `read_file_content` tool is active. The agent must be able to say "I need to look closer at auth.ts", trigger the tool, read the file silently, and continue streaming its analysis.
- Append both the assistant's response and any tool execution results back into the `CoreMessage[]` array so the agent remembers the entire conversation.

Execute this refactoring completely. Do not leave placeholders. Ensure the user is dropped into the `Shadow Auditor >` chat prompt immediately after the initial setup.
