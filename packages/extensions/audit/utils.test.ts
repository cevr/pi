import { describe, expect, it } from "bun:test";
import { parseConcernsJson, parseFindingsJson, PHASE_MARKERS } from "./utils";

describe("parseConcernsJson", () => {
  it("parses fenced JSON block", () => {
    const text = `Here are the concerns:
\`\`\`json
{"concerns": [{"name": "correctness", "description": "Bug audit", "skills": ["code-review"]}]}
\`\`\`
CONCERNS_DETECTED`;
    const result = parseConcernsJson(text);
    expect(result).toEqual([
      { name: "correctness", description: "Bug audit", skills: ["code-review"] },
    ]);
  });

  it("parses bare JSON", () => {
    const text = `I found these: {"concerns": [{"name": "frontend", "description": "React patterns", "skills": []}]} CONCERNS_DETECTED`;
    const result = parseConcernsJson(text);
    expect(result).toEqual([{ name: "frontend", description: "React patterns", skills: [] }]);
  });

  it("returns null for no JSON found", () => {
    expect(parseConcernsJson("just some text CONCERNS_DETECTED")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const text = '```json\n{"concerns": [invalid]}\n```\nCONCERNS_DETECTED';
    expect(parseConcernsJson(text)).toBeNull();
  });

  it("returns empty array for empty concerns list", () => {
    const text = '```json\n{"concerns": []}\n```\nCONCERNS_DETECTED';
    expect(parseConcernsJson(text)).toEqual([]);
  });

  it("filters out entries with missing name/description", () => {
    const text = `\`\`\`json
{"concerns": [
  {"name": "valid", "description": "ok", "skills": ["a"]},
  {"name": "no-desc"},
  {"description": "no-name"},
  {"name": "also-valid", "description": "yep"}
]}
\`\`\``;
    const result = parseConcernsJson(text);
    expect(result).toEqual([
      { name: "valid", description: "ok", skills: ["a"] },
      { name: "also-valid", description: "yep", skills: [] },
    ]);
  });

  it("handles missing skills field gracefully", () => {
    const text = '```json\n{"concerns": [{"name": "x", "description": "y"}]}\n```';
    const result = parseConcernsJson(text);
    expect(result).toEqual([{ name: "x", description: "y", skills: [] }]);
  });

  it("filters non-string skills", () => {
    const text =
      '```json\n{"concerns": [{"name": "x", "description": "y", "skills": ["a", 123, "b"]}]}\n```';
    const result = parseConcernsJson(text);
    expect(result?.[0]?.skills).toEqual(["a", "b"]);
  });
});

describe("parseFindingsJson", () => {
  it("parses fenced JSON block", () => {
    const text = `Here are the findings:
\`\`\`json
{"findings": [{"file": "src/app.tsx", "description": "Missing null check", "severity": "critical"}]}
\`\`\`
AUDIT_COMPLETE`;
    const result = parseFindingsJson(text);
    expect(result).toEqual([
      { file: "src/app.tsx", description: "Missing null check", severity: "critical" },
    ]);
  });

  it("parses bare JSON", () => {
    const text = `Found: {"findings": [{"file": "a.ts", "description": "unused import", "severity": "warning"}]} AUDIT_COMPLETE`;
    const result = parseFindingsJson(text);
    expect(result).toEqual([{ file: "a.ts", description: "unused import", severity: "warning" }]);
  });

  it("returns null for no JSON found", () => {
    expect(parseFindingsJson("just text AUDIT_COMPLETE")).toBeNull();
  });

  it("returns empty array for empty findings", () => {
    const text = '```json\n{"findings": []}\n```\nAUDIT_COMPLETE';
    expect(parseFindingsJson(text)).toEqual([]);
  });

  it("defaults severity to warning for invalid values", () => {
    const text =
      '```json\n{"findings": [{"file": "a.ts", "description": "x", "severity": "invalid"}]}\n```';
    const result = parseFindingsJson(text);
    expect(result?.[0]?.severity).toBe("warning");
  });

  it("defaults severity to warning when missing", () => {
    const text = '```json\n{"findings": [{"file": "a.ts", "description": "x"}]}\n```';
    const result = parseFindingsJson(text);
    expect(result?.[0]?.severity).toBe("warning");
  });
});

describe("PHASE_MARKERS", () => {
  it("detects phase markers case-insensitively", () => {
    expect(PHASE_MARKERS.detecting.test("CONCERNS_DETECTED")).toBe(true);
    expect(PHASE_MARKERS.detecting.test("concerns_detected")).toBe(true);
    expect(PHASE_MARKERS.auditing.test("AUDITING_COMPLETE")).toBe(true);
    expect(PHASE_MARKERS.synthesizing.test("AUDIT_COMPLETE")).toBe(true);
    expect(PHASE_MARKERS.findingFixed.test("FINDING_FIXED")).toBe(true);
    expect(PHASE_MARKERS.findingSkip.test("FINDING_SKIP")).toBe(true);
    expect(PHASE_MARKERS.fixGatePass.test("FIX_GATE_PASS")).toBe(true);
    expect(PHASE_MARKERS.fixGateFail.test("FIX_GATE_FAIL")).toBe(true);
    expect(PHASE_MARKERS.fixCounselPass.test("FIX_COUNSEL_PASS")).toBe(true);
    expect(PHASE_MARKERS.fixCounselFail.test("FIX_COUNSEL_FAIL")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(PHASE_MARKERS.detecting.test("no match here")).toBe(false);
  });
});
