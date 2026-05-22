import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLegalBasis } from "./tools.js";
import type { ExtendedResponse } from "./mitos.js";

const fixture: ExtendedResponse = {
  success: true,
  data: {
    title: { el: "Αποδεικτικό φορολογικής ενημερότητας" },
    metadata: {
      process_rules: [
        {
          rule_type: "Νόμος",
          rule_decision_number: "5222",
          rule_decision_year: "2025",
          rule_article: "216",
          rule_description: "Αποδεικτικό ενημερότητας",
          rule_gazette_doc_number: 134,
          rule_gazette_doc_issue: "Α",
          rule_ada: "Ρ7ΩΗ46ΜΠ3Ζ-19Γ",
          rule_url: "https://example.gr/a.pdf",
        },
        {
          rule_type: "Νόμος",
          rule_decision_number: "5104",
          rule_decision_year: "2024",
          rule_article: "12",
          rule_description: "Αποδεικτικό ενημερότητας και βεβαίωση οφειλής",
          rule_gazette_doc_number: 58,
          rule_gazette_doc_issue: "Α",
          rule_url: "https://example.gr/b.pdf",
        },
      ],
    },
  },
};

test("extractLegalBasis returns structured rules with verified shapes", () => {
  const out = extractLegalBasis("439993", fixture);
  assert.equal(out.procedure_id, "439993");
  assert.equal(out.title, "Αποδεικτικό φορολογικής ενημερότητας");
  assert.equal(out.rules.length, 2);
  assert.equal(out.rules[0].rule_gazette_doc_number, 134); // number preserved
  assert.equal(out.rules[0].rule_ada, "Ρ7ΩΗ46ΜΠ3Ζ-19Γ");
});

test("extractLegalBasis omits absent optional rule_ada", () => {
  const out = extractLegalBasis("439993", fixture);
  assert.equal("rule_ada" in out.rules[1], false);
});

test("extractLegalBasis handles missing process_rules", () => {
  const empty: ExtendedResponse = { success: true, data: { metadata: {} } };
  const out = extractLegalBasis("1", empty);
  assert.deepEqual(out.rules, []);
});

import { filterByTitle } from "./tools.js";
import type { ServiceListItem } from "./mitos.js";

const services: ServiceListItem[] = [
  { id: "1", title: { el: "Φορολογία πολιτών", en: "Citizen taxation" }, ns: "", last_updated: "" },
  { id: "2", title: { el: "Άδεια οδήγησης", en: "Driving licence" }, ns: "", last_updated: "" },
];

test("filterByTitle matches Greek accent-insensitively", () => {
  assert.deepEqual(filterByTitle(services, "φορολογια", "el").map((s) => s.id), ["1"]);
});

test("filterByTitle matches English when language=en", () => {
  assert.deepEqual(filterByTitle(services, "driving", "en").map((s) => s.id), ["2"]);
});

test("filterByTitle searches both languages by default", () => {
  assert.deepEqual(filterByTitle(services, "licence", "both").map((s) => s.id), ["2"]);
});
