/**
 * Tests for API key resolution from auth.json and the environment
 *
 * @vitest-environment node
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PROVIDER_ID,
  readAuthJsonApiKey,
  resolveApiKey,
  resolveCredentialValue,
} from "./api-key.js";

let dir: string;
let authPath: string;

function writeAuth(contents: string) {
  writeFileSync(authPath, contents, { encoding: "utf-8", mode: 0o600 });
}

function missingPath() {
  return join(dir, "does-not-exist.json");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-explabs-auth-"));
  authPath = join(dir, "auth.json");
  delete process.env.EXPLABS_API_KEY;
  delete process.env.MY_CUSTOM_KEY;
  delete process.env.EXPLABS_TEST_SECRET;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.EXPLABS_API_KEY;
  delete process.env.MY_CUSTOM_KEY;
  delete process.env.EXPLABS_TEST_SECRET;
});

describe("readAuthJsonApiKey", () => {
  it("returns the key for the explabs entry", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "xpl_abc" } }));

    expect(readAuthJsonApiKey(authPath)).toBe("xpl_abc");
  });

  it("returns a !command key unresolved", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "!echo xpl_abc" } }));

    expect(readAuthJsonApiKey(authPath)).toBe("!echo xpl_abc");
  });

  it("returns undefined for a missing file", () => {
    expect(readAuthJsonApiKey(missingPath())).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    writeAuth("{ not json");

    expect(readAuthJsonApiKey(authPath)).toBeUndefined();
  });

  it("returns undefined when the explabs entry is missing", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "api_key", key: "sk-or" } }));

    expect(readAuthJsonApiKey(authPath)).toBeUndefined();
  });

  it("returns undefined for a non api_key credential", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "oauth", access: "token" } }));

    expect(readAuthJsonApiKey(authPath)).toBeUndefined();
  });

  it("returns undefined for an empty key", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "   " } }));

    expect(readAuthJsonApiKey(authPath)).toBeUndefined();
  });

  it("tolerates a BOM", () => {
    writeAuth(`﻿${JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "xpl_abc" } })}`);

    expect(readAuthJsonApiKey(authPath)).toBe("xpl_abc");
  });
});

describe("resolveCredentialValue", () => {
  it("returns literals as-is", () => {
    expect(resolveCredentialValue("xpl_abc")).toBe("xpl_abc");
  });

  it("trims whitespace", () => {
    expect(resolveCredentialValue("  xpl_abc\n")).toBe("xpl_abc");
  });

  it("returns undefined for an empty value", () => {
    expect(resolveCredentialValue("   ")).toBeUndefined();
  });

  it("runs a !command", () => {
    expect(resolveCredentialValue("!printf 'xpl_from_command\\n'")).toBe("xpl_from_command");
  });

  it("returns undefined when a !command fails", () => {
    expect(resolveCredentialValue("!exit 1")).toBeUndefined();
  });

  it("returns undefined when a !command prints nothing", () => {
    expect(resolveCredentialValue("!true")).toBeUndefined();
  });

  it("interpolates $VAR", () => {
    process.env.EXPLABS_TEST_SECRET = "xpl_env";

    expect(resolveCredentialValue("$EXPLABS_TEST_SECRET")).toBe("xpl_env");
  });

  it("interpolates ${VAR}", () => {
    process.env.EXPLABS_TEST_SECRET = "xpl_env";

    expect(resolveCredentialValue("${EXPLABS_TEST_SECRET}")).toBe("xpl_env");
  });

  it("returns undefined when the referenced variable is unset", () => {
    expect(resolveCredentialValue("$EXPLABS_TEST_SECRET")).toBeUndefined();
  });

  it("unescapes $$ and $!", () => {
    expect(resolveCredentialValue("$$literal")).toBe("$literal");
    expect(resolveCredentialValue("$!literal")).toBe("!literal");
  });
});

describe("resolveApiKey", () => {
  it("prefers the auth.json credential", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "xpl_from_auth" } }));
    process.env.EXPLABS_API_KEY = "xpl_from_env";

    expect(resolveApiKey({ authPath })).toEqual({ value: "xpl_from_auth", source: "auth.json" });
  });

  it("resolves an auth.json !command", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "!printf 'xpl_cmd\\n'" } }));

    expect(resolveApiKey({ authPath })).toEqual({ value: "xpl_cmd", source: "auth.json" });
  });

  it("returns the unresolved value when resolve is false", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "!printf 'xpl_cmd\\n'" } }));

    expect(resolveApiKey({ authPath, resolve: false })).toEqual({
      value: "!printf 'xpl_cmd\\n'",
      source: "auth.json",
    });
  });

  it("falls back to EXPLABS_API_KEY when auth.json has no entry", () => {
    writeAuth(JSON.stringify({ openrouter: { type: "api_key", key: "sk-or" } }));
    process.env.EXPLABS_API_KEY = "xpl_from_env";

    expect(resolveApiKey({ authPath })).toEqual({ value: "xpl_from_env", source: "env" });
  });

  it("falls back to EXPLABS_API_KEY when auth.json is missing", () => {
    process.env.EXPLABS_API_KEY = "xpl_from_env";

    expect(resolveApiKey({ authPath: missingPath() })).toEqual({
      value: "xpl_from_env",
      source: "env",
    });
  });

  it("falls back to EXPLABS_API_KEY when auth.json cannot be read", () => {
    writeAuth("{ not json");
    process.env.EXPLABS_API_KEY = "xpl_from_env";

    expect(resolveApiKey({ authPath })).toEqual({ value: "xpl_from_env", source: "env" });
  });

  it("reports no source when nothing is configured", () => {
    expect(resolveApiKey({ authPath })).toEqual({ value: "", source: "none" });
  });

  it("returns none when an auth.json command cannot be resolved", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "!exit 1" } }));

    expect(resolveApiKey({ authPath })).toEqual({ value: "", source: "none" });
  });

  it("prefers an explicit apiKey over everything else", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "xpl_from_auth" } }));
    process.env.EXPLABS_API_KEY = "xpl_from_env";

    expect(resolveApiKey({ apiKey: "xpl_from_config", authPath })).toEqual({
      value: "xpl_from_config",
      source: "config",
    });
  });

  it("keeps auth.json when apiKeyEnv is set explicitly", () => {
    writeAuth(JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "xpl_from_auth" } }));
    process.env.MY_CUSTOM_KEY = "xpl_custom";

    expect(resolveApiKey({ apiKeyEnv: "MY_CUSTOM_KEY", authPath })).toEqual({
      value: "xpl_from_auth",
      source: "auth.json",
    });
  });

  it("uses the apiKeyEnv variable when auth.json has no entry", () => {
    process.env.MY_CUSTOM_KEY = "xpl_custom";

    expect(resolveApiKey({ apiKeyEnv: "MY_CUSTOM_KEY", authPath })).toEqual({
      value: "xpl_custom",
      source: "env",
    });
  });

  it("reports no source when apiKeyEnv is set but unset", () => {
    process.env.MY_CUSTOM_KEY = "";

    expect(resolveApiKey({ apiKeyEnv: "MY_CUSTOM_KEY", authPath })).toEqual({
      value: "",
      source: "none",
    });
  });
});
