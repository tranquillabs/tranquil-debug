"use babel";

// The scopes/variables tree.
//
// Two behaviours are lifted from VS Code (workbench/contrib/debug), because both are the
// difference between a usable inspector and one that hangs:
//
//   * Lazy expansion — children are fetched on first expand and then memoised, never up front.
//     A paused frame can reference enormous object graphs; walking them eagerly would stall the
//     renderer on every step.
//   * Chunking — a collection larger than CHUNK_SIZE is presented as synthetic `[a..b]` range
//     nodes, and the chunk size is multiplied by itself until the count fits, so a million-element
//     array becomes 100 buckets of 10,000, each 100 buckets of 100. No level ever renders more
//     than ~100 rows, at any size.
//
// The chunk nodes fetch a real slice on demand via Runtime.callFunctionOn rather than filtering an
// already-fetched list — otherwise the expensive part (asking V8 for a million properties) would
// still happen.

const CHUNK_SIZE = 100;

// Runs inside the debuggee against the collection, returning a plain object of just that window.
const SLICE_FN = "function(start, end) { const out = {}; " +
  "for (let i = start; i <= end && i < this.length; i++) out[i] = this[i]; return out; }";

const fs = require("fs");
const { analyse } = require("./module-bindings.js");

function collectionLength(remoteObject) {
  if (!remoteObject) return null;
  if (remoteObject.subtype !== "array" && remoteObject.subtype !== "typedarray") return null;
  const m = /\((\d+)\)\s*$/.exec(remoteObject.description || "");
  return m ? Number(m[1]) : null;
}

// How many preview entries to show inline before giving up and saying "…".
const PREVIEW_LIMIT = 5;

// A compact inline preview, as DevTools renders one. This is what makes a promise legible: bare
// `description` for a promise is the word "Promise" and nothing else, whereas the preview carries
// `<state>` and `<value>`, so a settled promise reads as `Promise {<state>: "fulfilled",
// <value>: "hi"}` without expanding anything. Same for small objects and arrays.
function describePreview(remoteObject) {
  const preview = remoteObject.preview;
  if (!preview || !Array.isArray(preview.properties) || !preview.properties.length) return null;

  const shown = preview.properties.slice(0, PREVIEW_LIMIT);
  const parts = shown.map((p) => {
    const v = p.type === "string" ? JSON.stringify(p.value) : p.value;
    // Array entries carry index names that add nothing; promise/object entries do not.
    return preview.subtype === "array" ? String(v) : `${p.name}: ${v}`;
  });
  if (preview.overflow || preview.properties.length > shown.length) parts.push("…");

  const body = parts.join(", ");
  if (preview.subtype === "array") return `[${body}]`;
  const label =
    remoteObject.className && remoteObject.className !== "Object"
      ? `${remoteObject.className} `
      : "";
  return `${label}{${body}}`;
}

// Short, non-blocking rendering of a value. Objects show a preview when V8 gives one, otherwise
// their class/description; only primitives show a literal value, and strings are quoted so "1" is
// distinguishable from 1.
function describe(remoteObject) {
  if (!remoteObject) return "undefined";
  const { type, subtype, value, description, unserializableValue } = remoteObject;
  if (type === "string") return JSON.stringify(value !== undefined ? value : description);
  if (type === "undefined") return "undefined";
  if (subtype === "null") return "null";
  if (unserializableValue) return String(unserializableValue);
  if (value !== undefined && type !== "object") return String(value);
  return describePreview(remoteObject) || description || subtype || type;
}

function valueClassFn(remoteObject) {
  if (!remoteObject) return "";
  if (remoteObject.subtype === "null") return "value-null";
  const t = remoteObject.type;
  if (t === "number" || t === "boolean" || t === "string") return `value-${t}`;
  return "value-object";
}

class VariablesTree {
  constructor(container, session) {
    this.container = container;
    this.session = session;
    this.expanded = new Set(); // stable node paths, so expansion survives a re-render
    this.children = new Map(); // node path → fetched child descriptors
    this.frame = null;
  }

  // The tree renders a list of `roots`, so the same expansion, chunking and value formatting
  // serve both the Variables section (roots = the frame's scopes) and the Watch section (roots =
  // evaluated expressions). Without this, watch entries are dead strings while the identical
  // object one line up in Variables expands.
  //
  // Each root: { path, name, objectId?, valueText?, valueClass?, onRemove? }.
  setRoots(roots, { emptyText } = {}) {
    this.roots = roots || [];
    if (emptyText != null) this.emptyText = emptyText;
    this.render();
  }

  setFrame(frame) {
    this.frame = frame;
    // Cached CHILDREN die with the pause — every objectId in them belongs to the frame we are
    // leaving. Cached EXPANSION does not: "I want to see `global`" is a statement about scopes,
    // not about object identity. Clearing both meant stepping, or merely clicking a call-stack
    // row, collapsed everything the user had opened. ensureChildren refetches on render.
    this.children.clear();
    // What the module's own source says about its bindings — which are imports, and where each
    // is declared. Only the module scope is annotated: a local scope's names are not the ones
    // this map describes, and mislabelling a function's variable would be worse than plain rows.
    this.moduleInfo = this.analyseModule(frame);
    const scopes = (frame && frame.scopeChain) || [];
    this.setRoots(
      scopes
        .filter((scope) => scope.object && scope.object.objectId)
        .map((scope, i) => ({
          path: `scope:${i}`,
          name: scope.name || scope.type,
          objectId: scope.object.objectId,
          isModule: scope.type === "module",
          valueText: "",
        }))
    );
    // Open the nearest scope on the FIRST stop only. Doing it unconditionally would toggle it shut
    // for anyone who had deliberately closed it, since toggle() flips rather than opens.
    const first = this.roots[0];
    if (first && this.expanded.size === 0) {
      this.expanded.add(first.path);
      this.ensureChildren(
        first.path,
        this.loadProperties(first.objectId, { module: first.isModule })
      );
      this.render();
    }
  }

  // Source analysis for the paused frame's file, cached per path+mtime so stepping does not
  // re-read and re-scan the same file on every pause.
  analyseModule(frame) {
    if (!frame || !frame.filePath || !frame.row) return null;
    try {
      const { mtimeMs } = fs.statSync(frame.filePath);
      const key = `${frame.filePath}:${mtimeMs}`;
      if (!this.moduleCache || this.moduleCache.key !== key) {
        this.moduleCache = { key, info: analyse(fs.readFileSync(frame.filePath, "utf8")) };
      }
      return { ...this.moduleCache.info, currentLine: frame.row };
    } catch (e) {
      return null; // unsaved buffer, deleted file, anything — fall back to plain rows
    }
  }

  clear() {
    this.frame = null;
    this.expanded.clear();
    this.children.clear();
    this.setRoots([]);
  }

  // Drop cached children for a subtree while LEAVING it expanded. Watch expressions are
  // re-evaluated at every stop and get fresh objectIds, so their cached children are stale even
  // though the user's expansion choice is not — this refetches without collapsing the tree.
  invalidate(path) {
    for (const key of [...this.children.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.children.delete(key);
    }
  }

  // Fetch children for a node that is expanded but has nothing cached — which is exactly the
  // state `invalidate()` leaves behind after a step. Without this, render() draws an open twisty
  // over an empty body and the only way back is to collapse and re-expand.
  //
  // Setting "loading" synchronously matters: render() runs again while the request is in flight,
  // and the marker is what stops it firing a second fetch on every pass.
  ensureChildren(path, loader) {
    if (!loader || this.children.has(path)) return;
    this.children.set(path, "loading");
    Promise.resolve()
      .then(() => loader())
      .then((kids) => {
        this.children.set(path, kids);
        this.render();
      })
      .catch((e) => {
        this.children.set(path, [{ name: String(e.message || e), error: true }]);
        this.render();
      });
  }

  async toggle(path, loader) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.render();
      return;
    }
    this.expanded.add(path);
    if (!this.children.has(path)) {
      this.children.set(path, "loading");
      this.render();
      try {
        this.children.set(path, await loader());
      } catch (e) {
        this.children.set(path, [{ name: String(e.message || e), error: true }]);
      }
    }
    this.render();
  }

  loadProperties(objectId, { module: isModuleScope = false } = {}) {
    return async () => {
      const res = await this.session.getProperties(objectId);
      const props = (res.result || [])
        .filter((p) => p.enumerable !== false || p.name === "length")
        .map((p) => ({
          name: p.name,
          // A getter is not invoked automatically — evaluating it could have side effects. VS
          // Code renders these as click-to-evaluate; here they read as "(...)" until expanded.
          getter: !!p.get && !p.value,
          value: p.value,
        }));

      // V8's internal properties — [[PromiseState]], [[PromiseResult]], [[Entries]] for maps and
      // sets — are returned separately from ordinary properties and are easy to drop by accident.
      // They are the only way to see what a promise actually holds, so they lead rather than
      // trail: a promise with no own properties would otherwise expand to nothing at all.
      const internal = (res.internalProperties || [])
        .filter((p) => p.value)
        .map((p) => ({ name: p.name, value: p.value, internal: true }));

      return [...internal, ...(isModuleScope ? this.orderModuleScope(props) : props)];
    };
  }

  // Module scope, reordered and annotated so the script's own state leads.
  //
  // Declaration order puts every import first — an SDK plus a few helpers is eight rows of
  // machinery before the first variable the author wrote, which is what pushes the interesting
  // values below the fold. Imports are constant for the run and rarely what you are stopped to
  // look at, so they sink; among the rest, values that exist lead the ones that do not.
  //
  // `pending` marks a binding whose declaration is below the paused line. CDP reports those
  // identically to a variable genuinely holding `undefined`, so the line number is the only
  // evidence that "not yet" rather than "nothing" is the right reading.
  orderModuleScope(props) {
    const info = this.moduleInfo;
    if (!info) return props;
    const annotated = props.map((p) => {
      const declaredAt = info.declaredAt.get(p.name);
      const isUndefined = !p.value || p.value.type === "undefined";
      return {
        ...p,
        imported: info.imports.has(p.name),
        pending: isUndefined && declaredAt != null && declaredAt > info.currentLine,
      };
    });
    // Stable three-way partition; within each group declaration order is preserved.
    const rank = (p) => (p.imported ? 2 : p.pending ? 1 : 0);
    return annotated
      .map((p, i) => ({ p, i }))
      .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
      .map(({ p }) => p);
  }

  loadChunk(objectId, start, end) {
    return async () => {
      const res = await this.session.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: SLICE_FN,
        arguments: [{ value: start }, { value: end }],
        returnByValue: false,
      });
      const sliceId = res && res.result && res.result.objectId;
      if (!sliceId) return [];
      return this.loadProperties(sliceId)();
    };
  }

  render() {
    this.container.textContent = "";
    const roots = this.roots || [];
    if (!roots.length) {
      const empty = document.createElement("div");
      empty.classList.add("debug-empty");
      empty.textContent = this.emptyText || "Not paused.";
      this.container.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    list.classList.add("debug-tree");
    for (const root of roots) {
      list.appendChild(
        this.renderRow({
          path: root.path,
          depth: 0,
          name: root.name,
          valueText: root.valueText,
          valueClass: root.valueClass,
          expandable: !!root.objectId,
          loader: root.objectId
            ? this.loadProperties(root.objectId, { module: root.isModule })
            : null,
          onRemove: root.onRemove,
        })
      );
      if (this.expanded.has(root.path)) {
        // Re-arm after an invalidate: the root now carries a fresh objectId, so this refetches
        // against the current pause rather than showing values from the previous one.
        this.ensureChildren(
          root.path,
          root.objectId ? this.loadProperties(root.objectId, { module: root.isModule }) : null
        );
        this.renderChildren(list, root.path, 1);
      }
    }
    this.container.appendChild(list);
  }

  renderChildren(list, parentPath, depth) {
    const kids = this.children.get(parentPath);
    if (kids === "loading") {
      const row = document.createElement("div");
      row.classList.add("debug-row", "debug-loading");
      row.style.paddingLeft = `${depth * 12}px`;
      row.textContent = "…";
      list.appendChild(row);
      return;
    }
    if (!Array.isArray(kids)) return;

    for (const child of kids) {
      if (child.error) {
        const row = document.createElement("div");
        row.classList.add("debug-row", "debug-error");
        row.style.paddingLeft = `${depth * 12}px`;
        row.textContent = child.name;
        list.appendChild(row);
        continue;
      }
      const path = `${parentPath}/${child.name}`;
      const remote = child.value;
      const objectId = remote && remote.objectId;
      const length = collectionLength(remote);

      // Big collection: interpose range buckets instead of thousands of rows.
      if (objectId && length != null && length > CHUNK_SIZE) {
        list.appendChild(
          this.renderRow({
            path,
            depth,
            name: child.name,
            valueText: describe(remote),
            valueClass: valueClassFn(remote),
            expandable: true,
            loader: async () => this.makeBuckets(objectId, length),
          })
        );
        if (this.expanded.has(path)) {
          this.ensureChildren(path, async () => this.makeBuckets(objectId, length));
          this.renderChildren(list, path, depth + 1);
        }
        continue;
      }

      list.appendChild(
        this.renderRow({
          path,
          depth,
          name: child.name,
          // A range bucket is a label, not a value — describing its (absent) remote object would
          // print a bare "undefined" next to every `[0 … 99]`.
          valueText: child.bucket ? "" : child.getter ? "(…)" : describe(remote),
          valueClass: child.getter ? "value-object" : valueClassFn(remote),
          expandable: !!objectId,
          loader: objectId ? this.loadProperties(objectId) : null,
          bucket: child.bucket,
          internal: child.internal,
          pending: child.pending,
          imported: child.imported,
        })
      );
      if (this.expanded.has(path)) {
        this.ensureChildren(
          path,
          child.bucket
            ? this.loadChunk(child.bucket.objectId, child.bucket.start, child.bucket.end)
            : objectId
            ? this.loadProperties(objectId)
            : null
        );
        this.renderChildren(list, path, depth + 1);
      }
    }
  }

  // Grow the bucket span until the whole collection fits in <= CHUNK_SIZE buckets, so the tree
  // stays shallow-ish for any size instead of producing 10,000 buckets for a big array.
  makeBuckets(objectId, length) {
    let span = CHUNK_SIZE;
    while (length / span > CHUNK_SIZE) span *= CHUNK_SIZE;
    const buckets = [];
    for (let start = 0; start < length; start += span) {
      const end = Math.min(start + span - 1, length - 1);
      buckets.push({
        name: `[${start} … ${end}]`,
        bucket: { objectId, start, end },
        value: null,
      });
    }
    return buckets;
  }

  renderRow({
    path,
    depth,
    name,
    valueText,
    valueClass: vClass,
    expandable,
    loader,
    bucket,
    onRemove,
    internal,
    pending,
    imported,
  }) {
    const row = document.createElement("div");
    row.classList.add("debug-row");
    // V8 internals ([[PromiseState]] and friends) are real information but not the user's own
    // data; dimming them keeps their object's actual properties in the foreground.
    if (internal) row.classList.add("debug-internal");
    // Not yet reached: the declaration is below the paused line, so this `undefined` means
    // "hasn't run" rather than "holds nothing".
    if (pending) row.classList.add("debug-pending");
    if (imported) row.classList.add("debug-imported");
    row.style.paddingLeft = `${depth * 12}px`;

    const twisty = document.createElement("span");
    twisty.classList.add("debug-twisty");
    if (expandable || bucket) twisty.textContent = this.expanded.has(path) ? "▾" : "▸";
    row.appendChild(twisty);

    const nameEl = document.createElement("span");
    nameEl.classList.add("debug-name");
    nameEl.textContent = name;
    row.appendChild(nameEl);

    if (valueText) {
      const valueEl = document.createElement("span");
      valueEl.classList.add("debug-value");
      if (vClass) valueEl.classList.add(vClass);
      valueEl.textContent = valueText;
      row.appendChild(valueEl);
    }

    if (expandable || bucket) {
      row.classList.add("expandable");
      // `click`, not `mousedown`, and no preventDefault: mousedown+preventDefault stops a text
      // selection from ever starting, so nothing in the tree could be selected or copied. click
      // also fires only when press and release land on the same row, which means a drag selects
      // text rather than expanding whatever it started on.
      row.addEventListener("click", (e) => {
        if (e.button !== 0) return;
        const load = bucket
          ? this.loadChunk(bucket.objectId, bucket.start, bucket.end)
          : loader;
        if (load) this.toggle(path, load);
      });
    }

    // Watch roots carry a remove affordance; scopes and properties do not.
    if (onRemove) {
      const remove = document.createElement("span");
      remove.classList.add("debug-watch-remove");
      remove.textContent = "×";
      remove.title = "Remove watch expression";
      remove.addEventListener("click", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); // do not also toggle the row open
        onRemove();
      });
      row.appendChild(remove);
    }
    return row;
  }
}

module.exports = { VariablesTree, describe, valueClass: valueClassFn, CHUNK_SIZE };
