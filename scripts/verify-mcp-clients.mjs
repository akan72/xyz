// Verify the server with official clients installed outside the application:
// node scripts/verify-mcp-clients.mjs http://127.0.0.1:8787 /tmp/xyz-mcp-interop
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [origin, sdkRoot] = process.argv.slice(2);
if (!origin || !sdkRoot) throw new Error("Supply a Worker origin and the official clients' installation directory");
const requireSdk = createRequire(resolve(sdkRoot, "package.json"));
const load = async specifier => {
    const module = await import(pathToFileURL(requireSdk.resolve(specifier)).href);
    return module.default ?? module;
};
const {Client: ClientV1} = await load("@modelcontextprotocol/sdk/client/index.js");
const {StreamableHTTPClientTransport: TransportV1} = await load("@modelcontextprotocol/sdk/client/streamableHttp.js");
const {Client: ClientV2, StreamableHTTPClientTransport: TransportV2} = await load("@modelcontextprotocol/client");

for (const [sdk, Client, Transport] of [["v1", ClientV1, TransportV1], ["v2", ClientV2, TransportV2]]) {
    const client = new Client({name: "alexkan-interop-check", version: "1.0.0"});
    try {
        await client.connect(new Transport(new URL("/mcp", origin)));
        assert.equal(client.getServerVersion().name, "alexkan.xyz");
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map(tool => tool.name), ["list_pages", "read_page"]);
        const listing = await client.callTool({name: "list_pages", arguments: {}});
        assert.equal(listing.isError, false);
        const catalog = JSON.parse(listing.content[0].text);
        assert.ok(catalog.pages.some(page => page.path === "/docs"));
        for (const page of catalog.pages) {
            const result = await client.callTool({name: "read_page", arguments: {path: page.path}});
            assert.equal(result.isError, false);
            assert.ok(result.content[0].text.includes("Source: " + page.url));
        }
        const denied = await client.callTool({name: "read_page", arguments: {path: "/api/vesta"}});
        assert.equal(denied.isError, true);
        console.log(JSON.stringify({sdk, initialized: true, tools: tools.tools.map(tool => tool.name), pagesRead: catalog.pages.length, privateApiDenied: true}));
    } finally {
        await client.close();
    }
}
