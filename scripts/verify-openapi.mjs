// Validate the public contract and live responses with independent validators.
// node scripts/verify-openapi.mjs ORIGIN /tmp/xyz-openapi-interop
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { renameSync } from "node:fs";
const [origin, validatorRoot] = process.argv.slice(2);
if (!origin || !validatorRoot) throw new Error("Supply origin and temporary validator package directory");
const require = createRequire(resolve(validatorRoot, "package.json"));
const SwaggerParser = require("@apidevtools/swagger-parser");
const Ajv2020 = require("ajv/dist/2020").default;
const request = (path, options = {}) => fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(15000) });
const response = await request("/openapi.json");
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /application\/json/);
const spec = await SwaggerParser.validate(await response.json());
assert.equal(spec.openapi, "3.1.1");
assert.deepEqual(spec.security, []);
assert.equal(new URL(spec.servers[0].url, origin).origin, new URL(origin).origin);
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = Object.fromEntries(Object.entries(spec.components.schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
function validate(name, body) {
    assert.ok(validators[name](body), `${name}: ${JSON.stringify(validators[name].errors)}`);
}
const catalog = await (await request("/api/pages")).json();
validate("Catalog", catalog);
let checked = 0;
for (const [path, schema] of [["/api", "Discovery"], ["/api/pages", "Catalog"], ...catalog.pages.map(page => [`/api/page?path=${encodeURIComponent(page.path)}`, "PageContent"])]) {
    const res = await request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.match(res.headers.get("link"), /openapi.json.*service-desc/);
    const body = await res.json();
    validate(schema, body);
    if (schema === "PageContent") {
        assert.deepEqual(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "markdown")), catalog.pages.find(page => page.path === body.path));
        assert.equal(body.markdown, await (await request(body.markdownPath)).text());
    }
    const head = await request(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), res.headers.get("content-type"));
    assert.equal(await head.text(), "");
    checked++;
}
const errors = [
    ["/api?unknown=1", 400, "invalid_query"], ["/api/pages?path=/", 400, "invalid_query"],
    ["/api/page", 400, "invalid_query"], ["/api/page?path=projects", 400, "invalid_query"],
    ["/api/page?path=/&path=/docs", 400, "invalid_query"], ["/api/page?path=/&other=1", 400, "invalid_query"],
    ["/api/page?path=https%3A%2F%2Fexample.com%2F", 400, "invalid_query"],
    ...["/missing", "/api/vesta", "/404", "/assets/cig.jpg", "/../contact", "/projects/"].map(path => [`/api/page?path=${encodeURIComponent(path)}`, 404, "not_found"]),
    ["/api/missing", 404, "not_found"],
    ...["/api", "/api/pages", "/api/page?path=/"].flatMap(path => ["POST", "PUT", "DELETE", "OPTIONS"].map(method => [path, 405, "method_not_allowed", method])),
];
for (const [path, status, code, method = "GET"] of errors) {
    const res = await request(path, { method, headers: { Accept: "text/html" } });
    assert.equal(res.status, status, path);
    assert.match(res.headers.get("content-type"), /^application\/problem\+json/);
    const body = await res.json();
    validate("Problem", body);
    assert.equal(body.status, status);
    assert.equal(body.code, code);
    assert.equal(body.message, body.detail);
    assert.equal(body.instance, new URL(path, origin).pathname);
    assert.ok(body.hint.length >= 20);
    if (status === 405) assert.equal(res.headers.get("allow"), "GET, HEAD");
    if (method === "GET") {
        const head = await request(path, { method: "HEAD" });
        assert.equal(head.status, status);
        assert.match(head.headers.get("content-type"), /^application\/problem\+json/);
        assert.equal(await head.text(), "");
    }
    checked++;
}
for (const path of ["/api/vesta", "/api/vesta/anything"]) {
    const retired = await request(path);
    assert.equal(retired.status, 404);
    assert.equal(await retired.text(), "");
}
if (process.argv.includes("--fault-injection")) {
    assert.equal(new URL(origin).hostname, "127.0.0.1", "Fault injection is only for the local Worker");
    for (const [file, path] of [["dist/agent-catalog.json", "/api/pages"], ["dist/projects.md", "/api/page?path=%2Fprojects"]]) {
        const backup = `${file}.fault-backup`;
        renameSync(file, backup);
        try {
            const res = await request(path);
            assert.equal(res.status, 503);
            assert.match(res.headers.get("content-type"), /^application\/problem\+json/);
            const body = await res.json();
            validate("Problem", body);
            assert.equal(body.code, "content_unavailable");
            assert.equal(body.status, 503);
            assert.match(body.hint, /Retry later/);
            assert.ok(!JSON.stringify(body).includes(file));
        } finally {
            renameSync(backup, file);
        }
        assert.equal((await request(path)).status, 200, "Content recovers after restoring the asset");
    }
    console.log("Local fault injection verified structured 503s for unavailable catalog and Markdown, with recovery.");
}
console.log(`OpenAPI 3.1.1 validated; ${checked} success/error scenarios and corresponding HEAD responses passed, including ${catalog.pages.length} published pages.`);
