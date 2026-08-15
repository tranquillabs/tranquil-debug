"use babel";

// The "you are here" decoration. Deliberately NOT a breakpoint state: VS Code keeps the execution
// pointer and the breakpoint dot as separate decorations so a stop on a line without a breakpoint
// still reads correctly, and a stop ON one composes — the arrow simply draws over the dot.
//
// Three decorations per stop, because one is not enough to find instantly: the line highlight, the
// line number, and an arrow in the breakpoint gutter.

const { GUTTER_NAME } = require("./breakpoints.js");

const LINE_CLASS = "tranquil-debug-current-line";
const ARROW_CLASS = "tranquil-debug-stack-arrow";

class CurrentLine {
  constructor() {
    this.marker = null;
  }

  // `row` is a TypeScript line, already mapped back from the generated coordinates the debugger
  // reports — see source-map.js for why those differ.
  async show(filePath, row) {
    this.clear();
    if (!filePath || typeof row !== "number") return;
    let editor;
    try {
      editor = await atom.workspace.open(filePath, {
        searchAllPanes: true,
        initialLine: row,
        initialColumn: 0,
        pending: false,
      });
    } catch (e) {
      return; // file moved or unreadable — the session is still valid, we just cannot point at it
    }
    if (!editor || typeof editor.markBufferPosition !== "function") return;

    this.marker = editor.markBufferPosition([row, 0], { invalidate: "never" });
    editor.decorateMarker(this.marker, { type: "line", class: LINE_CLASS });
    editor.decorateMarker(this.marker, { type: "line-number", class: LINE_CLASS });

    // The arrow rides in our own breakpoint column. Guard on the gutter existing: the column is
    // only added to .ts editors, and a stack frame can point at any file.
    const gutter =
      typeof editor.gutterWithName === "function" ? editor.gutterWithName(GUTTER_NAME) : null;
    if (gutter) gutter.decorateMarker(this.marker, { class: ARROW_CLASS });

    editor.scrollToBufferPosition([row, 0], { center: true });
  }

  clear() {
    if (this.marker) {
      this.marker.destroy(); // destroying the marker destroys all decorations on it
      this.marker = null;
    }
  }
}

module.exports = { CurrentLine };
