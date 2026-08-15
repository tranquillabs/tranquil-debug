"use babel";

// Is a given row inside a callback that runs in the BROWSER PAGE rather than in the automation?
//
// `tab.evaluate(fn)` and `tab.waitFor(fn)` serialize their callback and execute it in the page's
// V8 isolate. A breakpoint there binds perfectly well in the automation's isolate — the function
// literal is part of this module's compiled code — and then never fires, because nothing in this
// process ever calls it. It looks identical to a working breakpoint, which is the worst kind of
// wrong. Catching it at the moment someone sets it is the only place the answer is useful.
//
// This is a scanner, not a parser: it tracks bracket depth while skipping strings, template
// literals and comments, and asks whether any still-open paren belongs to one of those calls.

const PAGE_CALLS = ["evaluate", "waitFor"];

// Walk backwards over a balanced <...> group, so the generic form `evaluate<{ a: string }[]>(`
// still resolves to the method name in front of it.
function skipGenericsBackwards(text, index) {
  if (text[index] !== ">") return index;
  let depth = 0;
  let i = index;
  while (i >= 0) {
    if (text[i] === ">") depth += 1;
    else if (text[i] === "<") {
      depth -= 1;
      if (depth === 0) return i - 1;
    }
    i -= 1;
  }
  return index; // unbalanced — treat as not generic
}

// The method name immediately preceding an opening paren at `index`, or null.
function methodBefore(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  i = skipGenericsBackwards(text, i);
  while (i >= 0 && /\s/.test(text[i])) i -= 1;

  let end = i;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) i -= 1;
  const name = text.slice(i + 1, end + 1);
  return name || null;
}

// Returns the offending call name ("evaluate" / "waitFor") if `row` sits inside one of their
// callbacks, else null.
function pageCallbackAt(source, row) {
  const lines = String(source || "").split("\n");
  if (row < 0 || row >= lines.length) return null;
  // Offset of the row's first character.
  let target = 0;
  for (let r = 0; r < row; r += 1) target += lines[r].length + 1;

  const stack = [];
  let i = 0;
  while (i < target && i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "(") {
      const name = methodBefore(source, i);
      stack.push(PAGE_CALLS.includes(name) ? name : null);
    } else if (ch === ")") {
      stack.pop();
    }
    i += 1;
  }

  // Innermost first: a nested evaluate inside another call still counts.
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    if (stack[s]) return stack[s];
  }
  return null;
}

module.exports = { pageCallbackAt, PAGE_CALLS };
