import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { APP_VERSION } from "../src/version.ts";

describe("app version", () => {
  it("is 6.1.4 in package.json, the UI constant, and the electron build version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(APP_VERSION, "6.1.4");
    assert.equal(pkg.version, "6.1.4");
    assert.equal(pkg.build.buildVersion, "6.1.4");
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, /Version 6\.1\.4/);
    const splash = fs.readFileSync(new URL("../splash.html", import.meta.url), "utf8");
    assert.match(splash, /Version 6\.1\.4/);
  });
});