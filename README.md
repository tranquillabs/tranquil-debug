# tranquil-debug

Breakpoint and step debugging for Tranquil's TypeScript automations.

Automations run as `deno run` subprocesses (see ADR-0022). This package launches them under
Deno's V8 inspector and drives the Chrome DevTools Protocol `Debugger` domain directly — there is
no debug adapter in between. Deno has no DAP adapter, and VS Code debugs Deno the same way.

## What it does

- **Breakpoints** — a dedicated gutter column on any `.ts` editor. Click a line to toggle;
  `F9` from the keyboard. Breakpoints persist across sessions.
- **Debug a run** — a Debug button beside Run in the editor's pane controls, with the usual
  transport controls (continue, step over/into/out, stop) while a session is live.
- **Inspect** — a left-dock pane with the call stack, scopes and variables, watch expressions,
  and an expression console evaluated in the paused frame.

## Why breakpoints move

Deno transpiles TypeScript by re-printing from the AST, so generated line numbers rarely match
the source: measured across the local emit cache, only **21.7%** of mapping segments land on the
same line, with drift up to 127 lines. Breakpoints are therefore placed through the script's
inline source map, and the marker moves to the line where the debugger actually bound it.

A breakpoint keeps the position you clicked until a debugger says otherwise. Once a session
resolves it, the dot moves to where it really is; if a session cannot bind it, the dot stays put
and greys out (the "unbound" state). Editing the file un-verifies its breakpoints until the next
run, since the debugger is executing what is on disk.

## Requirements

Deno, and the `tranquil-automations` package (this consumes its `automation-runner` and
`pane-controls` services).

## Development

Clone alongside `tranquil-client` and symlink into the dev packages directory:

```sh
ln -s /path/to/tranquil-debug ~/.tranquil/dev/packages/tranquil-debug
```
