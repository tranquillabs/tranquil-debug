"use babel";

// Reading a module's top-level bindings out of its source, so the Variables pane can say more
// about them than CDP can.
//
// Two things the debugger cannot learn from the protocol alone:
//
//   1. Which bindings are IMPORTS. `Runtime.getProperties` on a module scope returns imported
//      names alongside the script's own variables, indistinguishable. In a script that imports
//      an SDK plus a few JSR helpers that is eight or more rows of machinery above the first
//      variable the author actually wrote.
//
//   2. Which bindings have not been REACHED yet. A `const` whose declaration has not executed
//      reports as `{ type: "undefined" }` — byte-for-byte what a variable genuinely holding
//      `undefined` reports. The distinction is real to the reader ("not yet" vs "nothing") but
//      the only evidence for it is the declaration's position relative to the paused line.
//
// Both answers come from the source text, so this is a deliberately small regex pass rather than
// a parser: it runs on every pause, it only has to handle top-level declarations, and being wrong
// costs a row's styling rather than correctness of the debug session.

// Names bound by a top-level import — default, namespace and named forms, honouring `as`.
function importedNames(source) {
  const names = new Set();
  const re = /^\s*import\s+([^;'"]*?)\s+from\s+['"][^'"]+['"]/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const clause = m[1];
    // `* as ns`
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.add(ns[1]);
    // `{ a, b as c }`
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const bit = part.trim();
        if (!bit) continue;
        const alias = bit.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
        names.add(alias ? alias[1] : bit.split(/\s+/)[0]);
      }
    }
    // default: whatever sits before the first brace or star
    const dflt = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "");
    for (const bit of dflt.split(",")) {
      const name = bit.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// name → 1-based line of its top-level `const`/`let`/`var` declaration. Only single-name
// declarations: a destructuring pattern has no one line that "is" the binding, and guessing
// wrong there would grey out a variable that already holds a value.
function declarationLines(source) {
  const lines = new Map();
  source.split("\n").forEach((text, i) => {
    const m = text.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=;]/);
    if (m && !lines.has(m[1])) lines.set(m[1], i + 1);
  });
  return lines;
}

// Everything the Variables pane needs about one module's own source.
function analyse(source) {
  return { imports: importedNames(source), declaredAt: declarationLines(source) };
}

module.exports = { analyse, importedNames, declarationLines };
