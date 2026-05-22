// Live smoke test: starts nothing — assumes the server is already running.
// Usage: MITOS_MCP_AUTH_TOKEN=<t> PORT=8743 node scripts/smoke.mjs
const PORT = process.env.PORT ?? 8743;
const TOKEN = process.env.MITOS_MCP_AUTH_TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;

if (!TOKEN) {
  console.error("Set MITOS_MCP_AUTH_TOKEN to the server's token.");
  process.exit(1);
}

async function rpc(method, params, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  const text = await res.text();
  // Streamable HTTP may return SSE; extract the JSON data line if so.
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  const json = JSON.parse(line.replace(/^data:\s*/, ""));
  if (json.error) throw new Error(`${method} -> ${JSON.stringify(json.error)}`);
  return json.result;
}

let ok = 0, fail = 0;
function check(name, cond) {
  if (cond) { ok++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// 1. health (unauthenticated)
const health = await fetch(`${BASE}/health`).then((r) => r.json());
check("health is ok", health.status === "ok");

// 2. unauthorized /mcp is rejected
const unauth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 0 }),
});
check("unauthorized /mcp -> 401", unauth.status === 401);

// 3. tools/list returns all 5
const list = await rpc("tools/list", {}, 1);
check("tools/list returns 5 tools", list.tools.length === 5);

// 4. search_procedures
const search = await rpc("tools/call", { name: "search_procedures", arguments: { query: "φορολογ" } }, 2);
check("search_procedures returns text", typeof search.content?.[0]?.text === "string" && search.content[0].text.length > 0);

// 5. get_legal_basis_articles returns valid JSON with rules
const legal = await rpc("tools/call", { name: "get_legal_basis_articles", arguments: { procedure_id: "439993" } }, 3);
const parsed = JSON.parse(legal.content[0].text);
check("get_legal_basis_articles returns rules array", Array.isArray(parsed.rules) && parsed.rules.length > 0);
check("legal rule has rule_type", typeof parsed.rules[0].rule_type === "string");

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
