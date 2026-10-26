/* =========================================================
   IGNIS - web server + authentication API

   Routes
     POST /api/signup   create account  (name, email, password, confirmPassword)
     POST /api/login    log in          (email, password)
     GET  /api/me       current user (needs session cookie)
     POST /api/logout   end the session

   Security model
     - Passwords are hashed with scrypt (per-user random salt). Plain
       passwords are never stored or logged.
     - Sessions are signed JWTs kept in an httpOnly, SameSite=Lax cookie,
       so page JavaScript can never read the token (XSS can't steal it).
     - All input is validated on the server; the browser checks are only
       for convenience.
     - Login errors are generic and timing-equalised, so attackers can't
       discover which emails are registered by logging in.
     - Signup/login are rate limited per IP.

   Storage: data/users.json, written atomically (temp file + rename)
   through a single write queue so concurrent signups can't corrupt it
   or create duplicate emails.
   ========================================================= */

"use strict";

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

/* ---------------------------------------------------------
   CONFIG
--------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PUBLIC_DIR = path.join(__dirname, "bee");

const COOKIE_NAME = "ignis_session";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------
   ERRORS
--------------------------------------------------------- */

class HttpError extends Error {
    constructor(status, message, fields) {
        super(message);
        this.status = status;
        this.fields = fields || null;
    }
}

/* ---------------------------------------------------------
   PASSWORD HASHING  (scrypt)
--------------------------------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, "base64");
    const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
        N: Number(N), r: Number(r), p: Number(p)
    });
    return crypto.timingSafeEqual(actual, expected);
}

/* ---------------------------------------------------------
   USER STORE  (JSON file, atomic writes, serialised)
--------------------------------------------------------- */

class UserStore {
    constructor(file) {
        this.file = file;
        this.users = [];
        this.byEmail = new Map();
        this.byId = new Map();
        this.queue = Promise.resolve();
    }

    async init() {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        let raw = null;
        try {
            raw = await fsp.readFile(this.file, "utf8");
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
        if (raw !== null && raw.trim() !== "") {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                // Refuse to start rather than overwrite a damaged file with an empty one.
                throw new Error(`${this.file} is not valid JSON. Fix or restore it before starting. (${err.message})`);
            }
            if (!Array.isArray(parsed)) throw new Error(`${this.file} must contain a JSON array.`);
            this.users = parsed;
        }
        this.reindex();
    }

    reindex() {
        this.byEmail = new Map(this.users.map((u) => [u.email, u]));
        this.byId = new Map(this.users.map((u) => [u.id, u]));
    }

    findByEmail(email) { return this.byEmail.get(email) || null; }
    findById(id) { return this.byId.get(id) || null; }

    async persist(list) {
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
        await fsp.rename(tmp, this.file);
    }

    /** Add a user. The duplicate check and the write happen together in the queue. */
    create(record) {
        const run = this.queue.then(async () => {
            if (this.byEmail.has(record.email)) {
                throw new HttpError(409, "An account with this email already exists.", {
                    email: "An account with this email already exists."
                });
            }
            const next = this.users.concat(record);
            await this.persist(next);
            this.users = next;
            this.reindex();
            return record;
        });
        this.queue = run.catch(() => { });
        return run;
    }
}

const store = new UserStore(USERS_FILE);

/* ---------------------------------------------------------
   SESSION SECRET  (env var, or generated once and saved)
--------------------------------------------------------- */

async function loadSecret() {
    if (process.env.JWT_SECRET) {
        if (process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");
        return process.env.JWT_SECRET;
    }
    const file = path.join(DATA_DIR, ".jwt_secret");
    try {
        const s = (await fsp.readFile(file, "utf8")).trim();
        if (s.length >= 32) return s;
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
    const secret = crypto.randomBytes(48).toString("hex");
    await fsp.writeFile(file, secret, { mode: 0o600 });
    return secret;
}

/* ---------------------------------------------------------
   VALIDATION
--------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COMMON_PASSWORDS = new Set([
    "password1", "password123", "password1!", "qwerty123", "qwertyuiop1", "welcome1", "welcome123",
    "admin123", "letmein123", "iloveyou1", "abc12345", "abcd1234", "p@ssw0rd", "passw0rd", "changeme1",
    "12345678a", "1q2w3e4r", "1qaz2wsx"
]);

const str = (v) => (typeof v === "string" ? v : "");

function cleanName(v) {
    return str(v).replace(/\s+/g, " ").trim();
}

function cleanEmail(v) {
    return str(v).trim().toLowerCase();
}

function passwordProblem(pw) {
    if (pw.length < 8) return "Password must be at least 8 characters.";
    if (pw.length > 128) return "Password must be 128 characters or fewer.";
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
        return "Use uppercase, lowercase and a number.";
    }
    if (COMMON_PASSWORDS.has(pw.toLowerCase())) return "That password is too common. Choose a different one.";
    return null;
}

function validateSignup(body) {
    const errors = {};
    const name = cleanName(body.name);
    const email = cleanEmail(body.email);
    const password = str(body.password);
    const confirm = str(body.confirmPassword);

    if (name.length < 2 || name.length > 50 || /[\u0000-\u001f<>]/.test(name)) {
        errors.name = "Enter your name (2-50 characters, no < or >).";
    }
    if (!email) errors.email = "Email is required.";
    else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email.";

    const pwErr = password ? passwordProblem(password) : "Password is required.";
    if (pwErr) errors.password = pwErr;

    if (!confirm) errors.confirmPassword = "Please confirm your password.";
    else if (confirm !== password) errors.confirmPassword = "Passwords do not match.";

    return { errors, value: { name, email, password } };
}

function validateLogin(body) {
    const errors = {};
    const email = cleanEmail(body.email);
    const password = str(body.password);
    if (!email) errors.email = "Email is required.";
    else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email.";
    if (!password) errors.password = "Password is required.";
    else if (password.length > 128) errors.password = "Password is too long.";
    return { errors, value: { email, password } };
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

/* ---------------------------------------------------------
   APP
--------------------------------------------------------- */

async function main() {
    await store.init();
    const SECRET = await loadSecret();

    // A real hash to compare against when the email is unknown, so that
    // "no such user" and "wrong password" take the same time.
    const DUMMY_HASH = await hashPassword(crypto.randomBytes(12).toString("hex"));

    const app = express();
    if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);

    // CSP is left off because the editor page runs user code with
    // new Function() and loads Pyodide from a CDN; the other helmet
    // protections (frameguard, nosniff, HSTS, referrer policy...) stay on.
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.json({ limit: "10kb" }));

    /* ---- helpers ---- */

    function readCookie(req, name) {
        const header = req.headers.cookie;
        if (!header) return null;
        for (const part of header.split(";")) {
            const i = part.indexOf("=");
            if (i > -1 && part.slice(0, i).trim() === name) {
                try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
            }
        }
        return null;
    }

    function startSession(res, user) {
        const token = jwt.sign({ sub: user.id }, SECRET, { algorithm: "HS256", expiresIn: `${SESSION_DAYS}d` });
        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: IS_PROD,
            maxAge: SESSION_MS,
            path: "/"
        });
    }

    function currentUser(req) {
        const token = readCookie(req, COOKIE_NAME);
        if (!token) return null;
        try {
            const payload = jwt.verify(token, SECRET, { algorithms: ["HS256"] });
            return store.findById(payload.sub);
        } catch (e) {
            return null;
        }
    }

    // State-changing requests must be JSON. A cross-site HTML form can't send that,
    // which (with SameSite cookies) blocks CSRF.
    function requireJson(req, res, next) {
        if (!req.is("application/json")) return next(new HttpError(415, "Content-Type must be application/json."));
        if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
            return next(new HttpError(400, "Request body must be a JSON object."));
        }
        next();
    }

    const limiter = (max, skipOk) => rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: max,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: !!skipOk,
        handler: (req, res) => res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." })
    });

    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    /* ---- routes ---- */

    app.post("/api/signup", limiter(20), requireJson, wrap(async (req, res) => {
        const { errors, value } = validateSignup(req.body);
        if (Object.keys(errors).length) throw new HttpError(400, "Please fix the highlighted fields.", errors);

        // Fast path for the common duplicate; create() re-checks atomically.
        if (store.findByEmail(value.email)) {
            throw new HttpError(409, "An account with this email already exists.", { email: "An account with this email already exists." });
        }

        const user = await store.create({
            id: crypto.randomUUID(),
            name: value.name,
            email: value.email,
            passwordHash: await hashPassword(value.password),
            createdAt: new Date().toISOString()
        });

        startSession(res, user);
        res.status(201).json({ user: publicUser(user) });
    }));

    app.post("/api/login", limiter(20, true), requireJson, wrap(async (req, res) => {
        const { errors, value } = validateLogin(req.body);
        if (Object.keys(errors).length) throw new HttpError(400, "Please fix the highlighted fields.", errors);

        const user = store.findByEmail(value.email);
        const ok = await verifyPassword(value.password, user ? user.passwordHash : DUMMY_HASH);
        if (!user || !ok) throw new HttpError(401, "Invalid email or password.");

        startSession(res, user);
        res.json({ user: publicUser(user) });
    }));

    app.get("/api/me", (req, res) => {
        res.set("Cache-Control", "no-store");
        const user = currentUser(req);
        if (!user) return res.status(401).json({ error: "Not signed in." });
        res.json({ user: publicUser(user) });
    });

    app.post("/api/logout", (req, res) => {
        res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" });
        res.status(204).end();
    });

    app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

    /* ---- static website ---- */

    app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

    /* ---- errors ---- */

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof HttpError) {
            return res.status(err.status).json(err.fields ? { error: err.message, errors: err.fields } : { error: err.message });
        }
        if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
        if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
        console.error(err);
        res.status(500).json({ error: "Something went wrong on our side. Please try again." });
    });

    app.listen(PORT, () => {
        console.log(`IGNIS running at http://localhost:${PORT}`);
    });
}

main().catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
});
