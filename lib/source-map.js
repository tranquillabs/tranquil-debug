"use babel";

// Source Map v3 decoding — the piece that makes breakpoints land on the right line.
//
// V8 breakpoints are addressed in GENERATED coordinates; source-map resolution is a client-side
// job (DevTools does it, V8 does not). Deno's transpile is not the type-stripping-in-place kind:
// swc re-prints from the AST, so generated lines rarely match the TypeScript. Measured across the
// local emit cache, only 21.7% of 8155 mapping segments keep their line, with drift up to 127
// lines — a single deleted blank line is enough, and multi-line call arguments, object literals
// and fluent chains all re-flow. Sending the raw TS line would stop on the wrong statement
// roughly four times in five.
//
// Deno emits an inline `sourceMappingURL=data:application/json;base64,…` on every module (50/50
// in the local cache), delivered on Debugger.scriptParsed, so this needs no fetch and no disk read.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Base64-VLQ: 5 data bits per digit, bit 6 = continuation, LSB of the assembled value = sign.
function decodeVlq(segment) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    if (digit < 0) continue;
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>= 1;
      out.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

// Every field in `mappings` is delta-encoded against the previous segment, and generated column
// resets per line while the others carry across lines.
function parseMappings(mappings) {
  const out = [];
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  mappings.split(";").forEach((lineStr, genLine) => {
    let genCol = 0;
    if (!lineStr) return;
    for (const seg of lineStr.split(",")) {
      const d = decodeVlq(seg);
      if (!d.length) continue;
      genCol += d[0];
      if (d.length >= 4) {
        srcIdx += d[1];
        origLine += d[2];
        origCol += d[3];
        out.push({ genLine, genCol, srcIdx, origLine, origCol });
      }
    }
  });
  return out;
}

class SourceMap {
  constructor(raw) {
    this.sources = raw.sources || [];
    this.mappings = parseMappings(raw.mappings || "");
  }

  // Parse the inline data URI from Debugger.scriptParsed.sourceMapURL. Returns null for an
  // absent or non-inline map rather than throwing — a script without one is simply not mappable.
  static fromSourceMapURL(sourceMapURL) {
    if (!sourceMapURL) return null;
    const m = /^data:application\/json[^,]*;base64,(.*)$/.exec(sourceMapURL);
    if (!m) return null;
    try {
      return new SourceMap(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
    } catch (e) {
      return null;
    }
  }

  // TS line → generated location, using DevTools' heuristic: the lowest generated position whose
  // original line is at or after the requested one. That is what makes a breakpoint on a blank
  // line (or a comment, or a type-only declaration that emits nothing) slide forward to the next
  // statement that actually runs, instead of never binding.
  originalToGenerated(origLine0) {
    let best = null;
    for (const mp of this.mappings) {
      if (mp.origLine < origLine0) continue;
      if (
        !best ||
        mp.origLine < best.origLine ||
        (mp.origLine === best.origLine &&
          (mp.genLine < best.genLine || (mp.genLine === best.genLine && mp.genCol < best.genCol)))
      ) {
        best = mp;
      }
    }
    return best;
  }

  // Generated location → TS line, for Debugger.paused frames (which report generated
  // coordinates). Picks the nearest mapping at or before the column on that generated line.
  generatedToOriginal(genLine0, genCol0 = 0) {
    let best = null;
    let anyOnLine = null;
    for (const mp of this.mappings) {
      if (mp.genLine !== genLine0) continue;
      if (!anyOnLine) anyOnLine = mp;
      if (mp.genCol > genCol0) continue;
      if (!best || mp.genCol > best.genCol) best = mp;
    }
    return best || anyOnLine;
  }
}

module.exports = { SourceMap, decodeVlq, parseMappings };
