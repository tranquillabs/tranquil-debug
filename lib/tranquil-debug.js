"use babel";

// tranquil-debug — breakpoint and step debugging for .ts automations (ADR-0025).
//
// Automations run as `deno run` subprocesses (ADR-0022). This package launches them under Deno's
// V8 inspector and speaks the CDP Debugger domain directly; there is no debug adapter, because
// Deno has none and VS Code debugs Deno the same way (its launch config is `type: "node"`, i.e.
// js-debug driving CDP).
//
// Services, not direct requires: the runner lives in tranquil-automations, so the debug launch
// path arrives via its `automation-runner` service and the toolbar buttons via `pane-controls`.
// Both are consumed lazily and the package stays inert without them — an owned dev package cannot
// require the app's node_modules, and a throwing top-level require silently kills activation with
// no commands appearing at all.

const { CompositeDisposable } = require("atom");
const { BreakpointStore, EditorBreakpoints } = require("./breakpoints.js");
const { DebugSession } = require("./debug-session.js");
const { DebugControls } = require("./debug-controls.js");
const { CurrentLine } = require("./current-line.js");
const DebugPanelView = require("./debug-panel.js");

// Saved TypeScript files only. Unsaved buffers have no path to hang a breakpoint on, and the
// debugger executes what is on disk.
function isDebuggableEditor(editor) {
  return (
    editor &&
    typeof editor.getPath === "function" &&
    !!editor.getPath() &&
    editor.getPath().endsWith(".ts")
  );
}

module.exports = {
  activate() {
    this.subscriptions = new CompositeDisposable();
    this.store = new BreakpointStore();
    this.currentLine = new CurrentLine();
    this.editors = new Map(); // TextEditor → EditorBreakpoints

    this.subscriptions.add(
      atom.workspace.observeTextEditors((editor) => {
        if (!isDebuggableEditor(editor)) return;
        this.attachGutter(editor);
      })
    );

    this.subscriptions.add(
      atom.commands.add("atom-text-editor", {
        "tranquil-debug:toggle-breakpoint": {
          displayName: "Debug: Toggle Breakpoint",
          didDispatch: () => this.toggleBreakpointAtCursor(),
        },
        "tranquil-debug:clear-all-breakpoints": {
          displayName: "Debug: Clear All Breakpoints",
          didDispatch: () => this.clearAllBreakpoints(),
        },
      })
    );

    this.subscriptions.add(
      atom.workspace.addOpener((uri) =>
        uri === DebugPanelView.URI ? new DebugPanelView() : undefined
      )
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "tranquil-debug:toggle-panel": {
          displayName: "Debug: Toggle Debug Panel",
          didDispatch: () => this.togglePanel(),
        },
        "tranquil-debug:debug-automation": {
          displayName: "Debug: Debug Automation",
          didDispatch: () => this.debugActiveEditor(),
        },
        "tranquil-debug:continue": {
          displayName: "Debug: Continue",
          didDispatch: () => this.session && this.session.resume(),
        },
        "tranquil-debug:step-over": {
          displayName: "Debug: Step Over",
          didDispatch: () => this.session && this.session.stepOver(),
        },
        "tranquil-debug:step-into": {
          displayName: "Debug: Step Into",
          didDispatch: () => this.session && this.session.stepInto(),
        },
        "tranquil-debug:step-out": {
          displayName: "Debug: Step Out",
          didDispatch: () => this.session && this.session.stepOut(),
        },
        "tranquil-debug:stop": {
          displayName: "Debug: Stop",
          didDispatch: () => this.session && this.session.stop(),
        },
      })
    );
  },

  async showPanel() {
    const item = await atom.workspace.open(DebugPanelView.URI, { activatePane: false });
    const container = atom.workspace.paneContainerForItem &&
      atom.workspace.paneContainerForItem(item);
    if (container && typeof container.show === "function") container.show();
    return item;
  },

  togglePanel() {
    const existing = atom.workspace
      .getPaneItems()
      .find((it) => it instanceof DebugPanelView);
    const container = existing &&
      atom.workspace.paneContainerForItem &&
      atom.workspace.paneContainerForItem(existing);
    if (existing && container && typeof container.isVisible === "function" && container.isVisible()) {
      container.hide();
    } else {
      this.showPanel();
    }
  },

  attachGutter(editor) {
    if (this.editors.has(editor)) return;
    const view = new EditorBreakpoints(editor, this.store);
    this.editors.set(editor, view);
    this.subscriptions.add(editor.onDidDestroy(() => this.editors.delete(editor)));
  },

  clearAllBreakpoints() {
    const removed = this.store.clearAll();
    // Confirm, with the count: clearing every file's breakpoints from one button is worth an
    // acknowledgement, and "nothing to clear" is more useful than silence.
    if (removed) {
      atom.notifications.addInfo(
        `Cleared ${removed} breakpoint${removed === 1 ? "" : "s"}`
      );
    } else {
      atom.notifications.addInfo("No breakpoints to clear");
    }
  },

  toggleBreakpointAtCursor() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!isDebuggableEditor(editor)) return;
    const row = editor.getCursorBufferPosition().row;
    // Go through the gutter view when there is one, so F9 and the palette get the same
    // page-callback check as a click; only fall back to the store if no view is attached.
    const view = this.editors.get(editor);
    if (view) view.toggleAt(row);
    else this.store.toggle(editor.getPath(), row);
  },

  debugActiveEditor() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!isDebuggableEditor(editor)) {
      atom.notifications.addWarning("Not a .ts automation");
      return;
    }
    this.startDebug(editor.getPath());
  },

  startDebug(scriptPath) {
    if (!this.session) {
      atom.notifications.addWarning("The automation runner is not available", {
        detail: "tranquil-automations must be active to debug.",
      });
      return null;
    }
    // Reveal the pane as the session starts. Debugging without somewhere to see the stack and
    // variables is not much use, and the pane is otherwise only reachable from the palette.
    this.showPanel();
    return this.session.start(scriptPath);
  },

  // Everything that reacts to session state hangs off one subscription, so the pane, the toolbar
  // and the execution pointer can never disagree about what the session is doing.
  handleSessionChange() {
    const session = this.session;
    if (this.controls) this.controls.update();
    if (session.state === "stopped" && session.callFrames.length) {
      const top = session.callFrames[0];
      this.currentLine.show(top.filePath, top.row);
    } else {
      this.currentLine.clear();
    }
  },

  deactivate() {
    for (const view of this.editors.values()) view.destroy();
    this.editors.clear();
    if (this.currentLine) this.currentLine.clear();
    if (this.controls) this.controls.dispose();
    if (this.session) this.session.dispose();
    if (this.subscriptions) this.subscriptions.dispose();
    this.subscriptions = null;
  },

  consumePaneControls(paneControls) {
    this.paneControls = paneControls;
    this.wireControls();
  },

  consumeAutomationRunner(runner) {
    this.runner = runner;
    this.session = new DebugSession({ runner, store: this.store });
    DebugPanelView.setSession(this.session);
    this.subscriptions.add(this.session.onDidChange(() => this.handleSessionChange()));
    this.wireControls();
  },

  // Service consumption order is not guaranteed, so the controls are built once both halves have
  // arrived rather than assuming either comes first.
  wireControls() {
    if (this.controls || !this.paneControls || !this.session) return;
    this.controls = new DebugControls({
      paneControls: this.paneControls,
      session: this.session,
      store: this.store,
      startDebug: (filePath) => this.startDebug(filePath),
      clearAll: () => this.clearAllBreakpoints(),
    });
  },
};
