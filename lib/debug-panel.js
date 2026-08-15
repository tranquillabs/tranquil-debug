"use babel";

// The debug pane: call stack, variables, watch, and an expression console, in the left dock.
//
// This pane is intentionally NOT serialized, so it does not reopen on window reload — see
// serialize()'s absence below. The session is still bound late, via setSession(), because service
// consumption and pane creation can happen in either order.

const { CompositeDisposable, Emitter } = require("atom");
const path = require("path");
const { VariablesTree, describe, valueClass: valueClassFor } = require("./variables-tree.js");

// Enough to show a header plus a row or two; below this a section is just a label with a scrollbar.
const MIN_SECTION_HEIGHT = 56;
const DEFAULT_SECTION_HEIGHT = 150;

class DebugPanelView {
  constructor() {
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.selectedFrame = 0;
    // Watch expressions and the console transcript outlive the pane. Closing the panel mid-session
    // and reopening it builds a NEW view, so per-instance arrays would silently discard everything
    // the user had typed. Shared arrays, mutated in place, so any instance sees the same list.
    this.watches = DebugPanelView.watches;
    this.consoleLines = DebugPanelView.consoleLines;

    this.element = document.createElement("div");
    this.element.classList.add("tranquil-debug-panel");
    // Focusable (tabindex -1) so a mouse selection anywhere in the pane makes this the
    // activeElement; that is what lets the cmd-c/ctrl-c handler below run before Atom's keymap
    // turns the keystroke into `core:copy`, which has no handler outside atom-text-editor and
    // would otherwise swallow it silently. Same approach as the runs panel's output view.
    this.element.tabIndex = -1;
    this.element.addEventListener("keydown", (e) => this.handleCopyKey(e));

    this.statusEl = document.createElement("div");
    this.statusEl.classList.add("debug-status");

    this.stackEl = this.section("Call Stack", "stack");
    this.varsEl = this.section("Variables", "variables");
    this.watchEl = this.section("Watch", "watch");
    this.consoleEl = this.section("Console", "console");

    this.consoleInput = document.createElement("input");
    this.consoleInput.type = "text";
    this.consoleInput.classList.add("debug-console-input", "native-key-bindings");
    this.consoleInput.placeholder = "Evaluate in the paused frame…";
    this.consoleInput.addEventListener("keydown", (e) => this.handleConsoleKey(e));

    this.consoleOutput = document.createElement("div");
    this.consoleOutput.classList.add("debug-console-output");

    this.consoleEl.body.append(this.consoleOutput, this.consoleInput);

    // Watch: an add-expression input above a tree. Both are built once and kept — render()
    // must not recreate them, or the input would lose focus mid-typing and the tree would drop
    // its expansion state on every streamed update.
    this.watchInput = document.createElement("input");
    this.watchInput.type = "text";
    this.watchInput.classList.add("debug-watch-input", "native-key-bindings");
    this.watchInput.placeholder = "Add expression…";
    this.watchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const value = this.watchInput.value.trim();
      if (!value) return;
      this.watchInput.value = "";
      this.addWatch(value);
    });
    const watchAdd = document.createElement("div");
    watchAdd.classList.add("debug-watch-add");
    watchAdd.appendChild(this.watchInput);

    this.watchListEl = document.createElement("div");
    this.watchEl.body.append(watchAdd, this.watchListEl);

    this.element.append(
      this.statusEl,
      this.stackEl.root,
      this.divider(this.stackEl, this.varsEl),
      this.varsEl.root,
      this.divider(this.varsEl, this.watchEl),
      this.watchEl.root,
      this.divider(this.watchEl, this.consoleEl),
      this.consoleEl.root
    );
    this.applyHeights();

    this.tree = new VariablesTree(this.varsEl.body, null);
    this.watchTree = new VariablesTree(this.watchListEl, null);

    DebugPanelView.instances.add(this);
    this.bind();
    this.render();
    this.watchForStaleLayer();
  }

  // A scrollable panel in a side dock gets its own compositor layer, which goes stale on dock
  // resize or re-render — the "it comes back when you toggle DevTools" symptom. Forcing a repaint
  // on resize is the established fix in this codebase.
  watchForStaleLayer() {
    if (typeof ResizeObserver !== "function") return;
    this.resizeObserver = new ResizeObserver(() => {
      // The panel usually has zero height when constructed, so the proportional first-run sizing
      // cannot be computed yet; this is where it lands.
      if (!DebugPanelView.heightsInitialised) this.applyHeights();
      this.forceRepaint();
    });
    this.resizeObserver.observe(this.element);
  }

  // Copy the current selection on cmd-c / ctrl-c. Atom binds these to `core:copy` on `body`,
  // which has no handler outside atom-text-editor, so without this the keystroke is swallowed and
  // nothing reaches the clipboard.
  //
  // An empty selection falls through deliberately: when focus is in the watch or console input the
  // document selection is collapsed (inputs keep their own), so the native copy still works there.
  handleCopyKey(e) {
    const isCopy = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "KeyC";
    if (!isCopy) return;
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString() : "";
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    atom.clipboard.write(text);
  }

  forceRepaint() {
    this.element.style.transform = "translateZ(0)";
    requestAnimationFrame(() => {
      this.element.style.transform = "";
    });
  }

  section(title, key) {
    const root = document.createElement("section");
    root.classList.add("debug-section");
    root.dataset.section = key;
    const header = document.createElement("div");
    header.classList.add("debug-section-header");
    header.textContent = title;
    const body = document.createElement("div");
    body.classList.add("debug-section-body");
    // Collapsible, so a narrow dock can still show the section the user cares about.
    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      root.classList.toggle("collapsed");
      this.applyHeights();
      this.forceRepaint();
    });
    root.append(header, body);
    return { root, header, body, key };
  }

  // A drag handle between two sections. Same shape as the runs panel's column divider: a thin
  // transparent strip that draws nothing until hovered, with the move/up listeners on `document`
  // so a fast drag that leaves the 7px strip does not drop the gesture.
  //
  // The two neighbours trade space with each other and nothing else moves. Growing only the
  // section above would push every divider below it down the panel, so a drag meant to enlarge
  // Call Stack silently rearranged Watch and Console as well.
  divider(above, below) {
    const el = document.createElement("div");
    el.classList.add("debug-divider");
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startAbove = above.root.getBoundingClientRect().height;
      const startBelow = below.root.getBoundingClientRect().height;
      // The last section has no stored height — it absorbs the remainder — so it is measured for
      // clamping but never written back.
      const belowIsElastic = !(below.key in DebugPanelView.sectionHeights);

      const onMove = (ev) => {
        // Clamp the delta itself, so neither neighbour can be pushed under the minimum and the
        // pair always sums to the same total.
        let delta = ev.clientY - startY;
        delta = Math.max(delta, MIN_SECTION_HEIGHT - startAbove);
        delta = Math.min(delta, startBelow - MIN_SECTION_HEIGHT);

        DebugPanelView.sectionHeights[above.key] = startAbove + delta;
        if (!belowIsElastic) DebugPanelView.sectionHeights[below.key] = startBelow - delta;
        this.applyHeights();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("tranquil-debug-resizing");
        this.forceRepaint();
      };
      this.endResize = onUp; // so destroy() can drop an in-flight drag
      document.body.classList.add("tranquil-debug-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return el;
  }

  // First-run heights, as a share of the panel rather than fixed pixels: this pane lives in a dock
  // that might be 400px or 2000px tall, and one set of pixel defaults cannot suit both — the tall
  // case left Call Stack and Watch holding empty space while Variables, the section actually being
  // read, was the one overflowing. Proportions are weighted to that: Variables gets the most.
  //
  // Runs once, and never again after the user drags — their sizing is not something to recompute.
  initHeights() {
    if (DebugPanelView.heightsInitialised) return;
    const height = this.element.getBoundingClientRect().height;
    if (!height) return; // not laid out yet; the ResizeObserver will call back
    const share = (fraction) => Math.max(MIN_SECTION_HEIGHT, Math.round(height * fraction));
    DebugPanelView.sectionHeights = {
      stack: share(0.16),
      variables: share(0.44),
      watch: share(0.13),
      // console takes the remaining ~27%
    };
    DebugPanelView.heightsInitialised = true;
  }

  // Every section takes a fixed height except the last, which absorbs the remainder. Fixed heights
  // are what give the bodies a bounded box to scroll inside — with everything flexing, content
  // just grew the section and the scrollbar never appeared.
  applyHeights() {
    this.initHeights();
    const sections = [this.stackEl, this.varsEl, this.watchEl, this.consoleEl];
    sections.forEach((section, i) => {
      const isLast = i === sections.length - 1;
      if (section.root.classList.contains("collapsed")) {
        section.root.style.flex = "0 0 auto"; // header only
      } else if (isLast) {
        section.root.style.flex = "1 1 auto"; // soaks up whatever is left
      } else {
        const h = DebugPanelView.sectionHeights[section.key] || DEFAULT_SECTION_HEIGHT;
        // shrink-allowed (0 1), not rigid: in a short dock rigid sections would overflow the
        // panel and push the console out of view entirely. With room available the basis holds.
        section.root.style.flex = `0 1 ${h}px`;
      }
    });
  }

  bind() {
    const session = DebugPanelView.session;
    if (!session || this.boundSession === session) return;
    this.boundSession = session;
    this.tree.session = session;
    this.watchTree.session = session;
    this.disposables.add(session.onDidChange(() => this.onSessionChange()));
    // Prime from the CURRENT state, not just from the next change. Reopening the panel mid-session
    // builds a fresh view whose tree and watches have never been populated, so without this it sat
    // empty until the next step happened to fire a change event.
    this.onSessionChange();
  }

  onSessionChange() {
    const session = DebugPanelView.session;
    const state = session ? session.state : "inactive";
    // A fresh session invalidates the old transcript: those replies were evaluated in a process
    // that no longer exists. Watch expressions survive — they are standing questions.
    if (DebugPanelView.lastState === "inactive" && state !== "inactive") {
      DebugPanelView.consoleLines.length = 0;
    }
    DebugPanelView.lastState = state;

    // A new stop means new frames and new objectIds; anything cached is invalid.
    if (session && session.state === "stopped") {
      this.selectedFrame = 0;
      this.tree.setFrame(session.callFrames[0] || null);
      this.refreshWatches();
    } else {
      this.tree.clear();
    }
    this.render();
  }

  selectFrame(index) {
    const session = DebugPanelView.session;
    if (!session || !session.callFrames[index]) return;
    this.selectedFrame = index;
    this.tree.setFrame(session.callFrames[index]);
    const frame = session.callFrames[index];
    if (frame.filePath) {
      atom.workspace.open(frame.filePath, {
        searchAllPanes: true,
        initialLine: frame.row,
        initialColumn: 0,
        pending: false,
      });
    }
    this.refreshWatches();
    this.render();
  }

  async handleConsoleKey(e) {
    if (e.key !== "Enter") return;
    const expression = this.consoleInput.value.trim();
    if (!expression) return;
    this.consoleInput.value = "";
    this.consoleLines.push({ kind: "input", text: expression });
    this.render();
    const session = DebugPanelView.session;
    if (!session || session.state !== "stopped") {
      this.consoleLines.push({ kind: "error", text: "Not paused." });
      this.render();
      return;
    }
    try {
      const res = await session.evaluate(expression, this.selectedFrame);
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception;
        this.consoleLines.push({
          kind: "error",
          text: (ex && (ex.description || ex.value)) || res.exceptionDetails.text,
        });
      } else {
        this.consoleLines.push({ kind: "output", text: describe(res.result) });
      }
    } catch (err) {
      this.consoleLines.push({ kind: "error", text: String(err.message || err) });
    }
    this.render();
  }

  addWatch(expression) {
    this.watches.push({ expression, valueText: "…", objectId: null });
    this.refreshWatches();
  }

  removeWatch(expression) {
    const i = this.watches.findIndex((w) => w.expression === expression);
    if (i >= 0) this.watches.splice(i, 1);
    this.renderWatches();
  }

  // Keeps the CDP RemoteObject, not just its description: an objectId is what makes a watched
  // object expandable, so a watch on `inputs` drills down exactly like the same object does one
  // section up in Variables.
  async refreshWatches() {
    const session = DebugPanelView.session;
    for (const watch of this.watches) {
      if (!session || session.state !== "stopped") {
        watch.valueText = "—";
        watch.valueClass = "";
        watch.objectId = null;
        continue;
      }
      try {
        const res = await session.evaluate(watch.expression, this.selectedFrame);
        if (res.exceptionDetails) {
          const ex = res.exceptionDetails.exception;
          watch.valueText = (ex && (ex.description || ex.value)) || "(error)";
          watch.valueClass = "value-error";
          watch.objectId = null;
        } else {
          watch.valueText = describe(res.result);
          watch.valueClass = valueClassFor(res.result);
          watch.objectId = res.result && res.result.objectId;
        }
      } catch (e) {
        watch.valueText = "(error)";
        watch.valueClass = "value-error";
        watch.objectId = null;
      }
    }
    this.renderWatches();
  }

  renderWatches() {
    // Expansion state is keyed by expression, so re-evaluating on each step does not collapse a
    // tree the user opened. The cached CHILDREN are a different matter: each stop yields fresh
    // objectIds, so an expanded watch would otherwise keep showing values read from the previous
    // pause. Drop them when the identity changes, and the tree refetches while staying open.
    for (const watch of this.watches) {
      if (watch.lastObjectId !== watch.objectId) {
        this.watchTree.invalidate(`watch:${watch.expression}`);
        watch.lastObjectId = watch.objectId;
      }
    }
    this.watchTree.setRoots(
      this.watches.map((watch) => ({
        path: `watch:${watch.expression}`,
        name: watch.expression,
        valueText: watch.valueText,
        valueClass: watch.valueClass,
        objectId: watch.objectId,
        onRemove: () => this.removeWatch(watch.expression),
      })),
      { emptyText: "No watch expressions." }
    );
  }

  render() {
    const session = DebugPanelView.session;
    const state = session ? session.state : "inactive";

    this.statusEl.textContent = "";
    const dot = document.createElement("span");
    dot.classList.add("debug-state-dot", `state-${state}`);
    const label = document.createElement("span");
    label.classList.add("debug-state-label");
    const scriptName =
      session && session.scriptPath ? path.basename(session.scriptPath) : null;
    label.textContent =
      state === "inactive"
        ? "No debug session"
        : `${scriptName || "automation"} — ${state === "stopped" ? "paused" : state}`;
    this.statusEl.append(dot, label);

    // Call stack.
    this.stackEl.body.textContent = "";
    const frames = session && state === "stopped" ? session.callFrames : [];
    if (!frames.length) {
      const empty = document.createElement("div");
      empty.classList.add("debug-empty");
      empty.textContent = state === "running" ? "Running…" : "Not paused.";
      this.stackEl.body.appendChild(empty);
    }
    frames.forEach((frame, i) => {
      const row = document.createElement("div");
      row.classList.add("debug-row", "debug-frame");
      if (i === this.selectedFrame) row.classList.add("selected");
      const name = document.createElement("span");
      name.classList.add("debug-name");
      name.textContent = frame.functionName;
      const where = document.createElement("span");
      where.classList.add("debug-value");
      const file = frame.filePath ? path.basename(frame.filePath) : "(unknown)";
      // Frames whose source map we could not read report generated lines; mark them rather than
      // presenting a number that will not match the file.
      where.textContent = `${file}:${frame.row + 1}${frame.mapped ? "" : " (generated)"}`;
      row.append(name, where);
      // click, not mousedown — see variables-tree.js: preventDefault on mousedown would stop the
      // frame text from being selectable.
      row.addEventListener("click", (e) => {
        if (e.button !== 0) return;
        this.selectFrame(i);
      });
      this.stackEl.body.appendChild(row);
    });

    // Watch renders through its own tree (see renderWatches) and is deliberately NOT rebuilt
    // here: recreating the input would steal focus mid-typing, and recreating the tree would
    // collapse whatever the user had expanded on every streamed update.

    // Console transcript.
    this.consoleOutput.textContent = "";
    for (const line of this.consoleLines.slice(-200)) {
      const row = document.createElement("div");
      row.classList.add("debug-console-line", `kind-${line.kind}`);
      row.textContent = (line.kind === "input" ? "› " : "") + line.text;
      this.consoleOutput.appendChild(row);
    }
    this.consoleOutput.scrollTop = this.consoleOutput.scrollHeight;

    this.tree.render();
  }

  // --- Workspace item contract ---------------------------------------------

  getElement() {
    return this.element;
  }
  getTitle() {
    return "Debug";
  }
  getURI() {
    return DebugPanelView.URI;
  }
  getIconName() {
    return "bug";
  }
  getDefaultLocation() {
    return "left";
  }
  getAllowedLocations() {
    return ["left", "right", "bottom"];
  }
  getPreferredWidth() {
    return 300;
  }

  // Deliberately NOT serializable. A workspace item with a serialize() is restored on every window
  // reload, and this pane would always come back empty: a debug session cannot outlive a reload,
  // because the window going away kills the Deno child. Restoring it just means the dock pops open
  // uninvited every time you reload. The pane opens when a session starts, and from
  // `Debug: Toggle Debug Panel` — both moments when it actually has something to show.

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    DebugPanelView.instances.delete(this);
    if (this.endResize) this.endResize(); // drop any in-flight divider drag
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.disposables.dispose();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

DebugPanelView.URI = "tranquil-debug://panel";
// Shared across panel instances so closing and reopening the pane does not lose what the user
// typed. Watch expressions persist across sessions (they are the user's standing questions, and
// VS Code keeps them the same way); the console transcript is wiped when a NEW session starts,
// since replies evaluated against a dead run are misleading, not history.
DebugPanelView.watches = [];
DebugPanelView.consoleLines = [];
DebugPanelView.lastState = "inactive";
// Dragged section heights, shared like the watches above so they survive closing the pane. The
// last section is not listed: it always absorbs the remaining space.
DebugPanelView.sectionHeights = { stack: 150, variables: 220, watch: 130 };
DebugPanelView.heightsInitialised = false;
DebugPanelView.instances = new Set();
DebugPanelView.session = null;
DebugPanelView.setSession = function (session) {
  DebugPanelView.session = session;
  for (const view of DebugPanelView.instances) {
    view.bind();
    view.render();
  }
};

module.exports = DebugPanelView;
