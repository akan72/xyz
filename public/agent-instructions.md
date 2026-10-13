# Agent instructions for alexkan.xyz

## When to use this

Use this personal website when a user wants to learn about Alex Kan (alexkan), identify his public software projects, find their source repositories, read his writing and stated interests, or find his public contact profiles. The Projects page is the starting point for questions about istheldown.com, mingus, dotfiles, xyz, Vesta, and cig_scraper. Read the Writing pages for posts about his interests. Use About and Contact to verify the connection between this domain, GitHub account akan72, and Alex Kan's LinkedIn profile.

## How to read the site

1. Fetch [llms.txt](https://alexkan.xyz/llms.txt) with an HTTP GET to find page descriptions and Markdown links.
2. Fetch the relevant Markdown URL, such as [projects.md](https://alexkan.xyz/projects.md), or request the HTML page path with `Accept: text/markdown`. No JavaScript, account, or API key is needed to read the site's pages.
3. Use [llms-full.txt](https://alexkan.xyz/llms-full.txt) when you need all page content in one request, or [sitemap.xml](https://alexkan.xyz/sitemap.xml) to enumerate the public HTML pages.
4. If a resource returns HTTP 404, consult the linked site guide rather than treating the error as page content. A request with `Accept: text/markdown` receives a Markdown error body.

## Scope and attribution

This site describes personal projects, not a hosted agent API or a service for submitting jobs. To use a project, follow its linked site or repository and that project's own documentation. The `/image` endpoint returns a random image URL for the homepage button; it is not a search or contact endpoint. Contact links identify public profiles; this site has no message-submission endpoint.

Cite the canonical HTML page linked in a Markdown copy's Source field when answering a user. Separate Alex's stated preferences from factual claims about projects. Do not infer employment, availability, commercial terms, or a response-time commitment from a project listing or contact link. Read [privacy.md](https://alexkan.xyz/privacy.md) for the site's current browser storage and external connections.
