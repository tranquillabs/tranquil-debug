"use babel";

// tranquil-debug — breakpoint and step debugging for .ts automations (ADR-0025).
//
// Automations run as `deno run` subprocesses (ADR-0022). This package launches them under Deno's
// V8 inspector and speaks the CDP Debugger domain directly; there is no debug adapter, because
// Deno has none and VS Code debugs it the same way.
//
// Services, not direct requires: the runner lives in tranquil-automations, so the debug launch
// path arrives via its `automation-runner` service and the toolbar buttons via `pane-controls`.
// Both are consumed lazily — the package must stay inert (and must not throw) when either is
// absent, since a throwing top-level require silently kills activation with no commands at all.

const { CompositeDisposable } = require("atom");

module.exports = {
  activate() {
    this.subscriptions = new CompositeDisposable();
  },

  deactivate() {
    if (this.subscriptions) this.subscriptions.dispose();
    this.subscriptions = null;
  },

  consumePaneControls(paneControls) {
    this.paneControls = paneControls;
  },

  consumeAutomationRunner(runner) {
    this.runner = runner;
  },
};
