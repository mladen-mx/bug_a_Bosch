import { readFile } from 'node:fs/promises';

const MARKER = '[bug-template-check]';
const ENV_RE = /\b(DEV|QUA|PROD)\b/;
const DEFAULT_JQL = 'project = <KEY> AND issuetype = Bug AND created >= -24h ORDER BY created DESC';

async function jiraFetch(url, init, log) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    try {
      const { ProxyAgent } = await import('undici');
      return await fetch(url, { ...init, dispatcher: new ProxyAgent(proxy) });
    } catch {
      log('warn', 'HTTPS_PROXY is set but undici is not available; calling Jira directly (try NODE_USE_ENV_PROXY=1)');
    }
  }
  return fetch(url, init);
}

export default async function ({ params, log }) {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const maxResults = Number(params.maxResults) || 100;
  let jql = String(params.jql || DEFAULT_JQL);
  if (jql.includes('<KEY>')) {
    if (!params.projectKey) throw new Error('The JQL contains <KEY> but the projectKey param is empty');
    jql = jql.replaceAll('<KEY>', String(params.projectKey));
  }

  let issues;
  if (params.fixturePath) {
    const raw = JSON.parse(await readFile(String(params.fixturePath), 'utf8'));
    issues = Array.isArray(raw) ? raw : raw.issues ?? [];
    log('info', `fixture mode: ${issues.length} issues`);
  } else {
    const pat = process.env.JIRA_PAT;
    if (!base || !pat) throw new Error('JIRA_BASE_URL and JIRA_PAT must be set in the environment');
    const query = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: 'summary,description,priority,reporter,created,comment',
    });
    const res = await jiraFetch(
      `${base}/rest/api/2/search?${query}`,
      { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' } },
      log,
    );
    if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    issues = (await res.json()).issues ?? [];
    log('info', `JQL: ${jql} -> ${issues.length} issues`);
  }

  const linkBase = base || 'https://jira.example.com';
  const bugs = [];
  let reminded = 0;
  for (const issue of issues) {
    const f = issue.fields ?? {};
    const comments = f.comment?.comments ?? [];
    if (comments.some((c) => String(c.body ?? '').includes(MARKER))) {
      reminded += 1;
      continue;
    }
    const description = f.description ?? '';
    bugs.push({
      key: issue.key,
      link: `${linkBase}/browse/${issue.key}`,
      summary: f.summary ?? '',
      description,
      priority: f.priority?.name ?? null,
      reporter: {
        name: f.reporter?.name ?? f.reporter?.key ?? null,
        displayName: f.reporter?.displayName ?? null,
      },
      created: f.created ?? null,
      environmentHit: description.match(ENV_RE)?.[1] ?? null,
    });
  }

  return {
    summary: bugs.length ? `${bugs.length} bugs to check (${reminded} already reminded)` : `no new bugs (${reminded} already reminded)`,
    outputs: { bugs: { value: bugs } },
  };
}
