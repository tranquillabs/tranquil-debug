"use babel";

// Tab-bar controls, registered through tranquil-automations' pane-controls service.
//
// Two registrations rather than one. The Debug button shows on any .ts editor that is NOT under
// the debugger; the transport buttons show only on the file that is. pane-controls concatenates
// the items of every registry entry whose matcher passes and re-evaluates those matchers on each
// render, so the two swap places by themselves — the strip never shows both Run/Debug and a
// transport row, and both come back when the session ends. (Run hides the same way, via
// run-automation-control's own matcher; the runner knows which script is under debug.)
//
// Enablement WITHIN a live session — steps only while paused, Continue morphing to Pause — is a
// different problem: it needs a repaint without a registry change, which is what pane-controls'
// `refresh` is for. Icon and title may be functions, but they are only re-evaluated on a render.

const isDebuggable = (item) =>
  typeof item?.getPath === "function" && !!item.getPath() && item.getPath().endsWith(".ts");

class DebugControls {
  constructor({ paneControls, session, store, startDebug, clearAll }) {
    this.paneControls = paneControls;
    this.session = session;
    this.store = store;
    this.startDebug = startDebug;
    this.clearAll = clearAll;
    this.transportDisposable = null;

    this.mainDisposable = paneControls.register(
      (item) => isDebuggable(item) && !this.isUnderDebug(item),
      [
        {
          id: "debug-automation",
          icon: "debug-alt",
          title: "Debug Automation",
          action: (ctx) => this.handleDebug(ctx),
        },
      ]
    );

    // Clear-all lives in its own registration so it can appear only when there is something to
    // clear — a matcher is per-entry, not per-item. Unlike Run/Debug it stays available during a
    // session: clearing breakpoints mid-run is a normal thing to want.
    this.clearDisposable = paneControls.register(
      (item) => isDebuggable(item) && this.store.breakpoints.length > 0,
      [
        {
          id: "debug-clear-breakpoints",
          icon: "clear-all",
          title: "Clear All Breakpoints",
          action: () => this.clearAll(),
        },
      ]
    );

    // Toggling a breakpoint changes nothing pane-controls watches, so without this the button
    // would not appear until some other render happened to run.
    if (this.store && typeof this.store.onDidChange === "function") {
      this.storeSubscription = this.store.onDidChange(() => {
        if (this.paneControls.refresh) this.paneControls.refresh();
      });
    }
  }

  isUnderDebug(item) {
    const filePath = item && typeof item.getPath === "function" ? item.getPath() : null;
    return !!filePath && this.session.active && this.session.scriptPath === filePath;
  }

  handleDebug(ctx) {
    const item = ctx && ctx.item;
    const filePath = item && typeof item.getPath === "function" ? item.getPath() : null;
    if (!filePath) return;
    if (this.session.active) {
      atom.notifications.addWarning("A debug session is already running", {
        detail: "Stop it before starting another.",
      });
      return;
    }
    Promise.resolve(this.startDebug(filePath)).catch((e) =>
      atom.notifications.addError("Could not start debugging", { detail: String(e.message || e) })
    );
  }

  stopped() {
    return this.session.state === "stopped";
  }

  transportItems() {
    return [
      {
        // Continue and Pause share one slot and swap on state, as VS Code's toolbar does — the
        // button is always "the thing that changes whether the script is moving".
        id: "debug-continue",
        icon: () => (this.stopped() ? "debug-continue" : "debug-pause"),
        title: () => (this.stopped() ? "Continue (F5)" : "Pause"),
        action: () => (this.stopped() ? this.session.resume() : this.session.pause()),
      },
      ...[
        { id: "debug-step-over", icon: "debug-step-over", title: "Step Over (F10)", method: "stepOver" },
        { id: "debug-step-into", icon: "debug-step-into", title: "Step Into (F11)", method: "stepInto" },
        { id: "debug-step-out", icon: "debug-step-out", title: "Step Out (Shift-F11)", method: "stepOut" },
      ].map((def) => ({
        id: def.id,
        icon: def.icon,
        // Stepping while the script is running would be a no-op that looks broken; say so in the
        // tooltip rather than silently doing nothing.
        title: () => (this.stopped() ? def.title : `${def.title} — available when paused`),
        action: () => {
          if (this.stopped()) this.session[def.method]();
        },
      })),
      {
        id: "debug-stop",
        icon: "debug-stop",
        title: "Stop Debugging",
        action: () => this.session.stop(),
      },
    ];
  }

  // Called on every session state change.
  update() {
    const shouldShow = this.session.active;
    if (shouldShow && !this.transportDisposable) {
      const debuggedPath = this.session.scriptPath;
      this.transportDisposable = this.paneControls.register(
        (item) => isDebuggable(item) && item.getPath() === debuggedPath,
        this.transportItems()
      );
    } else if (!shouldShow && this.transportDisposable) {
      this.transportDisposable.dispose();
      this.transportDisposable = null;
    }
    if (this.paneControls.refresh) this.paneControls.refresh();
  }

  dispose() {
    if (this.storeSubscription) this.storeSubscription.dispose();
    if (this.transportDisposable) this.transportDisposable.dispose();
    if (this.clearDisposable) this.clearDisposable.dispose();
    if (this.mainDisposable) this.mainDisposable.dispose();
  }
}

module.exports = { DebugControls };
