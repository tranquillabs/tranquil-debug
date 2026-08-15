"use babel";

// The renderer-side CDP client. Structurally the same as tranquil-automations' deno/cdp.ts (id
// correlation, event handlers, per-call timeout) — that file is Deno TypeScript and cannot be
// imported here, so this is the JS twin.
//
// Transport is the renderer's own global WebSocket, deliberately: `ws` is present in
// node_modules only as a hoisted transitive of tranquil-rpc and would vanish on any hoisting
// change. Nothing stands in the way of a plain ws:// to loopback — the app's CSP has no
// connect-src (default-src * atom://*, which covers ws:), loopback is exempt from mixed-content
// blocking, and Deno's inspector does no Origin/Host validation. Always the literal 127.0.0.1,
// never "localhost", which can resolve to ::1 and miss the listener.
//
// Discovery uses node's `http`, not `fetch`: Deno's inspector serves /json/list with no CORS
// headers, so a renderer fetch could not read the response. Node's module is not subject to CORS.
// (Scraping the "Debugger listening on ws://…" banner is not an option — `--quiet`, already in
// the runner's argv, suppresses it entirely.)

const http = require("http");

const DEFAULT_CALL_TIMEOUT_MS = 15000;

class CdpError extends Error {}

// Poll /json/list until the inspector answers. The server binds early but not instantaneously,
// and with --inspect-brk the child is suspended, so there is no race with script execution.
function discoverWebSocketUrl(port, { timeout = 10000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/json/list", timeout: 1000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const list = JSON.parse(body);
              const url = list && list[0] && list[0].webSocketDebuggerUrl;
              if (url) return resolve(url);
            } catch (e) {
              /* not ready */
            }
            retry();
          });
        }
      );
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new CdpError(`Inspector did not answer on 127.0.0.1:${port}`));
        return;
      }
      setTimeout(attempt, interval);
    };
    attempt();
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch (e) {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new CdpError(msg.error.message + (msg.error.data ? `: ${msg.error.data}` : "")));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) {
          try {
            h(msg.params);
          } catch (e) {
            console.error(`[tranquil-debug] handler for ${msg.method} threw:`, e);
          }
        }
      }
    };

    ws.onclose = () => {
      this.closed = true;
      const err = new CdpError("Debug socket closed");
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const h of this.handlers.get("__closed") || []) h();
    };
  }

  static async connect(port, options) {
    const url = await discoverWebSocketUrl(port, options);
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new CdpError(`Could not connect to ${url}`));
    });
    return new CdpClient(ws);
  }

  send(method, params = {}, { timeout = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new CdpError("Debug socket closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`Timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
    return () => {
      const list = this.handlers.get(method) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  onClose(handler) {
    return this.on("__closed", handler);
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* already gone */
    }
  }
}

module.exports = { CdpClient, CdpError, discoverWebSocketUrl };
