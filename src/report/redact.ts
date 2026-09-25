// src/report/redact.ts — §9.5 redaction
//
// Applied at the SERIALIZATION BOUNDARY, not sprinkled at call sites (§9.5). Any text
// about to be written to the report, the ledger, a log file, or sent to a model passes
// through `redact()` first.
//
// This is a hard invariant, not a nicety: secrets from repo files, test output, or
// guide text must never be persisted or transmitted.

/** A match found by the redactor, for the report's redaction appendix. */
export interface RedactionHit {
  /** The pattern family that matched, e.g. "aws-access-key". */
  kind: string;
  /** Never the secret itself — a stable hash prefix, so counts can be reconciled. */
  fingerprint: string;
}

export const REDACTED = "[REDACTED]";

interface Rule {
  kind: string;
  re: RegExp;
}

const RULES: Rule[] = [
  // Private key headers (PEM) — the whole block, since partial redaction leaks.
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // GitHub tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ and fine-grained github_pat_.
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // AWS access key ids and secret-ish assignments.
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret", re: /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  // Bearer / Basic tokens in headers or env.
  { kind: "bearer-token", re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  // .env-style assignments: SECRET_KEY=value, api_key = "value"
  {
    kind: "env-assignment",
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
  },
  // Generic provider keys that are recognisable by prefix.
  { kind: "sk-token", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Long base64 blob adjacent to a secret-ish key.
  { kind: "secret-blob", re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
];

/** Stable, non-reversible fingerprint so repeated hits can be counted without storing the secret. */
function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 8);
}

export interface RedactResult {
  text: string;
  hits: RedactionHit[];
}

/** Redact a single string, reporting what was removed. */
export function redactWithReport(input: string): RedactResult {
  let text = input;
  const hits: RedactionHit[] = [];

  for (const rule of RULES) {
    // Fresh regex per call: the shared ones are /g and carry lastIndex between uses.
    const re = new RegExp(rule.re.source, rule.re.flags);
    text = text.replace(re, (match: string) => {
      hits.push({ kind: rule.kind, fingerprint: fingerprint(match) });
      // Keep the KEY (e.g. GITHUB_TOKEN=) so the report stays readable and useful.
      const eq = match.search(/[:=]/);
      if (eq >= 0 && /[A-Za-z_]/.test(match.slice(0, eq))) {
        return `${match.slice(0, eq + 1)}${REDACTED}`;
      }
      return REDACTED;
    });
  }

  return { text, hits };
}

/** Redact for the serialization boundary. */
export function redact(input: string): string {
  return redactWithReport(input).text;
}
