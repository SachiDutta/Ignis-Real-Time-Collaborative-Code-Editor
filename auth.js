/* =========================================================
   IGNIS - frontend auth helper (shared by index, login, signup)

   - Talks to the backend: /api/signup, /api/login, /api/me, /api/logout
   - The real session lives in an httpOnly cookie set by the server.
   - The user's public profile {id, name, email} is cached in
     localStorage ("ignis:user") so the navbar can update instantly
     and stays in sync across tabs.
   - On the home page it swaps the Login / Sign Up buttons for an
     account chip (avatar + name + menu with Log out).
   ========================================================= */

(function () {
    "use strict";

    var KEY = "ignis:user";

    /* ---------- cached user state ---------- */

    function getUser() {
        try {
            var u = JSON.parse(localStorage.getItem(KEY) || "null");
            return u && typeof u.name === "string" ? u : null;
        } catch (e) { return null; }
    }

    function setUser(u) {
        try {
            if (u) localStorage.setItem(KEY, JSON.stringify({ id: u.id, name: u.name, email: u.email }));
            else localStorage.removeItem(KEY);
        } catch (e) { /* storage unavailable - the cookie still works */ }
    }

    /* ---------- API ---------- */

    function api(method, path, body) {
        var opts = {
            method: method,
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        };
        if (body !== undefined) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        return fetch("/api/" + path, opts).then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
                if (!res.ok) {
                    var err = new Error((data && data.error) || "Something went wrong. Please try again.");
                    err.status = res.status;
                    err.fields = (data && data.errors) || {};
                    throw err;
                }
                return data;
            });
        }, function () {
            var err = new Error("Can't reach the server. Start it with \"npm start\" and open http://localhost:3000.");
            err.status = 0;
            err.fields = {};
            throw err;
        });
    }

    function signup(payload) {
        return api("POST", "signup", payload).then(function (d) { setUser(d.user); return d.user; });
    }

    function login(payload) {
        return api("POST", "login", payload).then(function (d) { setUser(d.user); return d.user; });
    }

    function logout() {
        return api("POST", "logout").then(null, function () { /* still clear locally */ }).then(function () {
            setUser(null);
            renderNav();
        });
    }

    /** Ask the server who we are. A 401 clears local state; a network error keeps it. */
    function refresh() {
        return api("GET", "me").then(function (d) {
            setUser(d.user);
            renderNav();
            return d.user;
        }, function (err) {
            if (err.status === 401) { setUser(null); renderNav(); }
            return getUser();
        });
    }

    /* ---------- navbar ---------- */

    var STYLE_ID = "ignis-auth-style";
    var CSS =
        ".account{position:relative;display:flex;align-items:center}" +
        ".account-btn{display:flex;align-items:center;gap:11px;padding:6px 14px 6px 7px;border:1px solid rgba(0,229,255,.35);background:rgba(0,229,255,.05);border-radius:999px;color:#fff;font:500 14px 'Inter',sans-serif;cursor:pointer;transition:.25s;max-width:240px}" +
        ".account-btn:hover,.account-btn[aria-expanded=true]{border-color:#00e5ff;background:rgba(0,229,255,.1);box-shadow:0 0 20px rgba(0,229,255,.15)}" +
        ".account-avatar{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#00e5ff,#0a8fa3);color:#001014;font:600 14px 'DM Mono',monospace;letter-spacing:0}" +
        ".account-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".account-caret{flex:none;width:14px;height:14px;stroke:#9fb0b3;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s}" +
        ".account-btn[aria-expanded=true] .account-caret{transform:rotate(180deg)}" +
        ".account-menu{position:absolute;right:0;top:calc(100% + 10px);min-width:230px;padding:8px;background:#080d0e;border:1px solid #263639;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.65);display:none;z-index:50}" +
        ".account-menu.open{display:block}" +
        ".account-head{padding:10px 12px 12px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:6px}" +
        ".account-head b{display:block;font-size:14px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".account-head span{display:block;margin-top:3px;font-size:12px;color:#7e888a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".account-item{display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:none;border-radius:6px;color:#d1d5d6;font:14px 'Inter',sans-serif;cursor:pointer}" +
        ".account-item:hover{background:rgba(0,229,255,.08);color:#00e5ff}" +
        ".account-item.danger:hover{background:rgba(255,105,117,.1);color:#ff6975}" +
        "@media (max-width:550px){.account-btn{padding:5px;gap:8px}.account-name{max-width:70px;font-size:13px}.account-caret{display:none}.account-btn{padding-right:11px}}";

    var defaultNavHTML = null;
    var outsideHandler = null;

    function initials(name) {
        var parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return "?";
        var first = Array.from(parts[0])[0] || "?";
        var second = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || "") : "";
        return (first + second).toUpperCase();
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function closeMenu(root) {
        var menu = root.querySelector(".account-menu");
        var btn = root.querySelector(".account-btn");
        if (menu) menu.classList.remove("open");
        if (btn) btn.setAttribute("aria-expanded", "false");
    }

    function buildChip(user) {
        var root = el("div", "account");

        var btn = el("button", "account-btn");
        btn.type = "button";
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        btn.title = user.email;
        btn.appendChild(el("span", "account-avatar", initials(user.name)));
        btn.appendChild(el("span", "account-name", user.name));
        btn.insertAdjacentHTML("beforeend", '<svg class="account-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');

        var menu = el("div", "account-menu");
        menu.setAttribute("role", "menu");
        var head = el("div", "account-head");
        head.appendChild(el("b", "", user.name));
        head.appendChild(el("span", "", user.email));
        menu.appendChild(head);

        var start = el("button", "account-item", "Start a session");
        start.type = "button";
        start.setAttribute("role", "menuitem");
        start.addEventListener("click", function () {
            closeMenu(root);
            if (window.IgnisEditor) window.IgnisEditor.open();
        });
        var out = el("button", "account-item danger", "Log out");
        out.type = "button";
        out.setAttribute("role", "menuitem");
        out.addEventListener("click", function () { logout(); });
        if (window.IgnisEditor) menu.appendChild(start);
        menu.appendChild(out);

        btn.addEventListener("click", function (e) {
            e.stopPropagation();
            var open = !menu.classList.contains("open");
            menu.classList.toggle("open", open);
            btn.setAttribute("aria-expanded", String(open));
        });

        root.appendChild(btn);
        root.appendChild(menu);
        return root;
    }

    function renderNav() {
        var box = document.querySelector(".nav-buttons");
        if (!box) return; // not on the home page

        if (!document.getElementById(STYLE_ID)) {
            var s = document.createElement("style");
            s.id = STYLE_ID;
            s.textContent = CSS;
            document.head.appendChild(s);
        }
        if (defaultNavHTML === null) defaultNavHTML = box.innerHTML;

        if (outsideHandler) {
            document.removeEventListener("click", outsideHandler);
            document.removeEventListener("keydown", outsideHandler);
            outsideHandler = null;
        }

        var user = getUser();
        if (!user) {
            box.innerHTML = defaultNavHTML;
            return;
        }

        box.textContent = "";
        var chip = buildChip(user);
        box.appendChild(chip);

        outsideHandler = function (e) {
            if (e.type === "keydown") { if (e.key === "Escape") closeMenu(chip); }
            else if (!chip.contains(e.target)) closeMenu(chip);
        };
        document.addEventListener("click", outsideHandler);
        document.addEventListener("keydown", outsideHandler);
    }

    /* ---------- boot ---------- */

    function init() {
        renderNav();     // instant, from the cached user
        refresh();       // then confirm with the server
    }

    // keep every open tab in sync when someone logs in / out
    window.addEventListener("storage", function (e) {
        if (e.key === KEY) renderNav();
    });

    window.Auth = {
        user: getUser,
        signup: signup,
        login: login,
        logout: logout,
        refresh: refresh,
        renderNav: renderNav,
        init: init
    };

    // Only the home page (which has a .nav-buttons bar) needs the automatic setup.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            if (document.querySelector(".nav-buttons")) init();
        });
    } else if (document.querySelector(".nav-buttons")) {
        init();
    }
})();
