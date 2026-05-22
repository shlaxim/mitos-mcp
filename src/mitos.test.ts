import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./mitos.js";

test("normalize strips Greek accents and lowercases", () => {
  assert.equal(normalize("Φορολογία"), normalize("φορολογια"));
  assert.equal(normalize("ΑΔΕΙΑ"), "αδεια");
});

test("normalize handles dialytika", () => {
  assert.equal(normalize("προϊόν"), normalize("προιον"));
});

import { formatDuration } from "./mitos.js";

test("formatDuration parses ISO 8601 durations", () => {
  assert.equal(formatDuration("P3Y"), "3 years");
  assert.equal(formatDuration("P1M"), "1 month");
  assert.equal(formatDuration("P10D"), "10 days");
  assert.equal(formatDuration("PT2H30M"), "2 hours, 30 minutes");
});

test("formatDuration returns undefined for undefined input", () => {
  assert.equal(formatDuration(undefined), undefined);
});

test("formatDuration returns the raw string when unparseable", () => {
  assert.equal(formatDuration("not-a-duration"), "not-a-duration");
});
