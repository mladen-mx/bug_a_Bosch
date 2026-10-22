import { readFile } from 'node:fs/promises';

const MARKER = '[bug-template-check]';

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

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export default async function ({ inputs, params, log }) {
  const raw = JSON.parse(await readFile(inputs.audit.path, 'utf8'));
  const audit = Array.isArray(raw) ? raw : raw.audit ?? [];
  const dryRun = String(params.dryRun || 'no') === 'yes';
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const pat = process.env.JIRA_PAT;

  const incomplete = audit.filter((b) => b.complete === false);
  const rows = [];
  for (const bug of incomplete) {
    const row = { bug, status: '', detail: '' };
    rows.push(row);
    if (!bug.comment || !String(bug.comment).trim()) {
      row.status = 'skipped';
      row.detail = 'no comment drafted';
      continue;
    }
    if (dryRun) {
      row.status = 'dry-run';
      row.detail = 'would post';
      continue;
    }
    if (!base || !pat) {
      row.status = 'failed';
      row.detail = 'JIRA_BASE_URL / JIRA_PAT not set';
      continue;
    }
    // The marker is what keeps re-runs from double-posting: never post without it.
    const body = String(bug.comment).includes(MARKER) ? String(bug.comment) : `${bug.comment}\n_${MARKER}_`;
    try {
      const res = await jiraFetch(
        `${base}/rest/api/2/issue/${encodeURIComponent(bug.key)}/comment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ body }),
        },
        log,
      );
      if (res.ok) {
        row.status = 'posted';
      } else {
        row.status = 'failed';
        row.detail = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
      }
    } catch (e) {
      row.status = 'failed';
      row.detail = String(e?.message ?? e);
    }
    log('info', `${bug.key}: ${row.status}`);
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const failed = rows.filter((r) => r.status === 'failed');
  const lines = [
    '# Bug template audit report',
    '',
    `${audit.length} bugs checked, ${incomplete.length} incomplete, ${audit.length - incomplete.length} complete (no comment).` +
      (dryRun ? ' **Dry run: nothing was posted.**' : ''),
    '',
  ];
  if (!audit.length) {
    lines.push('No new bugs.');
  } else if (rows.length) {
    lines.push('| Bug | Reporter | Priority | Missing | Result |', '|---|---|---|---|---|');
    for (const { bug, status, detail } of rows) {
      const reporter = bug.reporter?.displayName ?? bug.reporter?.name ?? bug.reporter ?? '';
      lines.push(
        `| [${cell(bug.key)}](${bug.link ?? '#'}) | ${cell(reporter)} | ${cell(bug.priority)} | ${cell((bug.missing ?? []).join(', '))} | ${status}${detail ? ` (${cell(detail)})` : ''} |`,
      );
    }
    lines.push('', `Posted: ${count('posted')} · Dry run: ${count('dry-run')} · Skipped: ${count('skipped')} · Failed: ${failed.length}`);
  }

  return {
    summary: `${rows.length} incomplete, ${count('posted')} posted, ${failed.length} failed${dryRun ? ' (dry run)' : ''}`,
    outputs: { report: { value: lines.join('\n') + '\n' } },
    verdict: {
      summary: 'Post comments',
      issues: failed.map((r) => ({ severity: 'major', title: `Comment on ${r.bug.key} was not posted`, detail: r.detail })),
    },
  };
}
