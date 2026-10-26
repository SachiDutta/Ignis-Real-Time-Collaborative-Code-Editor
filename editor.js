/* =========================================================
   IGNIS — Collaborative Code Editor
   ---------------------------------------------------------
   Pure JavaScript. This file builds the entire editor page
   (styles + markup + behaviour) and is opened by the
   "Start Session" button via  IgnisEditor.open().

   What it does
   - Code editor: line numbers, syntax highlighting, auto-indent,
     auto-close brackets/quotes, Tab / Shift+Tab, Ctrl+Enter to run
   - Multiple files (tabs), Python + JavaScript
   - Run code in a sandboxed Web Worker with stdin + live output
       JavaScript : runs natively
       Python     : runs in the browser via Pyodide (loaded on first run)
   - Live collaboration between tabs/windows of the same browser
     (BroadcastChannel): shared code, cursors, presence, output
   - Share link, download, autosave (localStorage)
   ========================================================= */

(function () {
    "use strict";

    /* ---------------------------------------------------------
       CONSTANTS
    --------------------------------------------------------- */

    var LH = 24;          // line height (px)
    var PAD_T = 16;       // top padding of code (px)
    var PAD_L = 14;       // left padding of code (px)
    var GUTTER_W = 56;    // line-number column width (px)
    var PEER_TTL = 7000;  // ms before a silent peer is dropped
    var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

    var PEER_COLORS = ["#c084fc", "#38bdf8", "#fb923c", "#f472b6", "#a3e635", "#facc15"];
    var MY_COLOR = "#00e5ff";

    var LANGS = {
        python: {
            label: "Python", ext: "py", indent: 4, badge: "PY", color: "#5aa9e6",
            sample:
                "# A little greeting, built together\n\n" +
                "def greet(name):\n" +
                "    return f\"Hello, {name}!\"\n\n" +
                "name = input().strip() or \"world\"\n" +
                "print(greet(name))\n" +
                "print(\"Welcome to IGNIS.\")\n"
        },
        javascript: {
            label: "JavaScript", ext: "js", indent: 2, badge: "JS", color: "#f7df1e",
            sample:
                "// A little greeting, built together\n" +
                "// input() reads a line from the INPUT box.\n\n" +
                "function greet(name) {\n" +
                "  return `Hello, ${name}!`;\n" +
                "}\n\n" +
                "const name = (input() || \"world\").trim();\n" +
                "console.log(greet(name));\n" +
                "console.log(\"Welcome to IGNIS.\");\n"
        }
    };

    var KEYWORDS = {
        python: set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
        javascript: set("async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield")
    };

    var BUILTINS = {
        python: set("print input len range int str float list dict set tuple bool type open sum min max abs sorted reversed enumerate zip map filter any all round isinstance super self cls format repr id hash iter next chr ord hex bin oct divmod pow"),
        javascript: set("console Math JSON Object Array String Number Boolean Promise Map Set Date RegExp Error Symbol parseInt parseFloat isNaN input prompt readline null undefined true false NaN Infinity setTimeout setInterval require module window document")
    };

    var TOKEN_RE = {
        python: /(?<c>#[^\n]*)|(?<s>[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(?<n>\b(?:0[xX][\da-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b)|(?<w>[A-Za-z_]\w*)/g,
        javascript: /(?<c>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<s>`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(?<n>\b(?:0[xX][\da-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b)|(?<w>[A-Za-z_$][\w$]*)/g
    };

    function set(str) {
        var o = Object.create(null);
        str.split(" ").forEach(function (w) { o[w] = true; });
        return o;
    }

    /* ---------------------------------------------------------
       SMALL HELPERS
    --------------------------------------------------------- */

    function esc(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function uid(n) {
        var s = "";
        var chars = "abcdefghjkmnpqrstuvwxyz23456789";
        for (var i = 0; i < (n || 6); i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
    }

    function hashStr(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

    function langFromName(name) {
        var m = /\.([a-z0-9]+)$/i.exec(name || "");
        var ext = m ? m[1].toLowerCase() : "";
        if (ext === "py") return "python";
        if (ext === "js" || ext === "mjs") return "javascript";
        return null;
    }

    function highlight(code, lang) {
        var re = TOKEN_RE[lang];
        var kw = KEYWORDS[lang], bi = BUILTINS[lang];
        if (!re) return esc(code) + "\n";
        var out = "", last = 0, m;
        re.lastIndex = 0;
        while ((m = re.exec(code))) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            if (m.index > last) out += esc(code.slice(last, m.index));
            var g = m.groups, cls = null, t = m[0];
            if (g.c !== undefined) cls = "c";
            else if (g.s !== undefined) cls = "s";
            else if (g.n !== undefined) cls = "n";
            else if (kw[t]) cls = "k";
            else if (bi[t]) cls = "b";
            else if (/(?:def|class|function)[ \t]+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) cls = "f";
            else if (code.charAt(re.lastIndex) === "(") cls = "f";
            else if (t.length > 1 && /^[A-Z][A-Za-z0-9]*$/.test(t)) cls = "y";
            out += cls ? '<span class="t-' + cls + '">' + esc(t) + "</span>" : esc(t);
            last = re.lastIndex;
        }
        out += esc(code.slice(last));
        return out + "\n";
    }

    /* ---------------------------------------------------------
       WORKER SOURCE  (code runs here, never on the page thread)
    --------------------------------------------------------- */

    var WORKER_SRC = [
        "var pyodide = null;",
        "var sent = 0, LIMIT = 5000;",
        "function post(type, text) {",
        "  if (type === 'stdout' || type === 'stderr') {",
        "    if (++sent > LIMIT) { throw new Error('Output limit reached (' + LIMIT + ' lines).'); }",
        "  }",
        "  self.postMessage({ type: type, text: text });",
        "}",
        "function fmt(a) {",
        "  if (typeof a === 'string') return a;",
        "  if (a instanceof Error) return a.stack || String(a);",
        "  try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a, null, 2) : String(a); }",
        "  catch (e) { return String(a); }",
        "}",
        "self.onmessage = async function (e) {",
        "  var d = e.data; sent = 0;",
        "  var lines = String(d.stdin || '').split('\\n');",
        "  if (lines.length && lines[lines.length - 1] === '') lines.pop();",
        "  var li = 0;",
        "  function nextLine() { return li < lines.length ? lines[li++] : null; }",
        "  try {",
        "    if (d.lang === 'python') {",
        "      if (!pyodide) {",
        "        post('status', 'Loading Python runtime…');",
        "        importScripts(" + JSON.stringify(PYODIDE_URL) + ");",
        "        pyodide = await loadPyodide();",
        "      }",
        "      pyodide.setStdout({ batched: function (s) { post('stdout', s + '\\n'); } });",
        "      pyodide.setStderr({ batched: function (s) { post('stderr', s + '\\n'); } });",
        "      pyodide.setStdin({ stdin: function () { var l = nextLine(); return l === null ? undefined : l; } });",
        "      post('start');",
        "      var g = pyodide.globals.get('dict')();",
        "      try { await pyodide.runPythonAsync(d.code, { globals: g }); } finally { g.destroy(); }",
        "    } else {",
        "      post('start');",
        "      var con = {};",
        "      ['log','info','debug'].forEach(function (k) { con[k] = function () { post('stdout', Array.prototype.map.call(arguments, fmt).join(' ') + '\\n'); }; });",
        "      ['warn','error'].forEach(function (k) { con[k] = function () { post('stderr', Array.prototype.map.call(arguments, fmt).join(' ') + '\\n'); }; });",
        "      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
        "      var fn = new AsyncFunction('console', 'input', 'prompt', 'readline', d.code);",
        "      await fn(con, nextLine, nextLine, nextLine);",
        "    }",
        "    self.postMessage({ type: 'done', code: 0 });",
        "  } catch (err) {",
        "    var msg = (err && (err.message || err.stack)) ? String(err.message || err.stack) : String(err);",
        "    if (d.lang !== 'python' && err && err.name) msg = err.name + ': ' + (err.message || '');",
        "    self.postMessage({ type: 'stderr', text: msg + '\\n' });",
        "    self.postMessage({ type: 'done', code: 1 });",
        "  }",
        "};"
    ].join("\n");

    var workerURL = null;
    function makeWorker() {
        if (!workerURL) {
            workerURL = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
        }
        return new Worker(workerURL);
    }

    /* ---------------------------------------------------------
       STYLES
    --------------------------------------------------------- */

    var CSS = [
        ".ig-root{position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;background:#050909;color:#e6eef0;font-family:'Inter',system-ui,sans-serif;font-size:14px;-webkit-font-smoothing:antialiased}",
        ".ig-root *{box-sizing:border-box}",
        ".ig-root button{font-family:inherit;cursor:pointer}",
        ".ig-root svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",

        /* top bar */
        ".ig-top{height:64px;flex:none;display:flex;align-items:center;gap:14px;padding:0 20px;border-bottom:1px solid rgba(255,255,255,.07);background:#070c0d}",
        ".ig-logo{background:none;border:0;color:#fff;font-family:'DM Mono',monospace;font-size:22px;font-weight:500;letter-spacing:3px;padding:0}",
        ".ig-logo span{color:#00e5ff}",
        ".ig-sep{width:1px;height:28px;background:rgba(255,255,255,.1)}",
        ".ig-title{background:transparent;border:1px solid transparent;border-radius:6px;color:#fff;font:600 16px 'Inter',sans-serif;padding:6px 8px;width:220px;max-width:30vw;outline:none;text-overflow:ellipsis}",
        ".ig-title:hover{border-color:rgba(255,255,255,.1)}",
        ".ig-title:focus{border-color:#00e5ff;background:#030606}",
        ".ig-conn{display:flex;align-items:center;gap:8px;font-size:13px;color:#00e5ff;white-space:nowrap}",
        ".ig-conn i{width:8px;height:8px;border-radius:50%;background:#00e5ff;box-shadow:0 0 10px #00e5ff}",
        ".ig-conn.off{color:#8a9496}.ig-conn.off i{background:#6b7679;box-shadow:none}",
        ".ig-spacer{flex:1}",
        ".ig-avatars{display:flex;align-items:center}",
        ".ig-av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:14px;border:2px solid;background:rgba(255,255,255,.04);margin-left:-6px}",
        ".ig-av:first-child{margin-left:0}",
        ".ig-btn{display:flex;align-items:center;gap:9px;height:40px;padding:0 16px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#e6eef0;font-size:14px;transition:.2s}",
        ".ig-btn:hover{border-color:#00e5ff;color:#00e5ff;background:rgba(0,229,255,.05)}",
        ".ig-run{display:flex;align-items:center;gap:9px;height:40px;padding:0 20px;border-radius:8px;border:0;background:#00dff5;color:#001014;font-weight:600;font-size:14px;transition:.2s}",
        ".ig-run:hover{box-shadow:0 8px 28px rgba(0,229,255,.25);transform:translateY(-1px)}",
        ".ig-run.stop{background:#ff6975;color:#1a0306}",
        ".ig-run svg{fill:currentColor;stroke:none;width:13px;height:13px}",

        /* body */
        ".ig-body{flex:1;min-height:0;display:flex}",
        ".ig-side{width:230px;flex:none;display:flex;flex-direction:column;padding:18px 12px 16px;border-right:1px solid rgba(255,255,255,.07);background:#070c0d;overflow-y:auto}",
        ".ig-sec{display:flex;align-items:center;justify-content:space-between;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:2.5px;color:#7d898b;margin:4px 8px 10px}",
        ".ig-sec button{background:none;border:0;color:#7d898b;width:24px;height:24px;border-radius:5px;display:grid;place-items:center}",
        ".ig-sec button:hover{color:#00e5ff;background:rgba(0,229,255,.08)}",
        ".ig-files{margin-bottom:22px}",
        ".ig-file{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:7px;cursor:pointer;border-left:3px solid transparent;color:#c7d0d2;font-size:14px}",
        ".ig-file:hover{background:rgba(255,255,255,.04)}",
        ".ig-file.on{background:rgba(0,229,255,.09);border-left-color:#00e5ff;color:#fff}",
        ".ig-file .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".ig-file .x{opacity:0;background:none;border:0;color:#8a9496;font-size:16px;line-height:1;padding:0 2px}",
        ".ig-file:hover .x{opacity:1}.ig-file .x:hover{color:#ff6975}",
        ".ig-badge{font-family:'DM Mono',monospace;font-size:9px;font-weight:500;padding:2px 4px;border-radius:3px;color:#001014;flex:none}",
        ".ig-user{display:flex;align-items:center;gap:12px;padding:9px 10px}",
        ".ig-user.me{cursor:pointer}",
        ".ig-dot{width:12px;height:12px;border-radius:50%;flex:none}",
        ".ig-user b{display:block;font-weight:500;font-size:14px;color:#e6eef0}",
        ".ig-user small{display:block;font-size:12px;color:#7d898b;margin-top:2px}",
        ".ig-leave{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;height:42px;border-radius:7px;border:1px solid #ff6975;background:transparent;color:#ff6975;font-size:14px;margin-top:14px}",
        ".ig-leave:hover{background:rgba(255,105,117,.1)}",
        ".ig-rename{width:100%;background:#030606;border:1px solid #00e5ff;border-radius:4px;color:#fff;font:inherit;padding:2px 6px;outline:none}",

        /* main */
        ".ig-main{flex:1;min-width:0;display:flex;flex-direction:column}",
        ".ig-tabbar{height:46px;flex:none;display:flex;align-items:stretch;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.07);background:#070c0d}",
        ".ig-tabs{display:flex;min-width:0;overflow-x:auto;scrollbar-width:none}",
        ".ig-tab{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:2px solid transparent;color:#9aa5a7;cursor:pointer;white-space:nowrap;font-size:14px}",
        ".ig-tab:hover{color:#fff;background:rgba(255,255,255,.03)}",
        ".ig-tab.on{color:#fff;border-bottom-color:#00e5ff;background:rgba(0,229,255,.05)}",
        ".ig-tab .x{background:none;border:0;color:#7d898b;font-size:17px;line-height:1;padding:0 2px}",
        ".ig-tab .x:hover{color:#ff6975}",
        ".ig-tab.plus{padding:0 14px;color:#7d898b}.ig-tab.plus:hover{color:#00e5ff}",
        ".ig-langwrap{display:flex;align-items:center;padding-right:16px}",
        ".ig-lang{height:32px;padding:0 12px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:#0a1213;color:#e6eef0;font:inherit;font-size:14px;outline:none;cursor:pointer}",
        ".ig-lang:focus{border-color:#00e5ff}",

        /* code area */
        ".ig-scroll{flex:1;min-height:0;overflow:auto;position:relative;background:#060b0c}",
        ".ig-inner{display:flex;min-height:100%;width:max-content;min-width:100%}",
        ".ig-gutter{position:sticky;left:0;z-index:3;flex:0 0 " + GUTTER_W + "px;background:#060b0c;border-right:1px solid rgba(255,255,255,.06);padding:" + PAD_T + "px 14px 160px 0;text-align:right;font:14px/" + LH + "px 'DM Mono',monospace;color:#4a5a5d;white-space:pre;user-select:none;overflow:hidden}",
        ".ig-gutter .ghl{position:absolute;left:0;right:0;height:" + LH + "px;background:rgba(255,255,255,.035);z-index:-1}",
        ".ig-gutter .gtxt{position:relative}",
        ".ig-layer{position:relative;flex:1 0 auto}",
        ".ig-code,.ig-hl{margin:0;border:0;padding:" + PAD_T + "px 60px 160px " + PAD_L + "px;font:14px/" + LH + "px 'DM Mono',monospace;font-variant-ligatures:none;white-space:pre;tab-size:4;-moz-tab-size:4;letter-spacing:0;word-spacing:0}",
        ".ig-hl{position:relative;z-index:1;pointer-events:none;color:#d7e2e4;min-width:100%}",
        ".ig-code{position:absolute;inset:0;width:100%;height:100%;z-index:2;resize:none;overflow:hidden;background:transparent;color:transparent;caret-color:#00e5ff;outline:none}",
        ".ig-code::selection{background:rgba(0,229,255,.28);color:transparent}",
        ".ig-linehl{position:absolute;left:0;right:0;height:" + LH + "px;background:rgba(255,255,255,.035);z-index:0;pointer-events:none}",
        ".ig-peers{position:absolute;inset:0;z-index:1;pointer-events:none}",
        ".ig-peer{position:absolute;width:2px;height:20px;transition:left .08s,top .08s}",
        ".ig-peer span{position:absolute;left:0;bottom:100%;transform:translateY(-1px);padding:2px 8px;border-radius:4px 4px 4px 0;font:600 12px 'Inter',sans-serif;color:#05080a;white-space:nowrap}",
        ".t-k{color:#c792ff}.t-s{color:#b4e07a}.t-n{color:#ffb86c}.t-c{color:#5d7074;font-style:italic}",
        ".t-f{color:#82d9ff}.t-b{color:#00e5ff}.t-y{color:#ffd479}",

        /* io panels */
        ".ig-panels{flex:none;height:min(34vh,300px);min-height:190px;display:flex;gap:14px;padding:14px;border-top:1px solid rgba(255,255,255,.07);background:#070c0d}",
        ".ig-panel{display:flex;flex-direction:column;min-width:0;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:#0a1112;overflow:hidden}",
        ".ig-panel.in{flex:0 0 36%}.ig-panel.out{flex:1}",
        ".ig-ph{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07);font-family:'DM Mono',monospace;font-size:12px;letter-spacing:2px;color:#e6eef0}",
        ".ig-ph em{margin-left:auto;font:12px 'Inter',sans-serif;letter-spacing:0;color:#7d898b;font-style:normal;white-space:nowrap}",
        ".ig-hint{padding:10px 16px 0;font-size:12px;color:#7d898b}",
        ".ig-stdin{flex:1;margin:10px 16px 16px;resize:none;background:#050909;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#e6eef0;font:14px/1.5 'DM Mono',monospace;padding:10px 12px;outline:none}",
        ".ig-stdin:focus{border-color:#00e5ff}",
        ".ig-pill{display:inline-flex;align-items:center;gap:7px;padding:3px 11px;border-radius:6px;border:1px solid;font:12px 'Inter',sans-serif;letter-spacing:0}",
        ".ig-pill.idle{color:#8a9496;border-color:rgba(255,255,255,.15)}",
        ".ig-pill.run{color:#ffd479;border-color:rgba(255,212,121,.5)}",
        ".ig-pill.ok{color:#00e5a0;border-color:rgba(0,229,160,.55)}",
        ".ig-pill.bad{color:#ff6975;border-color:rgba(255,105,117,.55)}",
        ".ig-outbody{flex:1;margin:0;padding:14px 18px;overflow:auto;font:14px/1.6 'DM Mono',monospace;white-space:pre-wrap;word-break:break-word;color:#e6eef0}",
        ".ig-outbody .err{color:#ff8a94}.ig-outbody .dim{color:#6b7a7d}",
        ".ig-of{display:flex;justify-content:space-between;padding:9px 18px;border-top:1px solid rgba(255,255,255,.07);font:12px 'DM Mono',monospace;color:#7d898b}",

        /* status bar */
        ".ig-status{height:36px;flex:none;display:flex;align-items:center;gap:0;padding:0 20px;border-top:1px solid rgba(255,255,255,.07);background:#070c0d;font-size:13px;color:#9aa5a7}",
        ".ig-status span{padding:0 14px;border-left:1px solid rgba(255,255,255,.1);white-space:nowrap}",
        ".ig-status span:first-child{padding-left:0;border-left:0}",
        ".ig-status .r{margin-left:auto}",
        ".ig-toast{position:absolute;left:50%;bottom:56px;transform:translate(-50%,20px);opacity:0;pointer-events:none;background:#0e1819;border:1px solid #00e5ff;color:#e6eef0;padding:10px 18px;border-radius:8px;font-size:13px;transition:.25s;z-index:20}",
        ".ig-toast.on{opacity:1;transform:translate(-50%,0)}",

        /* responsive */
        "@media (max-width:860px){",
        "  .ig-side{display:none}",
        "  .ig-top{padding:0 12px;gap:10px;height:58px}",
        "  .ig-sep,.ig-conn,.ig-avatars,.ig-btn span{display:none}",
        "  .ig-btn{padding:0 11px}",
        "  .ig-title{width:auto;flex:1;min-width:0;max-width:none}",
        "  .ig-logo{font-size:18px;letter-spacing:2px}",
        "  .ig-run{padding:0 14px}",
        "  .ig-spacer{display:none}",
        "  .ig-panels{flex-direction:column;height:46vh;padding:10px;gap:10px}",
        "  .ig-panel.in{flex:0 0 40%}",
        "  .ig-status .hide-s{display:none}",
        "}"
    ].join("\n");

    var ICON = {
        link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg>',
        down: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 20h16"/></svg>',
        play: '<svg viewBox="0 0 24 24"><path d="M6 3.5v17l14-8.5z"/></svg>',
        stop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
        exit: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
        info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
        check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
        users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/></svg>',
        lock: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
    };

    /* =========================================================
       EDITOR SESSION
    ========================================================= */

    var active = null; // the currently open session (only one at a time)

    function open() {
        if (active) return;
        active = new Session();
    }

    function close() {
        if (active) active.destroy(true);
    }

    function Session() {
        var self = this;

        /* ---------- identity & room ---------- */
        var m = /[#&]room=([a-z0-9]+)/i.exec(location.hash);
        this.room = m ? m[1].toLowerCase() : uid(6);
        var acct = null;
        try { acct = JSON.parse(lsGet("ignis:user") || "null"); } catch (e) { acct = null; }
        this.me = {
            id: uid(10),
            name: (acct && acct.name ? String(acct.name).slice(0, 20) : "") ||
                lsGet("ignis:name") || "Guest-" + Math.floor(1000 + Math.random() * 9000),
            color: MY_COLOR
        };
        this.peers = {};          // id -> {name,color,fileId,pos,seen}
        this.workers = {};        // lang -> persistent worker (python)
        this.timers = [];
        this.awaitingState = !!m; // joined an existing room -> ask peers for state
        this.running = false;
        this.cw = 8.4;            // measured char width
        this.renamingId = null;

        /* ---------- state ---------- */
        var saved = null;
        try { saved = JSON.parse(lsGet("ignis:room:" + this.room) || "null"); } catch (e) { saved = null; }

        if (saved && saved.files && saved.files.length) {
            this.title = saved.title || "Untitled session";
            this.files = saved.files;
            this.activeId = saved.activeId || saved.files[0].id;
            this.stdin = saved.stdin || "";
        } else {
            this.title = "Weekend playground";
            this.files = [{ id: uid(5), name: "main.py", lang: "python", content: LANGS.python.sample }];
            this.activeId = this.files[0].id;
            this.stdin = "";
        }
        this.output = { by: "", lang: "", status: "idle", parts: [], code: null, ms: null };

        /* ---------- DOM ---------- */
        history.replaceState(null, "", "#room=" + this.room);
        this.injectStyle();
        this.build();
        document.body.style.overflow = "hidden";

        /* ---------- live channel ---------- */
        this.channel = null;
        try {
            if ("BroadcastChannel" in window) {
                this.channel = new BroadcastChannel("ignis-room-" + this.room);
                this.channel.onmessage = function (ev) { self.onMessage(ev.data); };
            }
        } catch (e) { this.channel = null; }
        this.q(".ig-conn").classList.toggle("off", !this.channel);
        this.q(".ig-conn b").textContent = this.channel ? "Live" : "Solo";

        this.send({ t: "hello", name: this.me.name, color: this.me.color, fileId: this.activeId, pos: 0 });
        if (this.awaitingState) {
            this.timers.push(setTimeout(function () { self.awaitingState = false; }, 1500));
        }
        this.timers.push(setInterval(function () { self.heartbeat(); }, 2500));
        this.timers.push(setInterval(function () { self.prune(); }, 2000));

        this.onKey = function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); self.run(); }
        };
        document.addEventListener("keydown", this.onKey);
        this.onUnload = function () { self.send({ t: "bye" }); };
        window.addEventListener("pagehide", this.onUnload);

        this.renderAll();
        this.measure();
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { if (active === self) { self.measure(); self.renderCursors(); } });
        }
        this.ta.focus();
    }

    var P = Session.prototype;

    P.q = function (sel) { return this.root.querySelector(sel); };

    P.injectStyle = function () {
        if (document.getElementById("ignis-editor-style")) return;
        var s = document.createElement("style");
        s.id = "ignis-editor-style";
        s.textContent = CSS;
        document.head.appendChild(s);
    };

    /* ---------------------------------------------------------
       BUILD UI
    --------------------------------------------------------- */

    P.build = function () {
        var self = this;
        var root = document.createElement("div");
        root.className = "ig-root";
        root.innerHTML =
            '<header class="ig-top">' +
            '  <button class="ig-logo" data-act="leave" title="Back to home">IGN<span>IS</span></button>' +
            '  <div class="ig-sep"></div>' +
            '  <input class="ig-title" spellcheck="false" maxlength="60" aria-label="Session name">' +
            '  <div class="ig-conn"><i></i><b>Live</b></div>' +
            '  <div class="ig-spacer"></div>' +
            '  <div class="ig-avatars"></div>' +
            '  <button class="ig-btn" data-act="share" title="Copy invite link">' + ICON.link + '<span>Share link</span></button>' +
            '  <button class="ig-btn" data-act="download" title="Download current file">' + ICON.down + '<span>Download</span></button>' +
            '  <button class="ig-run" data-act="run" title="Run (Ctrl+Enter)">' + ICON.play + '<b>Run Code</b></button>' +
            '</header>' +
            '<div class="ig-body">' +
            '  <aside class="ig-side">' +
            '    <div class="ig-sec"><span>WORKSPACE</span> <button data-act="newfile" title="New file">' + ICON.plus + '</button></div>' +
            '    <div class="ig-files"></div>' +
            '    <div class="ig-sec"><span>ONLINE (<span class="ig-count">1</span>)</span></div>' +
            '    <div class="ig-users"></div>' +
            '    <div class="ig-spacer"></div>' +
            '    <button class="ig-leave" data-act="leave">' + ICON.exit + 'Leave room</button>' +
            '  </aside>' +
            '  <section class="ig-main">' +
            '    <div class="ig-tabbar"><div class="ig-tabs"></div>' +
            '      <div class="ig-langwrap"><select class="ig-lang" aria-label="Language">' +
            Object.keys(LANGS).map(function (k) { return '<option value="' + k + '">' + LANGS[k].label + "</option>"; }).join("") +
            '</select></div></div>' +
            '    <div class="ig-scroll"><div class="ig-inner">' +
            '      <div class="ig-gutter"><div class="ghl"></div><div class="gtxt"></div></div>' +
            '      <div class="ig-layer">' +
            '        <div class="ig-linehl"></div>' +
            '        <pre class="ig-hl" aria-hidden="true"></pre>' +
            '        <div class="ig-peers"></div>' +
            '        <textarea class="ig-code" wrap="off" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" aria-label="Code editor"></textarea>' +
            '        <span class="ig-measure" style="position:absolute;visibility:hidden;white-space:pre;font:14px/' + LH + 'px \'DM Mono\',monospace">MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM</span>' +
            '      </div>' +
            '    </div></div>' +
            '    <div class="ig-panels">' +
            '      <div class="ig-panel in">' +
            '        <div class="ig-ph">INPUT (stdin) <span style="display:flex;color:#7d898b" title="Each line is read by input()">' + ICON.info + '</span></div>' +
            '        <div class="ig-hint">Provide input before running.</div>' +
            '        <textarea class="ig-stdin" spellcheck="false" placeholder="One value per line"></textarea>' +
            '      </div>' +
            '      <div class="ig-panel out">' +
            '        <div class="ig-ph">OUTPUT <span class="ig-pill idle">Ready</span><em class="ig-runby"></em></div>' +
            '        <pre class="ig-outbody"></pre>' +
            '        <div class="ig-of"><span class="ig-exit">Exit code: —</span><span class="ig-time">Execution time: —</span></div>' +
            '      </div>' +
            '    </div>' +
            '  </section>' +
            '</div>' +
            '<footer class="ig-status">' +
            '  <span class="ig-s-lang">Python</span><span>UTF-8</span><span class="ig-s-pos">Ln 1, Col 1</span>' +
            '  <span class="r ig-s-users" style="display:flex;gap:8px;align-items:center">' + ICON.users + '<b style="font-weight:400" class="ig-s-n">1 collaborator</b></span>' +
            '  <span class="hide-s" style="display:flex;gap:8px;align-items:center">' + ICON.lock + 'Autosaved in this browser</span>' +
            '</footer>' +
            '<div class="ig-toast"></div>';

        document.body.appendChild(root);
        this.root = root;
        this.ta = this.q(".ig-code");
        this.hl = this.q(".ig-hl");
        this.scroll = this.q(".ig-scroll");
        this.gtxt = this.q(".gtxt");
        this.ghl = this.q(".ghl");
        this.linehl = this.q(".ig-linehl");
        this.stdinEl = this.q(".ig-stdin");

        /* clicks (event delegation) */
        root.addEventListener("click", function (e) {
            var el = e.target.closest("[data-act],[data-file],[data-del]");
            if (!el || !root.contains(el)) return;
            var act = el.getAttribute("data-act");
            if (el.hasAttribute("data-del")) { e.stopPropagation(); self.deleteFile(el.getAttribute("data-del")); return; }
            if (el.hasAttribute("data-file") && !act) { self.switchFile(el.getAttribute("data-file")); return; }
            if (act === "leave") self.destroy(true);
            else if (act === "share") self.share();
            else if (act === "download") self.download();
            else if (act === "run") self.run();
            else if (act === "newfile") self.newFile();
        });

        root.addEventListener("dblclick", function (e) {
            var el = e.target.closest("[data-file]");
            if (el) self.startRename(el.getAttribute("data-file"));
        });
        root.addEventListener("click", function (e) {
            if (e.target.closest(".ig-user.me")) self.changeName();
        });

        /* title */
        var titleEl = this.q(".ig-title");
        titleEl.value = this.title;
        titleEl.addEventListener("input", function () {
            self.title = titleEl.value;
            self.save();
            self.send({ t: "title", title: self.title });
        });

        /* language select */
        this.q(".ig-lang").addEventListener("change", function (e) {
            var f = self.file();
            var lang = e.target.value;
            var base = f.name.replace(/\.[^.]*$/, "");
            f.lang = lang;
            f.name = base + "." + LANGS[lang].ext;
            self.broadcastFiles();
            self.save();
            self.renderAll();
        });

        /* stdin */
        this.stdinEl.value = this.stdin;
        this.stdinEl.addEventListener("input", function () {
            self.stdin = self.stdinEl.value;
            self.save();
            self.send({ t: "stdin", text: self.stdin });
        });

        /* editor events */
        this.ta.addEventListener("input", function () { self.onLocalEdit(); });
        this.ta.addEventListener("keydown", function (e) { self.onEditorKey(e); });
        ["keyup", "click", "focus", "select"].forEach(function (ev) {
            self.ta.addEventListener(ev, function () { self.onCaretMove(); });
        });
        document.addEventListener("selectionchange", this.selListener = function () {
            if (document.activeElement === self.ta) self.onCaretMove();
        });
        this.scroll.addEventListener("mousedown", function (e) {
            if (e.target === self.scroll || e.target.classList.contains("ig-inner")) {
                setTimeout(function () { self.ta.focus(); }, 0);
            }
        });
    };

    P.measure = function () {
        var el = this.q(".ig-measure");
        var w = el.getBoundingClientRect().width / el.textContent.length;
        if (w > 3) this.cw = w;
    };

    /* ---------------------------------------------------------
       STATE ACCESS / PERSISTENCE
    --------------------------------------------------------- */

    P.file = function (id) {
        id = id || this.activeId;
        for (var i = 0; i < this.files.length; i++) if (this.files[i].id === id) return this.files[i];
        return null;
    };

    P.save = function () {
        lsSet("ignis:room:" + this.room, JSON.stringify({
            title: this.title, files: this.files, activeId: this.activeId, stdin: this.stdin
        }));
    };

    P.toast = function (msg) {
        var t = this.q(".ig-toast");
        t.textContent = msg;
        t.classList.add("on");
        clearTimeout(this.toastT);
        this.toastT = setTimeout(function () { t.classList.remove("on"); }, 2000);
    };

    /* ---------------------------------------------------------
       RENDERING
    --------------------------------------------------------- */

    P.renderAll = function () {
        this.renderFiles();
        this.renderEditor(true);
        this.renderUsers();
        this.renderOutput();
        var f = this.file();
        this.q(".ig-lang").value = f.lang;
        this.q(".ig-s-lang").textContent = LANGS[f.lang] ? LANGS[f.lang].label : f.lang;
    };

    P.badge = function (f) {
        var L = LANGS[f.lang] || LANGS.python;
        return '<span class="ig-badge" style="background:' + L.color + '">' + L.badge + "</span>";
    };

    P.nameHTML = function (f) {
        if (this.renamingId === f.id) return '<input class="ig-rename" value="' + esc(f.name).replace(/"/g, "&quot;") + '" data-rn="' + f.id + '">';
        return '<span class="nm">' + esc(f.name) + "</span>";
    };

    P.renderFiles = function () {
        var self = this;
        this.q(".ig-files").innerHTML = this.files.map(function (f) {
            return '<div class="ig-file' + (f.id === self.activeId ? " on" : "") + '" data-file="' + f.id + '">' +
                self.badge(f) + self.nameHTML(f) +
                (self.files.length > 1 ? '<button class="x" data-del="' + f.id + '" title="Delete file">×</button>' : "") +
                "</div>";
        }).join("");

        this.q(".ig-tabs").innerHTML = this.files.map(function (f) {
            return '<div class="ig-tab' + (f.id === self.activeId ? " on" : "") + '" data-file="' + f.id + '">' +
                self.badge(f) + self.nameHTML(f) +
                (self.files.length > 1 ? '<button class="x" data-del="' + f.id + '" title="Close">×</button>' : "") +
                "</div>";
        }).join("") + '<div class="ig-tab plus" data-act="newfile" title="New file">' + ICON.plus + "</div>";

        var rn = this.root.querySelector(".ig-rename");
        if (rn) {
            var id = rn.getAttribute("data-rn");
            var done = false;
            var finish = function (apply) {
                if (done) return; done = true;
                if (apply) self.applyRename(id, rn.value);
                self.renamingId = null;
                self.renderFiles();
            };
            rn.addEventListener("keydown", function (e) {
                e.stopPropagation();
                if (e.key === "Enter") finish(true);
                if (e.key === "Escape") finish(false);
            });
            rn.addEventListener("blur", function () { finish(true); });
            rn.addEventListener("click", function (e) { e.stopPropagation(); });
            rn.focus(); rn.select();
        }
    };

    P.renderEditor = function (setValue) {
        var f = this.file();
        if (setValue) this.ta.value = f.content;
        this.refreshHighlight();
    };

    P.refreshHighlight = function () {
        var f = this.file();
        var text = this.ta.value;
        this.hl.innerHTML = highlight(text, f.lang);
        var n = text.split("\n").length;
        var nums = "";
        for (var i = 1; i <= n; i++) nums += i + "\n";
        this.gtxt.textContent = nums;
        this.updateCaretUI();
        this.renderCursors();
    };

    P.caretLC = function (text, pos) {
        var before = text.slice(0, pos);
        var line = before.split("\n").length - 1;
        var col = pos - (before.lastIndexOf("\n") + 1);
        return { line: line, col: col };
    };

    P.updateCaretUI = function () {
        var t = this.ta;
        var lc = this.caretLC(t.value, t.selectionStart);
        this.q(".ig-s-pos").textContent = "Ln " + (lc.line + 1) + ", Col " + (lc.col + 1);
        var y = PAD_T + lc.line * LH;
        this.linehl.style.top = y + "px";
        this.ghl.style.top = y + "px";
    };

    P.ensureCaretVisible = function () {
        var lc = this.caretLC(this.ta.value, this.ta.selectionEnd);
        var x = PAD_L + lc.col * this.cw;
        var y = PAD_T + lc.line * LH;
        var s = this.scroll, m = 24;
        if (y < s.scrollTop + m) s.scrollTop = Math.max(0, y - m);
        else if (y + LH > s.scrollTop + s.clientHeight - m) s.scrollTop = y + LH - s.clientHeight + m;
        if (x < s.scrollLeft + m) s.scrollLeft = Math.max(0, x - m);
        else if (GUTTER_W + x + this.cw > s.scrollLeft + s.clientWidth - m) s.scrollLeft = GUTTER_W + x + this.cw - s.clientWidth + m;
    };

    P.renderCursors = function () {
        var box = this.q(".ig-peers");
        var text = this.ta.value;
        var html = "";
        for (var id in this.peers) {
            var p = this.peers[id];
            if (p.fileId !== this.activeId) continue;
            var pos = Math.max(0, Math.min(p.pos || 0, text.length));
            var lc = this.caretLC(text, pos);
            html += '<div class="ig-peer" style="left:' + (PAD_L + lc.col * this.cw) + "px;top:" + (PAD_T + lc.line * LH + 2) +
                "px;background:" + p.color + '"><span style="background:' + p.color + '">' + esc(p.name) + "</span></div>";
        }
        box.innerHTML = html;
    };

    P.renderUsers = function () {
        var self = this;
        var me = this.file();
        var rows = ['<div class="ig-user me" title="Click to change your name"><i class="ig-dot" style="background:' + this.me.color + '"></i><div><b>' +
            esc(this.me.name) + ' (you)</b><small>Editing ' + esc(me ? me.name : "") + "</small></div></div>"];
        var av = ['<div class="ig-av" style="border-color:' + this.me.color + ";color:" + this.me.color + '" title="' + esc(this.me.name) + '">' + esc(this.me.name.charAt(0).toUpperCase()) + "</div>"];
        Object.keys(this.peers).forEach(function (id) {
            var p = self.peers[id];
            var pf = self.file(p.fileId);
            rows.push('<div class="ig-user"><i class="ig-dot" style="background:' + p.color + '"></i><div><b>' + esc(p.name) +
                "</b><small>Editing " + esc(pf ? pf.name : "—") + "</small></div></div>");
            av.push('<div class="ig-av" style="border-color:' + p.color + ";color:" + p.color + '" title="' + esc(p.name) + '">' + esc(p.name.charAt(0).toUpperCase()) + "</div>");
        });
        this.q(".ig-users").innerHTML = rows.join("");
        this.q(".ig-avatars").innerHTML = av.join("");
        var n = rows.length;
        this.q(".ig-count").textContent = n;
        this.q(".ig-s-n").textContent = n + (n === 1 ? " collaborator" : " collaborators");
    };

    P.renderOutput = function () {
        var o = this.output;
        var pill = this.q(".ig-pill");
        var map = {
            idle: ["idle", "Ready"], running: ["run", o.note || "Running…"],
            done: ["ok", "✓ Completed"], error: ["bad", "✕ Failed"], stopped: ["bad", "■ Stopped"]
        };
        var st = map[o.status] || map.idle;
        pill.className = "ig-pill " + st[0];
        pill.textContent = st[1];
        this.q(".ig-runby").textContent = o.by ? "Run by " + o.by + " • " + (LANGS[o.lang] ? LANGS[o.lang].label : o.lang) : "";
        var body = this.q(".ig-outbody");
        if (!o.parts.length) {
            body.innerHTML = o.status === "idle" ? '<span class="dim">Press Run Code (Ctrl+Enter) to see output here.</span>' : "";
        } else {
            body.innerHTML = o.parts.map(function (p) {
                return p.k === "err" ? '<span class="err">' + esc(p.s) + "</span>" : esc(p.s);
            }).join("");
        }
        body.scrollTop = body.scrollHeight;
        this.q(".ig-exit").textContent = "Exit code: " + (o.code === null ? "—" : o.code);
        this.q(".ig-time").textContent = "Execution time: " + (o.ms === null ? "—" : (o.ms / 1000).toFixed(2) + " s");

        var btn = this.q(".ig-run");
        var running = o.status === "running" && this.running;
        btn.classList.toggle("stop", running);
        btn.innerHTML = (running ? ICON.stop : ICON.play) + "<b>" + (running ? "Stop" : "Run Code") + "</b>";
    };

    /* ---------------------------------------------------------
       FILE OPERATIONS
    --------------------------------------------------------- */

    P.switchFile = function (id) {
        if (id === this.activeId || !this.file(id)) return;
        this.activeId = id;
        this.save();
        this.renderAll();
        this.scroll.scrollTop = 0; this.scroll.scrollLeft = 0;
        this.ta.focus();
        this.heartbeat();
    };

    P.newFile = function () {
        var lang = this.file().lang;
        var ext = LANGS[lang].ext;
        var n = 1, name;
        do { name = "file" + n + "." + ext; n++; } while (this.files.some(function (f) { return f.name === name; }));
        var f = { id: uid(5), name: name, lang: lang, content: lang === "python" ? "# " + name + "\n" : "// " + name + "\n" };
        this.files.push(f);
        this.activeId = f.id;
        this.broadcastFiles(); this.save(); this.renderAll();
        this.ta.focus();
    };

    P.deleteFile = function (id) {
        if (this.files.length < 2) return;
        var f = this.file(id);
        if (!f) return;
        if (!window.confirm("Delete " + f.name + " for everyone in this room?")) return;
        this.files = this.files.filter(function (x) { return x.id !== id; });
        if (this.activeId === id) this.activeId = this.files[0].id;
        this.broadcastFiles(); this.save(); this.renderAll();
    };

    P.startRename = function (id) {
        this.renamingId = id;
        this.renderFiles();
    };

    P.applyRename = function (id, value) {
        var f = this.file(id);
        value = (value || "").trim().replace(/[\\/:*?"<>|]/g, "");
        if (!f || !value) return;
        f.name = value;
        var l = langFromName(value);
        if (l) f.lang = l;
        this.broadcastFiles(); this.save();
        this.renderAll();
    };

    P.changeName = function () {
        var n = window.prompt("Your display name:", this.me.name);
        if (!n) return;
        n = n.trim().slice(0, 20);
        if (!n) return;
        this.me.name = n;
        lsSet("ignis:name", n);
        this.renderUsers();
        this.heartbeat();
    };

    /* ---------------------------------------------------------
       EDITING
    --------------------------------------------------------- */

    P.insertText = function (text) {
        var ta = this.ta;
        ta.focus();
        var ok = false;
        try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
        if (!ok) {
            ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
            ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
    };

    P.onLocalEdit = function () {
        var f = this.file();
        f.content = this.ta.value;
        this.refreshHighlight();
        this.ensureCaretVisible();
        this.save();
        this.send({ t: "edit", fileId: f.id, content: f.content });
        this.queueCursor();
    };

    P.onCaretMove = function () {
        this.updateCaretUI();
        this.queueCursor();
    };

    P.onEditorKey = function (e) {
        var ta = this.ta, v = ta.value;
        var s = ta.selectionStart, en = ta.selectionEnd;
        var f = this.file();
        var unit = new Array((LANGS[f.lang] || LANGS.python).indent + 1).join(" ");
        var mod = e.ctrlKey || e.metaKey;

        if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); this.toast("Autosaved ✓"); return; }
        if (e.isComposing || mod || e.altKey) return;

        /* Tab / Shift+Tab */
        if (e.key === "Tab") {
            e.preventDefault();
            if (s === en && !e.shiftKey) { this.insertText(unit); return; }
            var ls = v.lastIndexOf("\n", s - 1) + 1;
            var le = v.indexOf("\n", en);
            if (le < 0) le = v.length;
            if (en > s && v.charAt(en - 1) === "\n") le = en - 1;
            var lines = v.slice(ls, le).split("\n");
            var re = new RegExp("^( {1," + unit.length + "}|\\t)");
            var nb = lines.map(function (l) { return e.shiftKey ? l.replace(re, "") : unit + l; }).join("\n");
            ta.setSelectionRange(ls, le);
            this.insertText(nb);
            ta.setSelectionRange(ls, ls + nb.length);
            return;
        }

        /* Enter: keep indentation, open a block after : { ( [ */
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            var lineStart = v.lastIndexOf("\n", s - 1) + 1;
            var line = v.slice(lineStart, s);
            var indent = /^[ \t]*/.exec(line)[0];
            var before = v.charAt(s - 1), after = v.charAt(en);
            var opens = /[\{\(\[]\s*$/.test(line) || (f.lang === "python" && /:\s*$/.test(line));
            var pairs = { "{": "}", "(": ")", "[": "]" };
            if (pairs[before] && after === pairs[before]) {
                this.insertText("\n" + indent + unit + "\n" + indent);
                var np = s + 1 + indent.length + unit.length;
                ta.setSelectionRange(np, np);
            } else {
                this.insertText("\n" + indent + (opens ? unit : ""));
            }
            return;
        }

        /* Backspace between an empty pair */
        if (e.key === "Backspace" && s === en && s > 0) {
            var pr = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "`": "`" };
            if (pr[v.charAt(s - 1)] === v.charAt(s) && v.charAt(s)) {
                e.preventDefault();
                ta.setSelectionRange(s - 1, s + 1);
                this.insertText("");
                return;
            }
        }

        /* closing char: step over an existing one */
        if (s === en && (e.key === ")" || e.key === "]" || e.key === "}") && v.charAt(s) === e.key) {
            e.preventDefault();
            ta.setSelectionRange(s + 1, s + 1);
            return;
        }

        /* auto-close brackets and quotes */
        var open = { "(": ")", "[": "]", "{": "}" };
        if (open[e.key]) {
            e.preventDefault();
            if (s !== en) {
                var sel = v.slice(s, en);
                this.insertText(e.key + sel + open[e.key]);
                ta.setSelectionRange(s + 1, s + 1 + sel.length);
            } else {
                this.insertText(e.key + open[e.key]);
                ta.setSelectionRange(s + 1, s + 1);
            }
            return;
        }
        if (e.key === "\"" || e.key === "'" || (e.key === "`" && f.lang === "javascript")) {
            var q = e.key;
            if (s === en && v.charAt(s) === q) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return; }
            var prev = v.charAt(s - 1), next = v.charAt(en);
            if (s !== en) {
                e.preventDefault();
                var sel2 = v.slice(s, en);
                this.insertText(q + sel2 + q);
                ta.setSelectionRange(s + 1, s + 1 + sel2.length);
                return;
            }
            if (!/\w/.test(prev) && (next === "" || /[\s\)\]\}:,;.]/.test(next))) {
                e.preventDefault();
                this.insertText(q + q);
                ta.setSelectionRange(s + 1, s + 1);
            }
        }
    };

    /* apply someone else's edit while keeping my caret where it belongs */
    P.applyRemoteContent = function (fileId, content) {
        var f = this.file(fileId);
        if (!f || f.content === content) return;
        var old = f.content;
        f.content = content;
        this.save();
        if (fileId !== this.activeId) return;

        var ta = this.ta;
        var a = ta.selectionStart, b = ta.selectionEnd;
        var p = 0, max = Math.min(old.length, content.length);
        while (p < max && old.charCodeAt(p) === content.charCodeAt(p)) p++;
        var sfx = 0;
        while (sfx < max - p && old.charCodeAt(old.length - 1 - sfx) === content.charCodeAt(content.length - 1 - sfx)) sfx++;
        var delta = content.length - old.length;
        function mapPos(x) {
            if (x <= p) return x;
            if (x >= old.length - sfx) return x + delta;
            return p;
        }
        var na = mapPos(a), nb = mapPos(b);
        ta.value = content;
        try { ta.setSelectionRange(na, nb); } catch (e) { /* ignore */ }
        this.refreshHighlight();
    };

    /* ---------------------------------------------------------
       LIVE COLLABORATION  (BroadcastChannel)
    --------------------------------------------------------- */

    P.send = function (msg) {
        if (!this.channel) return;
        msg.from = this.me.id;
        try { this.channel.postMessage(msg); } catch (e) { /* ignore */ }
    };

    P.broadcastFiles = function () {
        this.send({ t: "files", files: this.files });
    };

    P.queueCursor = function () {
        var self = this;
        if (this.cursorQ) return;
        this.cursorQ = setTimeout(function () {
            self.cursorQ = null;
            self.send({ t: "cursor", fileId: self.activeId, pos: self.ta.selectionEnd, name: self.me.name, color: self.me.color });
        }, 40);
    };

    P.heartbeat = function () {
        this.send({ t: "cursor", fileId: this.activeId, pos: this.ta.selectionEnd, name: this.me.name, color: this.me.color });
    };

    P.touchPeer = function (d) {
        var p = this.peers[d.from];
        var isNew = !p;
        if (!p) {
            p = this.peers[d.from] = {
                name: "Guest", color: PEER_COLORS[hashStr(d.from) % PEER_COLORS.length],
                fileId: null, pos: 0, seen: 0
            };
        }
        if (d.name) p.name = d.name;
        if (d.color) p.color = d.color === MY_COLOR ? PEER_COLORS[hashStr(d.from) % PEER_COLORS.length] : d.color;
        if (d.fileId) p.fileId = d.fileId;
        if (typeof d.pos === "number") p.pos = d.pos;
        p.seen = Date.now();
        return isNew;
    };

    P.onMessage = function (d) {
        if (!d || d.from === this.me.id || !active || active !== this) return;
        var changedPeers = false;

        switch (d.t) {
            case "hello":
                this.touchPeer(d); changedPeers = true;
                /* give the newcomer the current room state */
                this.send({
                    t: "state", to: d.from, title: this.title, files: this.files, stdin: this.stdin,
                    output: this.output, name: this.me.name, color: this.me.color, fileId: this.activeId, pos: this.ta.selectionEnd
                });
                break;

            case "state":
                if (d.to !== this.me.id) { this.touchPeer(d); changedPeers = true; break; }
                this.touchPeer(d); changedPeers = true;
                if (this.awaitingState) {
                    this.awaitingState = false;
                    this.title = d.title || this.title;
                    this.files = d.files && d.files.length ? d.files : this.files;
                    if (!this.file()) this.activeId = this.files[0].id;
                    this.stdin = d.stdin || "";
                    this.stdinEl.value = this.stdin;
                    this.q(".ig-title").value = this.title;
                    if (d.output) this.output = d.output;
                    this.save();
                    this.renderAll();
                }
                break;

            case "cursor":
                this.touchPeer(d); changedPeers = true;
                break;

            case "edit":
                this.touchPeer(d);
                this.applyRemoteContent(d.fileId, d.content);
                this.renderCursors();
                break;

            case "files":
                this.files = d.files;
                if (!this.file()) this.activeId = this.files[0].id;
                this.save();
                this.renderAll();
                break;

            case "title":
                this.title = d.title;
                this.q(".ig-title").value = d.title;
                this.save();
                break;

            case "stdin":
                this.stdin = d.text;
                this.stdinEl.value = d.text;
                this.save();
                break;

            case "output":
                if (!this.running) { this.output = d.output; this.renderOutput(); }
                break;

            case "bye":
                delete this.peers[d.from]; changedPeers = true;
                break;
        }

        if (changedPeers) { this.renderUsers(); this.renderCursors(); }
    };

    P.prune = function () {
        var now = Date.now(), changed = false;
        for (var id in this.peers) {
            if (now - this.peers[id].seen > PEER_TTL) { delete this.peers[id]; changed = true; }
        }
        if (changed) { this.renderUsers(); this.renderCursors(); }
    };

    /* ---------------------------------------------------------
       RUN CODE
    --------------------------------------------------------- */

    P.run = function () {
        if (this.running) { this.stopRun(); return; }
        var self = this;
        var f = this.file();
        var lang = f.lang;
        if (!LANGS[lang]) { this.toast("This language can't be run."); return; }

        var worker;
        if (lang === "python") {
            worker = this.workers.python || (this.workers.python = makeWorker());
        } else {
            worker = makeWorker();
        }
        this.curWorker = worker;
        this.curLang = lang;
        this.running = true;
        this.output = { by: this.me.name, lang: lang, status: "running", parts: [], code: null, ms: null, note: "Running…" };
        this.renderOutput();
        var t0 = performance.now();

        worker.onmessage = function (ev) {
            var d = ev.data, o = self.output;
            if (d.type === "status") { o.note = d.text; self.renderOutput(); }
            else if (d.type === "start") { t0 = performance.now(); o.note = "Running…"; self.renderOutput(); }
            else if (d.type === "stdout") { o.parts.push({ k: "out", s: d.text }); self.renderOutput(); }
            else if (d.type === "stderr") { o.parts.push({ k: "err", s: d.text }); self.renderOutput(); }
            else if (d.type === "done") {
                o.code = d.code;
                o.ms = performance.now() - t0;
                o.status = d.code === 0 ? "done" : "error";
                self.finishRun(lang);
            }
        };
        worker.onerror = function (ev) {
            var o = self.output;
            o.parts.push({ k: "err", s: (ev && ev.message ? ev.message : "Runtime error") + "\n" });
            o.code = 1; o.ms = performance.now() - t0; o.status = "error";
            if (lang === "python") { try { worker.terminate(); } catch (e) { /* ignore */ } delete self.workers.python; }
            self.finishRun(lang);
        };
        worker.postMessage({ lang: lang, code: f.content, stdin: this.stdinEl.value });
    };

    P.finishRun = function (lang) {
        this.running = false;
        if (lang !== "python" && this.curWorker) { try { this.curWorker.terminate(); } catch (e) { /* ignore */ } }
        this.curWorker = null;
        this.renderOutput();
        this.send({ t: "output", output: this.output });
    };

    P.stopRun = function () {
        if (!this.running) return;
        try { this.curWorker.terminate(); } catch (e) { /* ignore */ }
        if (this.curLang === "python") delete this.workers.python;
        this.curWorker = null;
        this.running = false;
        this.output.status = "stopped";
        this.output.code = 130;
        this.output.parts.push({ k: "err", s: "\n[stopped]\n" });
        this.renderOutput();
        this.send({ t: "output", output: this.output });
    };

    /* ---------------------------------------------------------
       SHARE / DOWNLOAD
    --------------------------------------------------------- */

    P.share = function () {
        var self = this;
        var url = location.href.split("#")[0] + "#room=" + this.room;
        var done = function () { self.toast("Invite link copied — open it in another tab to collaborate"); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, function () { window.prompt("Copy this invite link:", url); });
        } else {
            window.prompt("Copy this invite link:", url);
        }
    };

    P.download = function () {
        var f = this.file();
        var blob = new Blob([f.content], { type: "text/plain;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        this.toast("Downloaded " + f.name);
    };

    /* ---------------------------------------------------------
       LEAVE
    --------------------------------------------------------- */

    P.destroy = function (clearHash) {
        this.send({ t: "bye" });
        this.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
        document.removeEventListener("keydown", this.onKey);
        document.removeEventListener("selectionchange", this.selListener);
        window.removeEventListener("pagehide", this.onUnload);
        for (var k in this.workers) { try { this.workers[k].terminate(); } catch (e) { /* ignore */ } }
        if (this.curWorker) { try { this.curWorker.terminate(); } catch (e) { /* ignore */ } }
        if (this.channel) { try { this.channel.close(); } catch (e) { /* ignore */ } }
        this.save();
        this.root.remove();
        document.body.style.overflow = "";
        if (clearHash) history.replaceState(null, "", location.pathname + location.search);
        active = null;
    };

    /* ---------------------------------------------------------
       PUBLIC API  +  auto-open for shared links
    --------------------------------------------------------- */

    window.IgnisEditor = { open: open, close: close };

    if (/[#&]room=[a-z0-9]+/i.test(location.hash)) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", open);
        else open();
    }
})();
