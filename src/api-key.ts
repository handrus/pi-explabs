/**
 * API key resolution for the Experiential Labs extension.
 *
 * Keys are read from pi's credential store (`~/.pi/agent/auth.json`) first,
 * falling back to the `EXPLABS_API_KEY` environment variable.
 *
 * @packageDocumentation
 */

import { execFileSync } from "child_process";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import Debug from "debug";

const debug = Debug("pi-explabs");

/** Provider id used for the pi credential store entry and the registered provider */
export const PROVIDER_ID = "explabs";

/** Timeout for `!command` credential resolution */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Matches credential escapes and environment references: `$$`, `$!`, `${VAR}` and `$VAR`
 */
const ENV_REFERENCE = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Where a resolved API key came from, for diagnostics */
export type ApiKeySource = "config" | "auth.json" | "env" | "none";

/** Outcome of API key resolution */
export interface ResolvedApiKey {
  /** The value as pi should receive it: a literal, `$ENV_VAR` reference, or `!command` */
  value: string;
  /** Where `value` came from */
  source: ApiKeySource;
}

/**
 * Reads the raw `explabs` API key entry from pi's `auth.json`.
 *
 * The returned value is *not* resolved: it may be a literal, a `$ENV_VAR`
 * reference, or a `!command` (see {@link resolveCredentialValue}). Returns
 * `undefined` when the file, the entry, or a usable `key` is missing.
 *
 * @param authPath - Optional path to `auth.json`, defaults to pi's agent dir
 */
export function readAuthJsonApiKey(authPath?: string): string | undefined {
  const credential = readStoredCredential(PROVIDER_ID, authPath);

  if (!credential || credential.type !== "api_key") {
    debug("no api_key credential for %s in auth.json", PROVIDER_ID);
    return undefined;
  }

  const key = credential.key?.trim();
  if (!key) {
    debug("empty api_key credential for %s in auth.json", PROVIDER_ID);
    return undefined;
  }

  return key;
}

/**
 * Resolves a credential value the same way pi does.
 *
 * - A leading `!` runs the remainder as a shell command and uses its stdout
 * - `$VAR` / `${VAR}` references are interpolated from the environment
 * - `$$` escapes a literal `$` and `$!` escapes a literal `!`
 * - Anything else is a literal
 *
 * @returns The resolved value, or `undefined` when it cannot be resolved
 */
export function resolveCredentialValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("!")) {
    return runCredentialCommand(trimmed.slice(1));
  }

  return interpolateEnv(trimmed);
}

/**
 * Runs a `!command` credential and returns its trimmed standard output
 */
function runCredentialCommand(command: string): string | undefined {
  try {
    const stdout = execFileSync("/bin/sh", ["-c", command], {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value = stdout.trim();
    if (!value) {
      debug("credential command produced no output");
      return undefined;
    }
    return value;
  } catch (error) {
    debug("credential command failed: %s", error instanceof Error ? error.message : error);
    return undefined;
  }
}

/**
 * Interpolates `$VAR` / `${VAR}` references from the process environment,
 * unescaping `$$` and `$!`
 */
function interpolateEnv(value: string): string | undefined {
  let missing = false;

  const result = value.replace(ENV_REFERENCE, (match, braced?: string, bare?: string) => {
    // "$$" escapes a literal "$" and "$!" escapes a literal "!"
    if (match === "$$" || match === "$!") {
      return match.slice(1);
    }

    const name = braced ?? bare;
    const envValue = name ? process.env[name] : undefined;
    if (envValue === undefined) {
      missing = true;
      return match;
    }
    return envValue;
  });

  if (missing) {
    debug("credential references an undefined environment variable");
    return undefined;
  }

  return result;
}

/**
 * Resolves the API key.
 *
 * Precedence: explicit config, then the `auth.json` credential, then the
 * environment variable.
 *
 * @param options.apiKey - Explicit key from extension config, wins over everything
 * @param options.apiKeyEnv - Environment variable name used as the fallback, defaults to `EXPLABS_API_KEY`
 * @param options.authPath - Optional `auth.json` path, defaults to pi's agent dir
 * @param options.resolve - Set `false` to get the unresolved value
 */
export function resolveApiKey(options?: {
  apiKey?: string;
  apiKeyEnv?: string;
  authPath?: string;
  resolve?: boolean;
}): ResolvedApiKey {
  const { apiKey, apiKeyEnv = "EXPLABS_API_KEY", authPath, resolve = true } = options ?? {};

  // Explicit config wins, e.g. `createExplabsExtension({ apiKey: "xpl_..." })`
  if (apiKey) {
    return finish({ value: apiKey, source: "config" }, resolve);
  }

  const stored = readAuthJsonApiKey(authPath);
  if (stored) {
    return finish({ value: stored, source: "auth.json" }, resolve);
  }

  return finish({ value: process.env[apiKeyEnv] ?? "", source: "env" }, resolve);
}

/**
 * Optionally resolves a result to a plain value, dropping unresolved ones
 */
function finish(result: ResolvedApiKey, resolve: boolean): ResolvedApiKey {
  if (!resolve) {
    return result;
  }

  if (result.source === "env" && result.value) {
    // Environment values are already literal
    return result;
  }

  const resolved = resolveCredentialValue(result.value);
  return resolved ? { value: resolved, source: result.source } : { value: "", source: "none" };
}
