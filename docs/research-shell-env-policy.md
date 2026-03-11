## Shell Environment Policy Research

### Problem
`tmux new-session` inherits the parent process environment, including API keys set in the shell where
`syn` runs. That can cause spawned agent sessions to authenticate via API keys instead of account
profiles/subscription auth.

### tmux Environment Behavior
- `tmux new-session -e KEY=VALUE` explicitly adds or overrides variables for the new session.
- Variables not explicitly provided with `-e` still inherit from the process that launched tmux.
- After session creation, commands sent into the shell (`send-keys`) can mutate shell-local env.

### Unset Options Considered
1. `tmux set-environment -u KEY`
   - Removes variables from tmux server/session environment.
   - Does not guarantee cleanup of variables already present in the shell process for pane startup
     timing, and differs across shell startup/profile behaviors.
2. Shell-level `unset KEY...` in the pane before launch
   - Runs in the exact shell process that executes the agent command.
   - Deterministic ordering when done immediately after `new-session` and before launch command.

### Decision
Use shell-level `unset` in the tmux pane after session creation and before the agent launch command.
This keeps behavior local to runtime launch flow, avoids broad tmux server mutation, and provides
clear precedence: configured excludes win over inherited parent environment.

### Compatibility
If `shellEnvironmentPolicy` is not configured or `exclude` is empty, runtime behavior remains
unchanged.
