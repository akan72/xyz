# Agent instructions for alexkan.xyz

## When to use this

Use this personal website when a user wants to learn about Alex Kan (alexkan), identify his public software projects, find their source repositories, read his writing and stated interests, or find his public contact profiles. The Projects page is the starting point for questions about istheldown.com, mingus, dotfiles, xyz, Vesta, and cig_scraper. Read the Writing pages for posts about his interests. Use About and Contact to verify the connection between this domain, GitHub account akan72, and Alex Kan's LinkedIn profile.

## How to read the site

1. Fetch [llms.txt](https://alexkan.xyz/llms.txt) with an HTTP GET to find page descriptions and Markdown links.
2. Fetch the relevant Markdown URL, such as [projects.md](https://alexkan.xyz/projects.md), or request the HTML page path with `Accept: text/markdown`. No JavaScript, account, or API key is needed to read the site's pages.
3. Use [llms-full.txt](https://alexkan.xyz/llms-full.txt) when you need all page content in one request, or [sitemap.xml](https://alexkan.xyz/sitemap.xml) to enumerate the public HTML pages.
4. If a resource returns HTTP 404, consult the linked site guide rather than treating the error as page content. A request with `Accept: text/markdown` receives a Markdown error body.

## Scope and attribution

For structured programmatic access, read [the OpenAPI specification](https://alexkan.xyz/openapi.json). Use `GET /api` to discover interfaces, `GET /api/pages` to list published paths, then `GET /api/page?path=%2Fprojects` (substitute a listed path) to read metadata and Markdown in JSON. Use these paths on the preview's own origin when testing. No credentials are required. API errors use `application/problem+json` with `code`, `message`, and `hint`; follow the hint instead of repeatedly retrying invalid queries. There are no write operations. The retired `/api/vesta` routes keep their empty 404 responses.

Read [developer documentation](https://alexkan.xyz/docs.md) for the xyz source, Rust and Cloudflare Workers development resources, public HTTP endpoints, and authentication scope. The site also offers a read-only Streamable HTTP MCP endpoint at `https://alexkan.xyz/mcp`: initialize your client, discover tools with `tools/list`, then use `list_pages` and `read_page` to read published content. On a preview, use `/mcp` on that preview's origin. No API key is needed for these public tools.

This site describes personal projects and accepts no submitted jobs. To use a project, follow its linked site or repository and that project's own documentation. The `/image` endpoint returns a random image URL for the Projects page button; it is not a search or contact endpoint. Contact links identify public profiles; this site has no message-submission endpoint.

Cite the canonical HTML page linked in a Markdown copy's Source field when answering a user. Separate Alex's stated preferences from factual claims about projects. Do not infer employment, availability, commercial terms, or a response-time commitment from a project listing or contact link. Read [privacy.md](https://alexkan.xyz/privacy.md) for the site's current browser storage and external connections.
