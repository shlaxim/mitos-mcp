import type { ExtendedResponse, ServiceTitle } from "./mitos.js";

export interface LegalRule {
  rule_type?: string;
  rule_decision_number?: string;
  rule_decision_year?: string;
  rule_article?: string;
  rule_description?: string;
  rule_gazette_doc_number?: number;
  rule_gazette_doc_issue?: string;
  rule_ada?: string;
  rule_url?: string;
}
export interface LegalBasis {
  procedure_id: string;
  title?: string;
  rules: LegalRule[];
}

const RULE_KEYS: (keyof LegalRule)[] = [
  "rule_type",
  "rule_decision_number",
  "rule_decision_year",
  "rule_article",
  "rule_description",
  "rule_gazette_doc_number",
  "rule_gazette_doc_issue",
  "rule_ada",
  "rule_url",
];

/**
 * Extract structured legal-basis citations from a services-extended response.
 * Passes through only the verified MITOS fields; omits absent ones (e.g. rule_ada).
 * Never fabricates kodiko_url / law_id — those do not exist in the API.
 */
export function extractLegalBasis(id: string, ext: ExtendedResponse): LegalBasis {
  const metadata = ext.data?.metadata as Record<string, unknown> | undefined;
  const title = (ext.data?.title as ServiceTitle | undefined)?.el;
  const raw = metadata?.process_rules;
  const rules: LegalRule[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw as Record<string, unknown>[]) {
      const rule: LegalRule = {};
      for (const k of RULE_KEYS) {
        const v = r[k];
        if (v !== undefined && v !== null && v !== "") {
          (rule as Record<string, unknown>)[k] = v;
        }
      }
      rules.push(rule);
    }
  }
  return { procedure_id: id, title, rules };
}
