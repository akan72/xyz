---
title: Workin' at the Software Factory
description: How we used agents, production traces, and live PR environments to cut backend latency by over 50%.
date: 2026-11-18
---

*This article first appeared on the [Artemis Engineering blog](https://x.com/0xUltraviolence/status/2123145249421738412).*

![Battersea Power Station](/assets/writing/closing-the-loop-at-the-software-factory/cover.jpg)

## Background

At Artemis, our mission is to bring the best research and data tools from the investing world to everyone.

One of our core products is the [Artemis Terminal](https://www.artemis.ai/), a free dashboard where users can pull and analyze data for thousands of assets across both crypto and equities.

Since 2022, the Terminal has been an important top-of-funnel channel for us, and is used by leading retail and institutional investors alike.

![Screenshot of the Artemis Terminal](/assets/writing/closing-the-loop-at-the-software-factory/image_4.png)

*Screenshot of the Artemis Terminal*

Over time we added thousands of new assets and metrics for hundreds of crypto assets, as well as GAAP and non-GAAP metrics for equities across the US and international markets.

We eventually outgrew our existing tech stack and accumulated a good deal of tech debt in our legacy API endpoints. This resulted in a slow UX on the Terminal and a few notable user-facing outages.

This past summer, we allocated dedicated time to optimizing our backend service for the first time. Profiling and optimizing the endpoints by hand without agents would have been tedious work and taken significantly more time even with a fully dedicated engineer.

However, in only two weeks with Opus 5[1], **we were able to reduce the mean latency of our backend service by over 50%, with several core endpoints becoming ~10x faster.**

Here you can see the overall results over time!

![Mean latency across the entire service went from ~250ms -> ~110ms](/assets/writing/closing-the-loop-at-the-software-factory/image_18.png)

*Mean latency across the entire service went from ~250ms -> ~110ms*

None of the optimizations were written by hand, although we did have one engineer verifying the results part time. As a result, we learned a lot that we'd like to share about making systems more legible to agents and helping them verify their work.

By allowing agents to iterate and verify their work with minimal human handholding, we have been able to ship product with greater velocity and less on-call toil.

Here we'll explain the original problems that pushed us to focus on speed, how the most important optimizations work, and what tools and strategies helped us identify them.

## The Problem

In addition to our Terminal product, one of our main products is our spreadsheet plugin (think Excel and Google Sheets). The scope of the data delivered through the plugin is the same as through the Terminal, as they are built off of the same endpoints.

One issue with sheets is that it's really easy for users to write inefficient queries.

Take this toy example below:

![Gif comparing ART versus ARTRANGE Queries](/assets/writing/closing-the-loop-at-the-software-factory/art-vs-artrange-v6.gif)

*Gif comparing ART versus ARTRANGE Queries*

- Given a spreadsheet with *n* rows and *m* columns (imagine querying the daily price of several stocks over the past week)
- The user copies and pastes *n × m* queries, one per cell
- Each query is a separate call to our backend
- When a user refreshes their sheet, we receive all of their queries at once
- Many users refresh their sheets around the same time (i.e. US market open and close)

During periods of peak load, we would see Postgres CPU and replication lag start to climb. This would cause the service to become painfully slow, or even worse take the entire backend down.

For the longest time, the only options that we had were:

1. wait out the spam
1. manually tear down the service and spin it up again

Although users did sometimes refactor their sheets to use more efficient *[ARTRANGE](https://www.artemis.ai/docs/artemis-sheets/metrics/syntax-and-formulas#-=artrange)* queries, these outages exposed how brittle the system was.

Before trying other advanced scaling techniques or re-architecting our backend, we first wanted to try optimizing the existing business logic within our endpoints.

## Verification

The first and most impactful thing we did was to figure out what tools to give the agents so that they could verify their work and autonomously "close the loop".

For us this meant giving them **read-only** access to the right data as well as the right tools so that they could:

- identify candidate optimizations
- validate their work for both correctness and speed (was the endpoint actually faster and did the response match the expected output?)

Some concrete examples of this are:

**Logs, Traces, and Flamegraphs**

![The SQL Queries view within Datadog APM](/assets/writing/closing-the-loop-at-the-software-factory/image_22.png)

*The SQL Queries view within Datadog APM*

- Giving the agent access to Datadog APM and Logs
- Adding tooling to our backend so that agents can create and analyze async flamegraphs of API requests[2]

**Branch Deployments**

![Example showing PR Environments for Branch Deployments](/assets/writing/closing-the-loop-at-the-software-factory/pr-environments-illustrative.png)

*Example showing PR Environments for Branch Deployments*

Every backend PR creates an ephemeral, sandboxed instance of our API service

- This is a real REST endpoint that the agents (and the engineer reviewing their PRs) can hit while reviewing

**Real Data from our Product**

- Giving agents access to a real Postgres database with a dump of our datasets
- This means they can use psql to run real commands like *EXPLAIN ANALYZE* when attempting query rewrites
- Understanding how the data is actually distributed can be more useful than just looking at a schema or ORM code (assessing skew for example)

**Skills and a Full-Stack Environment**

![Pre-created Fullstack Environment in Cursor](/assets/writing/closing-the-loop-at-the-software-factory/fullstack-anonymized.png)

*Pre-created Fullstack Environment in Cursor*

- We've also taught the agent how to spin up our whole full-stack app so that it can visually verify its work end-to-end
- The right skills make it easy for agents to **prove** that their changes are correct. This leads to better results, faster iteration, and removes cognitive load from human code reviewers too
- This can be a screenshot, a screen recording video of a computer use session, or an API response that the agent diffs against the prod endpoint[3]

## Optimization Strategies

During this optimization push we shipped 83 PRs that used a variety of strategies. Here we will focus on a few low-effort, high-impact strategies:

**Eliminating Join Fanouts**

![Join Fanout query examples](/assets/writing/closing-the-loop-at-the-software-factory/image_15.png)

*Join Fanout query examples*

- One of our metadata tables looks like the figure below, unique on *(ticker, metric)*

| Ticker | Metric | Label |
| --- | --- | --- |
| AAPL | revenue | Revenue |
| MSFT | revenue | Revenue |
| GOOG | revenue | Revenue |

- Our transaction-level/fact table looked like this figure, unique on *(ticker, metric, period)*

| Ticker | Metric | Period |
| --- | --- | --- |
| AAPL | revenue | 2025-Q1 |
| AAPL | revenue | 2025-Q2 |

One of the joins between these tables matched on metric alone, multiplying the number of intermediate rows that Postgres needed to scan.

- For example, when querying for Apple's revenue, we would scan the metadata table for **all** companies that reported revenue, only to throw those records away later
- The fix was to pre-aggregate the fact data to the right grain before the join, and then only select one metadata row to get the right label.

**Finding the First Qualifying Row**

![Postgres query plan for the first qualifying row example](/assets/writing/closing-the-loop-at-the-software-factory/image_10.png)

*Postgres query plan for the first qualifying row example*

- People will often say "just slap an index on it!" and while that can be helpful, your queries also need to use it properly
- One of our market data endpoints needed the latest row per ticker, and the table already had an index on *(ticker, minute)*
- The old query filtered for all of the records belonging to each ticker, sorted them, and then discarded all but the latest row
- To optimize we scanned the index in descending order by time, and then used a *LIMIT 1* to stop at the first qualifying row without having to scan all of the matching history

**Matching the Query Predicate with the Index**

![Query plan for the predicate match example](/assets/writing/closing-the-loop-at-the-software-factory/image_21.png)

*Query plan for the predicate match example*

- This query was using *lower(ticker)* to normalize values on both sides of a *WHERE* clause. Although the table was already indexed on this column, the actual values in the data were uppercased.
- Because the query predicate didn't match the index expression, Postgres scanned every record in the index and filtered by ticker afterward
- The fix was just to examine the actual data, realize that it was already uppercased ahead of time, and to drop the *lower(...)* function while uppercasing the input ticker strings

**Eliminating Repeated Work**

![Repeated calls to construct the NYSE calendar highlighted on a flamegraph](/assets/writing/closing-the-loop-at-the-software-factory/image_7.png)

*Repeated calls to construct the NYSE calendar highlighted on a flamegraph*

- Here we re-computed the NYSE calendar multiple times in pandas
- Giving the agents access to real profiling tools like flamegraphs let them analyze the call stack within our endpoints and measure the slowdown from duplicated work (see the red bounding boxes).
- Instead of computing the calendar on-the-fly for each date range requested, we could just compute the full calendar once, cache the results, and then filter for the necessary dates downstream

## Additional Work

Since we completed this work, we migrated our Postgres provider to Planetscale Metal which has given us significantly better out-of-the-box performance across all queries.

One feature that we love is [@planetscale](https://x.com/@planetscale) [Insights](https://planetscale.com/docs/postgres/monitoring/query-insights), namely the Query Insights and Recommendations features. These tools make it even easier to identify optimization opportunities and have  your agents automatically pick them up[4].

We've also built @cursor_ai Automations + Cloud Agents that take advantage of the same tools and skills described above. Whenever a Sentry issue is opened or a Datadog Monitor is triggered, we automatically dispatch a Cloud Agent to investigate.

![Cursor pull request](/assets/writing/closing-the-loop-at-the-software-factory/image_17.png)

![Sentry issue](/assets/writing/closing-the-loop-at-the-software-factory/image_19.png)

*PR auto-created by Cursor and the Sentry issue that triggered it*

These PRs are typically merge-ready, and the on-call engineer has a high degree of confidence in them because the agent is equipped with the same tools and context as our engineers.

## Takeaways

![Themes endpoint speedup](/assets/writing/closing-the-loop-at-the-software-factory/themes-latency-v2.png)

*Themes endpoint speedup*

After landing these optimizations, endpoints that power critical pages like our home page and screener benefitted even more. You can see the speedup over time above, but it's pretty stark when you can actually **feel** the speedup on the real charts.

![Themes endpoint speedup GIF](/assets/writing/closing-the-loop-at-the-software-factory/themes-mean-v4.gif)

*Themes endpoint speedup GIF*

![Directory endpoint speedup GIF](/assets/writing/closing-the-loop-at-the-software-factory/directory-v3.gif)

*Directory endpoint speedup GIF*

Before agents, optimizing existing systems and doing "Better Engineering" work was always an afterthought amidst competing product priorities and deadlines.

Now, however, by giving agents access to the same tools as a human engineer, they can complete the full verification loop: identify costly work, test out a change against real data, and check for correctness and speed. This is a way less painful process that you can run continuously in the background alongside normal product engineering.

Although most new code is written by coding agents these days, understanding how to write performant queries + endpoints and use the right tools is still important!

It's been meme'd online but now more than ever "Speed is a Feature" and we shouldn't settle for slow products.

## Appendix

1. This work began over Summer 2026, if you were to start today with Opus 5.5 or Sol 6.2 it would be even more effective!
1. FastAPI async flamegraph idea was inspired by this [article](https://blog.balthazar-rouberol.com/how-to-profile-a-fastapi-asynchronous-request)
1. Since we began this work, GitHub's CLI now has improved [support](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) for media via **gh --attach** which makes it even easier for agents to add visual evidence to PRs for you
1. Planetscale just launched [Insights Agent](https://planetscale.com/blog/introducing-insights-agent) yesterday, which would have automated this process out of the box
