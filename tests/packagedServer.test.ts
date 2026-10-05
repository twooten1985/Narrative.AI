import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The forked server runs from app.asar.unpacked/server.cjs. Node resolves
 * bare requires from that directory, not from inside app.asar. A naked
 * require("undici") is the 6.1.3 startup crash (MODULE_NOT_FOUND).
 */
describe("packaged server bundle", () => {
  it("inlines undici so the unpacked server does not require it", () => {
    const bundlePath = path.join(root, "server.cjs");
    const source = fs.readFileSync(bundlePath, "utf8");
    assert.equal(/require\(\s*["']undici["']\s*\)/.test(source), false, "server.cjs still has a naked require(\"undici\")");
    assert.equal(/require\(\s*["']node:undici["']\s*\)/.test(source), false, "server.cjs still has a naked require(\"node:undici\")");
    assert.equal(source.includes("require_undici()"), true, "undici was not inlined into server.cjs");
    assert.equal(source.includes("new import_undici.Agent("), true, "upload Agent constructor was not inlined");
    assert.equal(source.includes("UPLOAD_HEADERS_TIMEOUT_MS = 3 * 60 * 60 * 1e3"), true, "3-hour upload timeout was not inlined");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-unpacked-"));
    const serverCopy = path.join(dir, "server.cjs");
    fs.copyFileSync(bundlePath, serverCopy);
    fs.appendFileSync(
      serverCopy,
      [
        "",
        "const __uploadAgent = getUploadAgent();",
        "if (!__uploadAgent || typeof __uploadAgent.close !== 'function') {",
        "  console.error('UPLOAD_AGENT_FAIL');",
        "  process.exit(1);",
        "}",
        "Promise.resolve(__uploadAgent.close()).then(() => {",
        "  console.log('UPLOAD_AGENT_OK');",
        "}).catch((err) => {",
        "  console.error('UPLOAD_AGENT_FAIL', err);",
        "  process.exit(1);",
        "});",
        "",
      ].join("\n"),
    );
    const nativeSrc = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    const nativeDest = path.join(dir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    fs.mkdirSync(path.dirname(nativeDest), { recursive: true });
    fs.copyFileSync(nativeSrc, nativeDest);

    const userData = path.join(dir, "userdata");
    fs.mkdirSync(userData);
    const hookPath = path.join(dir, "block-undici.cjs");
    fs.writeFileSync(
      hookPath,
      [
        "const Module = require('module');",
        "const orig = Module._resolveFilename;",
        "Module._resolveFilename = function (request, parent, isMain, options) {",
        "  if (request === 'undici' || request === 'node:undici') {",
        "    const err = new Error(\"Cannot find module 'undici'\");",
        "    err.code = 'MODULE_NOT_FOUND';",
        "    throw err;",
        "  }",
        "  return orig.call(this, request, parent, isMain, options);",
        "};",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, ["-r", hookPath, serverCopy], {
      cwd: dir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NARRATIVE_NO_AUTOSTART: "1",
        APP_USER_DATA_PATH: userData,
        NODE_OPTIONS: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /Cannot find module 'undici'/);
    assert.match(output, /Found native sqlite binary at:/);
    assert.match(output, /UPLOAD_AGENT_OK/);
  });
});
