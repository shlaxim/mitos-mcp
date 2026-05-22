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
