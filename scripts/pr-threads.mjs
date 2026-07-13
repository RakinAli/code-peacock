#!/usr/bin/env node
// PR review-thread helper for the babysit phase. Wraps the GitHub GraphQL API
// (via `gh api graphql`, so auth is whatever `gh` is logged in as) because the
// gh CLI has no first-class commands for review threads.
//
// Usage:
//   node pr-threads.mjs list <pr-number>            print unresolved threads as JSON
//   node pr-threads.mjs reply <thread-id> <body>    reply inside a thread
//   node pr-threads.mjs resolve <thread-id>         mark a thread resolved

import { execFileSync } from "node:child_process";

const LIST_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { author { login } body url createdAt }
          }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { url }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

function graphql(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    const flag = typeof value === "number" ? "-F" : "-f";
    args.push(flag, `${key}=${value}`);
  }
  try {
    return JSON.parse(
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    );
  } catch (error) {
    // gh exits nonzero when the GraphQL response carries errors (e.g. PR not
    // found, bad thread id) — surface its message, not a Node stack trace.
    console.error(error.stderr?.trim() || String(error));
    process.exit(1);
  }
}

function currentRepo() {
  const stdout = execFileSync("gh", ["repo", "view", "--json", "owner,name"], {
    encoding: "utf8",
  });
  const { owner, name } = JSON.parse(stdout);
  return { owner: owner.login, repo: name };
}

function fetchAllThreads(owner, repo, prNumber) {
  const threads = [];
  let cursor = null;
  do {
    const variables = { owner, repo, pr: prNumber };
    if (cursor) variables.cursor = cursor;
    const result = graphql(LIST_QUERY, variables);
    const pullRequest = result.data.repository.pullRequest;
    if (!pullRequest) {
      console.error(`PR #${prNumber} not found in ${owner}/${repo}`);
      process.exit(1);
    }
    const page = pullRequest.reviewThreads;
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

function listUnresolved(prNumber) {
  const { owner, repo } = currentRepo();
  const threads = fetchAllThreads(owner, repo, prNumber);
  const unresolved = threads
    .filter((thread) => !thread.isResolved)
    .map((thread) => ({
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      isOutdated: thread.isOutdated,
      comments: thread.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "(deleted user)",
        body: comment.body,
        url: comment.url,
        createdAt: comment.createdAt,
      })),
    }));
  console.log(JSON.stringify({ total: threads.length, unresolved }, null, 2));
}

function reply(threadId, body) {
  const result = graphql(REPLY_MUTATION, { threadId, body });
  console.log(`replied: ${result.data.addPullRequestReviewThreadReply.comment.url}`);
}

function resolve(threadId) {
  graphql(RESOLVE_MUTATION, { threadId });
  console.log(`resolved: ${threadId}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "list": {
    const prNumber = Number(rest[0]);
    if (!Number.isInteger(prNumber)) {
      console.error("Usage: pr-threads.mjs list <pr-number>");
      process.exit(2);
    }
    listUnresolved(prNumber);
    break;
  }
  case "reply": {
    const [threadId, body] = rest;
    if (!threadId || !body) {
      console.error('Usage: pr-threads.mjs reply <thread-id> "body"');
      process.exit(2);
    }
    reply(threadId, body);
    break;
  }
  case "resolve": {
    const [threadId] = rest;
    if (!threadId) {
      console.error("Usage: pr-threads.mjs resolve <thread-id>");
      process.exit(2);
    }
    resolve(threadId);
    break;
  }
  default:
    console.error("Commands: list <pr-number> | reply <thread-id> <body> | resolve <thread-id>");
    process.exit(2);
}
