"use babel";

// Breakpoints — the store, the persistence, and the gutter column.
//
// The model is VS Code's (workbench/contrib/debug/common/debugModel.ts), and it is the reason
// this package can be honest about Deno. Deno transpiles TypeScript by re-printing from the AST,
// so a breakpoint the user sets on TS line N almost never executes at generated line N — measured
// across the local emit cache, only 21.7% of mapping segments keep their line. So the debugger
// routinely binds a breakpoint somewhere other than where it was requested, and the UI has to say
// so rather than quietly lie.
//
// The split that makes that work: `requestedRow` is the user's intent and NOTHING but the user
// (or their edits) may change it; resolved data from a live session lives separately in
// `sessionData`. `row` — where the dot is drawn — is derived from the two. Consequences that
// fall out for free:
//
//   * No session yet          → verified, drawn where the user clicked. Dots look real before
//                               you ever press Debug; grey means "a debugger looked and said no".
//   * Session bound it        → drawn at the RESOLVED row; the dot visibly moves.
//   * Session couldn't bind   → stays exactly where the user clicked, greyed ("unbound").
//   * Re-arming a session     → always sends `requestedRow`, so resolution never compounds.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { CompositeDisposable, Emitter } = require("atom");
const { pageCallbackAt } = require("./page-scope.js");

const STORE_PATH = path.join(os.homedir(), ".tranquil", "debug", "breakpoints.json");
const GUTTER_NAME = "tranquil-breakpoints";

class Breakpoint {
  constructor({ path: filePath, row, enabled = true }) {
    this.path = filePath;
    this.requestedRow = row; // 0-based buffer row — user intent, never written by a session
    this.enabled = enabled;
    this.sessionData = null; // { verified, row, message } once a session has an opinion
  }

  // Absent session data a breakpoint counts as verified: it should look real the moment it is
  // set, long before any debugger exists to confirm it.
  get verified() {
    return this.sessionData ? !!this.sessionData.verified : true;
  }

  // Where the dot is actually drawn. Only a *verified* resolution may move it; an unverified one
  // leaves the marker where the user put it, which is what makes "unbound" legible.
  get row() {
    const d = this.sessionData;
    return this.verified && d && typeof d.row === "number" ? d.row : this.requestedRow;
  }

  get message() {
    if (this.sessionData && this.sessionData.message) return this.sessionData.message;
    if (!this.verified) return "Unbound breakpoint — this line has not been loaded or has no code";
    return null;
  }

  get state() {
    if (!this.enabled) return "disabled";
    return this.verified ? "verified" : "unverified";
  }

  toJSON() {
    return { path: this.path, row: this.requestedRow, enabled: this.enabled };
  }
}

class BreakpointStore {
  constructor() {
    this.emitter = new Emitter();
    this.breakpoints = [];
    this.load();
  }

  onDidChange(cb) {
    return this.emitter.on("did-change", cb);
  }

  didChange() {
    this.emitter.emit("did-change");
    this.save();
  }

  forPath(filePath) {
    return this.breakpoints.filter((b) => b.path === filePath);
  }

  find(filePath, row) {
    // Match on requestedRow: the user is pointing at a line they chose, not at a resolution.
    return this.breakpoints.find((b) => b.path === filePath && b.requestedRow === row) || null;
  }

  toggle(filePath, row) {
    const existing = this.find(filePath, row);
    if (existing) this.breakpoints.splice(this.breakpoints.indexOf(existing), 1);
    else this.breakpoints.push(new Breakpoint({ path: filePath, row }));
    this.didChange();
    return !existing;
  }

  // Remove every breakpoint, in every file. Returns how many went, so the caller can say so —
  // clearing silently leaves you wondering whether the button did anything.
  clearAll() {
    const removed = this.breakpoints.length;
    if (!removed) return 0;
    this.breakpoints = [];
    this.didChange();
    return removed;
  }

  setEnabled(filePath, row, enabled) {
    const bp = this.find(filePath, row);
    if (!bp || bp.enabled === enabled) return;
    bp.enabled = enabled;
    this.didChange();
  }

  // Called by the gutter when a buffer edit moves a marker: user intent follows the text.
  moveRequestedRow(bp, row) {
    if (bp.requestedRow === row) return;
    bp.requestedRow = row;
    this.didChange();
  }

  setSessionData(bp, data) {
    bp.sessionData = data;
    this.emitter.emit("did-change"); // session state is not persisted
  }

  clearSessionData() {
    let changed = false;
    for (const bp of this.breakpoints) {
      if (bp.sessionData) {
        bp.sessionData = null;
        changed = true;
      }
    }
    if (changed) this.emitter.emit("did-change");
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      this.breakpoints = (Array.isArray(raw) ? raw : [])
        // Drop anything without a usable row. A row that is not a non-negative integer reaches
        // markBufferPosition and throws "Invalid Point", which would break EVERY .ts editor on
        // open — and note that a NaN row serializes to `null`, so this survives a round-trip and
        // has to be rejected on the way back in, not only on the way out.
        .filter((r) => r && typeof r.path === "string" && Number.isInteger(r.row) && r.row >= 0)
        .map((r) => new Breakpoint(r));
    } catch (e) {
      this.breakpoints = []; // absent or corrupt store is not an error — start empty
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      fs.writeFileSync(STORE_PATH, JSON.stringify(this.breakpoints.map((b) => b.toJSON()), null, 2));
    } catch (e) {
      console.warn("[tranquil-debug] could not persist breakpoints:", e.message);
    }
  }
}

// The gutter column for one editor.
//
// This uses a `decorated` gutter (the default type), NOT `type: 'line-number'`. That was not the
// first choice: core wires onMouseDown/onMouseMove only for line-number gutters, which looked like
// a free ride. But a custom line-number gutter never reaches the DOM in this build — verified
// against a live editor by adding one, toggling hide/show, destroying and re-adding it, and
// forcing a component updateSync. It appears in `editor.getGutters()` and in the component's
// `guttersToRender`, yet no DOM node is ever produced. A decorated gutter renders immediately, and
// its marker decorations come out as absolutely-positioned `.decoration` divs with the correct top
// and height — exactly what a breakpoint dot needs.
//
// The cost is that mouse handling is ours: core attaches no listeners to a decorated gutter, so we
// listen on the gutter element and map clientY to a buffer row through the editor's own pixel
// geometry (which accounts for scrolling, folds, soft wrap and block decorations).
class EditorBreakpoints {
  constructor(editor, store) {
    this.editor = editor;
    this.store = store;
    this.disposables = new CompositeDisposable();
    this.markers = new Map(); // Breakpoint → Marker
    this.decorations = new Map(); // Breakpoint → Decoration
    this.hintMarker = null;
    this.hintRow = null;

    // addGutter THROWS if the name is already in use, and an uncaught throw here is not a quiet
    // failure: Pulsar's uncaught-error handler pops DevTools open. Reuse an existing gutter if one
    // somehow survived (a re-attach to the same editor, a torn-down view whose gutter outlived it).
    const existing =
      typeof editor.gutterWithName === "function" ? editor.gutterWithName(GUTTER_NAME) : null;
    this.ownsGutter = !existing;
    this.gutter =
      existing ||
      editor.addGutter({
        name: GUTTER_NAME,
        priority: -50, // lower priority sits closer to the window edge, left of the line numbers
        class: "tranquil-breakpoint-gutter",
      });

    const el = this.gutter.getElement();
    if (el) {
      this.onMouseDown = (e) => this.handleMouseDown(this.rowForEvent(e), e);
      this.onMouseMove = (e) => this.showHint(this.rowForEvent(e));
      this.onMouseLeave = () => this.showHint(null);
      el.addEventListener("mousedown", this.onMouseDown);
      el.addEventListener("mousemove", this.onMouseMove);
      el.addEventListener("mouseleave", this.onMouseLeave);
    }

    this.disposables.add(editor.onDidDestroy(() => this.destroy()));
    this.disposables.add(store.onDidChange(() => this.render()));
    this.render();
  }

  filePath() {
    return this.editor.getPath();
  }

  // Map a mouse event on the gutter to a buffer row. Going through the editor's own pixel geometry
  // rather than dividing by line height keeps folds, soft wrap and block decorations correct.
  // Returns null past the last line, so clicking empty space below the file does nothing instead
  // of quietly setting a breakpoint on the final line.
  rowForEvent(event) {
    const el = this.gutter.getElement();
    const view = atom.views.getView(this.editor);
    if (!el || !view || typeof view.screenPositionForPixelPosition !== "function") return null;

    // NO scrollTop term here. Core translates the gutter container by -scrollTop, so the gutter
    // element's own top already sits at (editor top − scrollTop): measured live, gutter.top −
    // editor.top was −497 with scrollTop 497.5. `clientY − gutterRect.top` is therefore already a
    // content-space offset, and adding scrollTop counted the scroll twice — clicking line 32 while
    // scrolled ~26 rows down set a breakpoint on line 58.
    const rect = el.getBoundingClientRect();
    const top = event.clientY - rect.top;

    const lineHeight = this.editor.getLineHeightInPixels();
    if (lineHeight && top > this.editor.getScreenLineCount() * lineHeight) return null;

    let screenPosition;
    try {
      screenPosition = view.screenPositionForPixelPosition({ top, left: 0 });
    } catch (e) {
      return null;
    }
    if (!screenPosition) return null;

    const bufferRow = this.editor.bufferRowForScreenRow(screenPosition.row);
    return Number.isInteger(bufferRow) && bufferRow >= 0 ? bufferRow : null;
  }

  // Click toggles. VS Code uses a single click on its glyph margin and has no double-click
  // gesture at all; a double click here arrives as two mousedowns, so the second would undo the
  // first. Swallow the second (detail > 1) so both gestures land on "set a breakpoint".
  handleMouseDown(bufferRow, domEvent) {
    const filePath = this.filePath();
    if (!filePath || !Number.isInteger(bufferRow)) return;
    if (domEvent && domEvent.button !== 0) return;
    if (domEvent && domEvent.detail > 1) return;
    if (domEvent) domEvent.preventDefault();

    if (domEvent && domEvent.shiftKey) {
      const bp = this.store.find(filePath, bufferRow);
      if (bp) this.store.setEnabled(filePath, bufferRow, !bp.enabled);
      return;
    }
    this.toggleAt(bufferRow);
  }

  // Toggle, refusing to ADD a breakpoint somewhere it could never fire. Removing one is always
  // allowed — the check runs only when there is nothing there yet.
  toggleAt(bufferRow) {
    const filePath = this.filePath();
    if (!filePath || !Number.isInteger(bufferRow)) return;

    if (!this.store.find(filePath, bufferRow)) {
      const call = pageCallbackAt(this.editor.getText(), bufferRow);
      if (call) {
        atom.notifications.addWarning(`Breakpoints do not work inside tab.${call}()`, {
          description: [
            `That callback is serialized and run in the **browser page**, not in the automation,`,
            "so the debugger attached to this script can never reach it.",
            "",
            "Use a `debugger;` statement inside the callback instead, and open the browser pane's",
            "DevTools (the `</>` button) before running.",
          ].join(" "),
          dismissable: true,
        });
        return;
      }
    }
    this.store.toggle(filePath, bufferRow);
  }

  // A faint "click to add a breakpoint" dot on the hovered row, VS Code's affordance.
  showHint(bufferRow) {
    const filePath = this.filePath();
    const suppress =
      !Number.isInteger(bufferRow) ||
      !filePath ||
      this.store.forPath(filePath).some((b) => b.row === bufferRow);

    if (suppress) {
      this.hintRow = null;
      if (this.hintMarker) {
        this.hintMarker.destroy();
        this.hintMarker = null;
      }
      return;
    }
    if (this.hintMarker && this.hintRow === bufferRow) return;
    if (this.hintMarker) this.hintMarker.destroy();
    this.hintRow = bufferRow;
    this.hintMarker = this.editor.markBufferPosition([bufferRow, 0], { invalidate: "never" });
    this.gutter.decorateMarker(this.hintMarker, { class: "tranquil-bp tranquil-bp-hint" });
  }

  render() {
    const filePath = this.filePath();
    if (!filePath) return;
    const wanted = this.store.forPath(filePath);

    for (const [bp, marker] of this.markers) {
      if (!wanted.includes(bp)) {
        marker.destroy();
        this.markers.delete(bp);
        this.decorations.delete(bp);
      }
    }

    for (const bp of wanted) {
      let marker = this.markers.get(bp);
      if (!marker) {
        // invalidate:'never' — a breakpoint should survive an edit that touches its line rather
        // than silently vanishing; the marker tracks the text and we write the row back.
        marker = this.editor.markBufferPosition([bp.row, 0], { invalidate: "never" });
        this.markers.set(bp, marker);
        this.decorations.set(
          bp,
          this.gutter.decorateMarker(marker, { class: `tranquil-bp state-${bp.state}` })
        );
        marker.onDidChange((e) => {
          if (e.textChanged) this.store.moveRequestedRow(bp, e.newHeadBufferPosition.row);
        });
      } else if (marker.getStartBufferPosition().row !== bp.row) {
        // A session resolved this breakpoint elsewhere — move the dot to where it really bound.
        marker.setBufferRange([[bp.row, 0], [bp.row, 0]]);
      }
      const decoration = this.decorations.get(bp);
      if (decoration) {
        // setProperties REPLACES the whole property object — it does not merge. Passing only
        // `class` drops the `type` and `gutterName` that gutter.decorateMarker set up, so the
        // decoration silently stops belonging to this gutter and renders nothing.
        decoration.setProperties({
          type: "gutter",
          gutterName: GUTTER_NAME,
          class: `tranquil-bp state-${bp.state}`,
        });
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const el = this.gutter && this.gutter.getElement();
    if (el) {
      if (this.onMouseDown) el.removeEventListener("mousedown", this.onMouseDown);
      if (this.onMouseMove) el.removeEventListener("mousemove", this.onMouseMove);
      if (this.onMouseLeave) el.removeEventListener("mouseleave", this.onMouseLeave);
    }
    if (this.hintMarker) this.hintMarker.destroy();
    for (const marker of this.markers.values()) marker.destroy();
    this.markers.clear();
    this.decorations.clear();
    this.disposables.dispose();
    try {
      // Only destroy a gutter this view created; destroying a borrowed one would strand the view
      // that owns it.
      if (this.gutter && this.ownsGutter) this.gutter.destroy();
    } catch (e) {
      /* editor already torn down */
    }
  }
}

module.exports = { Breakpoint, BreakpointStore, EditorBreakpoints, STORE_PATH, GUTTER_NAME };
