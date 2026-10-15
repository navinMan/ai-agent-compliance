import { z } from "zod";

// Zod Schema for input payload validation
export const ToolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).or(z.string()),
  result: z.unknown().optional(),
});

export const AgentLogPayloadSchema = z.object({
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
  output: z.string(),
  toolCalls: z.array(ToolCallSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export interface AgentLogPayload {
  agentId?: string;
  agentName?: string;
  model?: string;
  prompt: string;
  output: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
}

export type RiskLevel = "Low" | "Medium" | "High" | "Unacceptable";

export type ViolationType =
  | "PII_LEAK"
  | "PROMPT_INJECTION"
  | "ROGUE_TOOL"
  | "BOUNDARY_ESCAPE";

export interface ComplianceViolation {
  type: ViolationType;
  severity: RiskLevel;
  description: string;
  snippet?: string;
  location: "prompt" | "output" | "toolCalls";
  isoControl: string;
}

export interface PIIDetection {
  type: "SSN" | "CREDIT_CARD" | "EMAIL" | "PHONE";
  masked: string;
  raw: string;
  location: "prompt" | "output" | "toolCalls";
}

export interface EvaluationReport {
  id: string;
  agentId: string;
  agentName: string;
  model: string;
  timestamp: string;
  riskScore: RiskLevel;
  compliancePassed: boolean;
  iso42001Controls: string[];
  violations: ComplianceViolation[];
  piiFound: PIIDetection[];
  flaggedPII: boolean;
  flaggedPromptInjection: boolean;
  flaggedRogueTool: boolean;
  prompt: string;
  output: string;
  sanitizedOutput: string;
  sanitizedPrompt: string;
  auditSummary: string;
}

// ==========================================
// 1. PII VALIDATORS & DETECTION
// ==========================================

// Luhn Algorithm check for credit cards
function isValidLuhn(cardNumber: string): boolean {
  const digitsOnly = cardNumber.replace(/\D/g, "");
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;

  let sum = 0;
  let alternate = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = parseInt(digitsOnly.charAt(i), 10);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Regex patterns
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_REGEX = /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b/g;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function scanForPII(
  text: string,
  location: "prompt" | "output" | "toolCalls"
): PIIDetection[] {
  const detections: PIIDetection[] = [];

  // Email check
  const emails = text.match(EMAIL_REGEX) || [];
  for (const email of emails) {
    const isZodValidEmail = z.string().email().safeParse(email).success;
    if (isZodValidEmail) {
      const parts = email.split("@");
      const name = parts[0] || "";
      const domain = parts[1] || "";
      const masked = `${name.slice(0, 2)}***@${domain}`;
      detections.push({ type: "EMAIL", masked, raw: email, location });
    }
  }

  // SSN check
  const ssns = text.match(SSN_REGEX) || [];
  for (const ssn of ssns) {
    const digits = ssn.replace(/\D/g, "");
    if (digits.length === 9) {
      const masked = `***-**-${digits.slice(-4)}`;
      detections.push({ type: "SSN", masked, raw: ssn, location });
    }
  }

  // Credit Card check with Luhn algorithm
  const cards = text.match(CREDIT_CARD_REGEX) || [];
  for (const card of cards) {
    if (isValidLuhn(card)) {
      const digits = card.replace(/\D/g, "");
      const masked = `****-****-****-${digits.slice(-4)}`;
      detections.push({ type: "CREDIT_CARD", masked, raw: card, location });
    }
  }

  // Phone check
  const phones = text.match(PHONE_REGEX) || [];
  for (const phone of phones) {
    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length >= 10 && cleanPhone.length <= 15) {
      const masked = `(***) ***-${cleanPhone.slice(-4)}`;
      detections.push({ type: "PHONE", masked, raw: phone, location });
    }
  }

  return detections;
}

export function maskPIIText(text: string, piiList: PIIDetection[]): string {
  let result = text;
  for (const item of piiList) {
    result = result.replaceAll(item.raw, `[REDACTED_${item.type}: ${item.masked}]`);
  }
  return result;
}

// ==========================================
// 2. PROMPT INJECTION & BOUNDARY ESCAPES
// ==========================================

const CRITICAL_INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior)\s+instructions\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior)\s+commands\b/i,
  /\boverride\s+(system\s+prompt|guardrails|safety\s+filter)\b/i,
  /\bbypass\s+(security|guardrails|content\s+filter)\b/i,
  /\bDAN\s+mode\b/i,
  /\bdeveloper\s+mode\s+(enabled|activated|on)\b/i,
  /\byou\s+are\s+now\s+unrestricted\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bpretend\s+you\s+have\s+no\s+rules\b/i,
  /\breveal\s+(your\s+)?(hidden|secret|initial|system)\s+instructions\b/i,
];

const DELIMITER_BOUNDARY_PATTERNS = [
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[SYSTEM\]/i,
  /\[\/SYSTEM\]/i,
  /---BEGIN SYSTEM PROMPT---/i,
  /<<SYS>>/i,
  /"""\s*system\b/i,
];

const ROGUE_TOOL_NAMES = [
  "exec",
  "execute_shell",
  "bash",
  "sh",
  "eval",
  "system_command",
  "delete_database",
  "drop_table",
  "format_drive",
  "arbitrary_sql",
  "raw_sql",
  "sudo",
  "rm_rf",
];

const ROGUE_ARGUMENT_PATTERNS = [
  /rm\s+-rf/i,
  /drop\s+database/i,
  /drop\s+table/i,
  /truncate\s+table/i,
  /;\s*--/i,
  /UNION\s+SELECT/i,
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,
  /curl\s+.*\|\s*bash/i,
  /chmod\s+777/i,
];

export function scanForPromptInjections(
  text: string,
  location: "prompt" | "output"
): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];

  for (const pattern of CRITICAL_INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push({
        type: "PROMPT_INJECTION",
        severity: "High",
        description: `Prompt injection attack pattern detected: "${match[0]}"`,
        snippet: match[0],
        location,
        isoControl: "ISO 42001 Control A.7.3 (Input Safeguards & Adversarial Defense)",
      });
    }
  }

  for (const pattern of DELIMITER_BOUNDARY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push({
        type: "BOUNDARY_ESCAPE",
        severity: "Unacceptable",
        description: `System delimiter injection / boundary escape tag detected: "${match[0]}"`,
        snippet: match[0],
        location,
        isoControl: "ISO 42001 Control A.7.3 (Boundary Integrity)",
      });
    }
  }

  // Base64 hidden command inspection
  const base64Matches = text.match(/\b(?:[A-Za-z0-9+/]{28,}={0,2})\b/g) || [];
  for (const b64 of base64Matches) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      for (const pattern of CRITICAL_INJECTION_PATTERNS) {
        if (pattern.test(decoded)) {
          violations.push({
            type: "PROMPT_INJECTION",
            severity: "Unacceptable",
            description: `Obfuscated Base64 prompt injection payload detected`,
            snippet: b64,
            location,
            isoControl: "ISO 42001 Control A.7.3 (Obfuscated Adversarial Payloads)",
          });
        }
      }
    } catch {
      // Not valid base64 string, skip
    }
  }

  return violations;
}

export function scanToolCalls(toolCalls: ToolCall[]): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];

  for (const tool of toolCalls) {
    const nameLower = tool.name.toLowerCase();

    // Check dangerous tool name
    if (ROGUE_TOOL_NAMES.some((rogue) => nameLower.includes(rogue))) {
      violations.push({
        type: "ROGUE_TOOL",
        severity: "Unacceptable",
        description: `Rogue or prohibited system execution tool invoked: "${tool.name}"`,
        snippet: tool.name,
        location: "toolCalls",
        isoControl: "ISO 42001 Control A.9.1 (Autonomous Action Boundaries)",
      });
    }

    // Check arguments stringified
    const argsString =
      typeof tool.arguments === "string"
        ? tool.arguments
        : JSON.stringify(tool.arguments);

    for (const pattern of ROGUE_ARGUMENT_PATTERNS) {
      const match = argsString.match(pattern);
      if (match) {
        violations.push({
          type: "ROGUE_TOOL",
          severity: "Unacceptable",
          description: `Destructive / unauthorized payload pattern in tool arguments: "${match[0]}"`,
          snippet: argsString.slice(0, 100),
          location: "toolCalls",
          isoControl: "ISO 42001 Control A.9.1 (Action Parameter Validation)",
        });
      }
    }
  }

  return violations;
}

// ==========================================
// 3. ISO 42001 COMPLIANCE EVALUATION
// ==========================================

export function evaluateCompliance(payload: AgentLogPayload): EvaluationReport {
  // Validate with Zod
  const validated = AgentLogPayloadSchema.parse(payload);

  const piiInPrompt = scanForPII(validated.prompt, "prompt");
  const piiInOutput = scanForPII(validated.output, "output");
  const toolCallsString = JSON.stringify(validated.toolCalls);
  const piiInTools = scanForPII(toolCallsString, "toolCalls");

  const allPII = [...piiInPrompt, ...piiInOutput, ...piiInTools];

  const violations: ComplianceViolation[] = [];

  // Add PII violations
  for (const pii of allPII) {
    const isCritical = pii.type === "SSN" || pii.type === "CREDIT_CARD";
    violations.push({
      type: "PII_LEAK",
      severity: isCritical ? "High" : "Medium",
      description: `Unredacted ${pii.type} detected in agent ${pii.location}: ${pii.masked}`,
      snippet: pii.masked,
      location: pii.location,
      isoControl: "ISO 42001 Control A.8.4 (Privacy & Personal Data Governance)",
    });
  }

  // Prompt injection scans
  const promptViolations = scanForPromptInjections(validated.prompt, "prompt");
  const outputViolations = scanForPromptInjections(validated.output, "output");
  violations.push(...promptViolations, ...outputViolations);

  // Tool calls scans
  const toolViolations = scanToolCalls(validated.toolCalls);
  violations.push(...toolViolations);

  // Determine overall ISO 42001 Risk Classification
  let riskScore: RiskLevel = "Low";
  if (violations.some((v) => v.severity === "Unacceptable")) {
    riskScore = "Unacceptable";
  } else if (violations.some((v) => v.severity === "High")) {
    riskScore = "High";
  } else if (violations.some((v) => v.severity === "Medium")) {
    riskScore = "Medium";
  }

  // Sanitized output & prompt
  const sanitizedOutput = maskPIIText(validated.output, piiInOutput);
  const sanitizedPrompt = maskPIIText(validated.prompt, piiInPrompt);

  const controlsSet = new Set<string>();
  for (const v of violations) {
    controlsSet.add(v.isoControl);
  }
  if (controlsSet.size === 0) {
    controlsSet.add("ISO 42001 Control A.6.2.2 (Standard Baseline Conformance)");
  }

  const flaggedPII = allPII.length > 0;
  const flaggedPromptInjection = violations.some(
    (v) => v.type === "PROMPT_INJECTION" || v.type === "BOUNDARY_ESCAPE"
  );
  const flaggedRogueTool = violations.some((v) => v.type === "ROGUE_TOOL");

  const compliancePassed = riskScore === "Low";

  const auditSummary = compliancePassed
    ? "Clean evaluation: No PII, prompt injections, or rogue actions detected. Compliant with ISO 42001 & EU AI Act standards."
    : `Evaluated with ${riskScore} Risk. Flagged ${violations.length} violation(s): ${violations
        .map((v) => v.type)
        .filter((val, i, arr) => arr.indexOf(val) === i)
        .join(", ")}.`;

  return {
    id: `eval_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: validated.agentId || "agent_default_01",
    agentName: validated.agentName || "General GRC Agent",
    model: validated.model || "gpt-4o",
    timestamp: new Date().toISOString(),
    riskScore,
    compliancePassed,
    iso42001Controls: Array.from(controlsSet),
    violations,
    piiFound: allPII,
    flaggedPII,
    flaggedPromptInjection,
    flaggedRogueTool,
    prompt: validated.prompt,
    output: validated.output,
    sanitizedOutput,
    sanitizedPrompt,
    auditSummary,
  };
}
