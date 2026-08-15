"use babel";

// One debug session: launch suspended, attach, arm breakpoints, drive stepping, tear down.
//
// The ordering here is the whole trick, and it was verified against a real Deno child before
// being written (see the ADR):
//
//   1. The runner spawns `deno run --inspect-brk=127.0.0.1:<port>`, so the child is suspended
//      before any user code runs.
//   2. We attach and enable the domains. The break-on-start pause lands in the *deepest static
//      dependency* of the bootstrap (ES module evaluation is bottom-up) — NOT in main.ts, and
//      certainly not in the user's script, which has not been fetched yet: the bootstrap imports
//      it dynamically.
//   3. At that pause we set an instrumentation breakpoint and resume. V8 then pauses again just
//      before executing each newly compiled script that carries a source map — a synchronous
//      window in which we can decode the map and bind breakpoints by scriptId.
//
// Why not pending `Debugger.setBreakpointByUrl`, which looks simpler: scriptParsed fires at
// compile time, but the isolate does not pump the inspector message loop between compile and
// top-level evaluation unless it is paused. For a short automation the breakpoint would arrive
// after the module had already run. The instrumentation pause is what DevTools itself uses, and
// it hands us the source map at exactly the moment we need it.
//
// Two teardown facts, both measured:
//   * The child does NOT exit while the inspector is attached, even after its own Deno.exit(0).
//     It exits the instant the socket closes. So EVERY session must close the socket on
//     completion, not just cancelled ones, or each debug run strands a suspended orphan.
//   * A cancel while paused must skip the graceful CANCEL frame (see run-manager).

const fs = require("fs");
const { Emitter } = require("atom");
const { pathToFileURL, fileURLToPath } = require("url");
const { CdpClient } = require("./cdp-client.js");
const { SourceMap } = require("./source-map.js");

const ATTACH_TIMEOUT_MS = 15000;

// Keep stepping inside the user's own code. Without this, one step-into from an automation lands
// in the runtime's mod.ts, capnweb, or a jsr dependency — files the user never opened.
const BLACKBOX_PATTERNS = [
  "^ext:",
  "^node:",
  "^https?://",
  "/node_modules/",
  // The runtime, EXCEPT main.ts. V8 ignores `debugger` statements inside blackboxed scripts, and
  // main.ts carries the completion sentinel this session depends on — blackboxing the whole
  // directory would silently disable it and the run would hang at "running" again.
  "/tranquil-automations/deno/(?!main\\.ts)",
];

// Deno reports script URLs from the module specifier, which is the *real* path. If the script
// lives under a symlink, comparing against pathToFileURL(scriptPath) as strings would silently
// never match and no breakpoint would ever bind.
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    return p;
  }
}

function urlToRealPath(url) {
  if (!url || !url.startsWith("file://")) return null;
  try {
    return realPath(fileURLToPath(url));
  } catch (e) {
    return null;
  }
}

class DebugSession {
  constructor({ runner, store }) {
    this.runner = runner;
    this.store = store;
    this.emitter = new Emitter();
    this.reset();
  }

  reset() {
    this.cdp = null;
    this.runId = null;
    this.scriptPath = null;
    this.scripts = new Map(); // scriptId → { url, filePath, sourceMap }
    this.armedOnce = false;
    this.stopped = false;
    this.callFrames = [];
    this.pauseReason = null;
    this.active = false;
    this.starting = false;
  }

  onDidChange(cb) {
    return this.emitter.on("did-change", cb);
  }

  changed() {
    this.emitter.emit("did-change", this);
  }

  // Derived, never stored — VS Code's approach, so the state can never drift from reality.
  get state() {
    if (!this.active) return this.starting ? "initializing" : "inactive";
    return this.stopped ? "stopped" : "running";
  }

  isDebugging(filePath) {
    return this.active && this.scriptPath === filePath;
  }

  async start(scriptPath) {
    if (this.active || this.starting) return null;
    this.starting = true;
    this.scriptPath = scriptPath;
    this.changed();

    // Every breakpoint in this file starts unverified: nothing has bound them yet, and saying so
    // is more honest than showing them solid until the debugger disagrees.
    for (const bp of this.store.forPath(scriptPath)) {
      this.store.setSessionData(bp, { verified: false });
    }

    try {
      this.runId = await this.runner.runDebug({ scriptPath });
      if (!this.runId) throw new Error("The run could not be started");
      // Read the port off the run record rather than the did-start-inspector event: that event is
      // emitted synchronously inside runDebug, before the runId it carries is known out here.
      const record = this.runner.find(this.runId);
      const inspectorPort = record && record.inspectorPort;
      if (inspectorPort == null) throw new Error("No inspector port for this run");

      this.cdp = await CdpClient.connect(inspectorPort, { timeout: ATTACH_TIMEOUT_MS });
      this.wire();
      await this.cdp.send("Debugger.enable");
      await this.cdp.send("Runtime.enable");
      await this.cdp.send("Debugger.setPauseOnExceptions", { state: "uncaught" });
      await this.cdp.send("Debugger.setBlackboxPatterns", { patterns: BLACKBOX_PATTERNS });
      await this.cdp.send("Runtime.runIfWaitingForDebugger");

      this.active = true;
      this.starting = false;
      this.changed();
      return this.runId;
    } catch (e) {
      // A failed attach must not leave a suspended child behind: with --inspect-brk and no
      // timeout, it would wait forever.
      this.starting = false;
      const failedRunId = this.runId;
      this.teardown();
      if (failedRunId) this.runner.cancel(failedRunId, { graceful: false });
      atom.notifications.addError("Could not start debugging", {
        detail: String(e.message || e),
      });
      return null;
    }
  }

  wire() {
    this.cdp.on("Debugger.scriptParsed", (p) => {
      this.scripts.set(p.scriptId, {
        url: p.url,
        filePath: urlToRealPath(p.url),
        sourceMap: SourceMap.fromSourceMapURL(p.sourceMapURL),
      });
    });
    this.cdp.on("Debugger.paused", (p) => this.handlePaused(p));
    this.cdp.on("Debugger.resumed", () => {
      this.stopped = false;
      this.callFrames = [];
      if (this.runId) this.runner.setPaused(this.runId, false);
      this.changed();
    });
    this.cdp.onClose(() => this.end());
  }

  async handlePaused(params) {
    // The first pause is break-on-start. Arm the instrumentation breakpoint and let it run: the
    // static graph is already compiled by now, so only the dynamically imported user module and
    // its own dependencies will trigger it.
    if (!this.armedOnce) {
      this.armedOnce = true;
      try {
        await this.cdp.send("Debugger.setInstrumentationBreakpoint", {
          instrumentation: "beforeScriptWithSourceMapExecution",
        });
      } catch (e) {
        /* older V8 without instrumentation support — breakpoints simply will not bind */
      }
      // Resume immediately and never wait for a human here: the run token minted by the runner
      // has a 60 s TTL and its auth handshake only runs once the child's JS does.
      await this.safeSend("Debugger.resume");
      return;
    }

    if (params.reason === "instrumentation") {
      const scriptId = params.data && params.data.scriptId;
      if (scriptId) await this.bindBreakpointsIn(scriptId);
      await this.safeSend("Debugger.resume");
      return;
    }

    // The bootstrap's completion sentinel (see deno/main.ts). The child cannot exit while we are
    // attached, so this pause is the only notice that the user's script has finished — detaching
    // here is what lets the process exit, the run record resolve, and the transport controls go
    // away. Never surfaced to the user as a stop: they did not put a breakpoint in the runner.
    const topFrame = (params.callFrames || [])[0];
    const topScript = topFrame && this.scripts.get(topFrame.location.scriptId);
    if (topScript && topScript.filePath && topScript.filePath.endsWith("/deno/main.ts")) {
      this.end();
      return;
    }

    this.stopped = true;
    this.pauseReason = params.reason;
    this.callFrames = (params.callFrames || []).map((frame) => {
      const script = this.scripts.get(frame.location.scriptId);
      const original = script && script.sourceMap
        ? script.sourceMap.generatedToOriginal(
            frame.location.lineNumber,
            frame.location.columnNumber || 0
          )
        : null;
      return {
        callFrameId: frame.callFrameId,
        functionName: frame.functionName || "(anonymous)",
        filePath: script ? script.filePath : null,
        url: script ? script.url : null,
        // Generated coordinates are useless to the user; report the TS line when we can map it.
        row: original ? original.origLine : frame.location.lineNumber,
        mapped: !!original,
        scopeChain: frame.scopeChain || [],
      };
    });
    if (this.runId) this.runner.setPaused(this.runId, true);
    this.changed();
  }

  // Bind every breakpoint for this script, in generated coordinates, and write the resolution
  // back so the gutter can move the dot to where it actually landed.
  async bindBreakpointsIn(scriptId) {
    const script = this.scripts.get(scriptId);
    if (!script || !script.filePath || !script.sourceMap) return;
    // Every breakpoint whose file this script is — not just the entry's. A breakpoint set in a
    // module the automation imports binds when that module is parsed.
    const breakpoints = this.store.breakpoints.filter(
      (bp) => bp.enabled && realPath(bp.path) === script.filePath
    );

    for (const bp of breakpoints) {
      const generated = script.sourceMap.originalToGenerated(bp.requestedRow);
      if (!generated) {
        this.store.setSessionData(bp, {
          verified: false,
          message: "No executable code on this line",
        });
        continue;
      }
      try {
        const result = await this.cdp.send("Debugger.setBreakpoint", {
          location: {
            scriptId,
            lineNumber: generated.genLine,
            columnNumber: generated.genCol,
          },
        });
        // V8 may snap the breakpoint to a nearby location; map back so the dot shows the truth.
        const actual = result && result.actualLocation;
        const back = actual
          ? script.sourceMap.generatedToOriginal(actual.lineNumber, actual.columnNumber || 0)
          : null;
        this.store.setSessionData(bp, {
          verified: true,
          row: back ? back.origLine : bp.requestedRow,
          breakpointId: result && result.breakpointId,
        });
      } catch (e) {
        this.store.setSessionData(bp, { verified: false, message: String(e.message || e) });
      }
    }
  }

  async safeSend(method, params) {
    try {
      return await this.cdp.send(method, params);
    } catch (e) {
      return null; // socket closed mid-step; end() will follow from onClose
    }
  }

  resume() {
    return this.safeSend("Debugger.resume");
  }
  stepOver() {
    return this.safeSend("Debugger.stepOver");
  }
  stepInto() {
    return this.safeSend("Debugger.stepInto");
  }
  stepOut() {
    return this.safeSend("Debugger.stepOut");
  }
  pause() {
    return this.safeSend("Debugger.pause");
  }

  // Evaluate in the selected frame's scope, so locals resolve the way the user expects.
  async evaluate(expression, frameIndex = 0) {
    const frame = this.callFrames[frameIndex];
    if (!frame) throw new Error("Not paused");
    const res = await this.cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression,
      objectGroup: "tranquil-debug",
      includeCommandLineAPI: true,
      silent: false,
      returnByValue: false,
      generatePreview: true,
    });
    return res;
  }

  getProperties(objectId) {
    return this.cdp.send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: true,
    });
  }

  // Stop the run. Non-graceful by necessity when paused, and harmless when not: the CANCEL frame
  // is handled on the JS event loop, which a paused V8 is not pumping.
  stop() {
    const runId = this.runId;
    const wasStopped = this.stopped;
    this.teardown();
    if (runId) this.runner.cancel(runId, { graceful: !wasStopped });
  }

  // The script ran to completion; just detach, which is what lets the child exit.
  end() {
    this.teardown();
  }


  teardown() {
    if (this.cdp) this.cdp.close();
    if (this.runId) this.runner.setPaused(this.runId, false);
    this.store.clearSessionData();
    this.reset();
    this.changed();
  }

  dispose() {
    this.teardown();
    this.emitter.dispose();
  }
}

module.exports = { DebugSession, BLACKBOX_PATTERNS };
