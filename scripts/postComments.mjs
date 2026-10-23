import { readFile } from 'node:fs/promises';

const MARKER = '[bug-template-check]';
const READY_LABEL = 'ready_for_development';
const REFINE_LABEL = 'need_refinement';
const OPEN_STATUS = 'open';
const IN_PROGRESS_STATUS = 'in progress';
const MOVE_BACK_REASON =
  'This bug has been moved back from *In Progress* to *Open* because mandatory information is missing: please provide more context so the team can continue working on it.';

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
const statusIs = (name, wanted) => String(name ?? '').trim().toLowerCase() === wanted;

// Puts the move-back sentence above the closing "Thank you! _[bug-template-check]_" line.
function withMoveBackReason(comment) {
  const lines = comment.split('\n');
  const at = lines.findLastIndex((l) => l.includes(MARKER));
  if (at === -1) return `${comment}\n\n${MOVE_BACK_REASON}`;
  lines.splice(at, 0, MOVE_BACK_REASON, '');
  return lines.join('\n');
}

export default async function ({ inputs, params, log }) {
  const raw = JSON.parse(await readFile(inputs.audit.path, 'utf8'));
  const audit = Array.isArray(raw) ? raw : raw.audit ?? [];
  const dryRun = String(params.dryRun || 'no') === 'yes';
  const labelField = String(params.labelField || 'labels').trim() || 'labels';
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const pat = process.env.JIRA_PAT;
  const headers = { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const issueUrl = (key) => `${base}/rest/api/2/issue/${encodeURIComponent(key)}`;
  const httpError = async (res, what) => `${what} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;

  // Returns '' on success, else the error text.
  async function addLabel(key, label) {
    try {
      // "add" keeps the labels the bug already carries; adding one it has is a no-op.
      const res = await jiraFetch(
        issueUrl(key),
        { method: 'PUT', headers, body: JSON.stringify({ update: { [labelField]: [{ add: label }] } }) },
        log,
      );
      return res.ok ? '' : await httpError(res, 'label');
    } catch (e) {
      return String(e?.message ?? e);
    }
  }

  async function getStatus(key) {
    const res = await jiraFetch(`${issueUrl(key)}?fields=status`, { headers }, log);
    if (!res.ok) throw new Error(await httpError(res, 'status lookup'));
    return (await res.json()).fields?.status?.name ?? '';
  }

  // The transition available from the bug's current status that ends in Open, or null.
  async function findOpenTransition(key) {
    const res = await jiraFetch(`${issueUrl(key)}/transitions`, { headers }, log);
    if (!res.ok) throw new Error(await httpError(res, 'transitions lookup'));
    const transitions = (await res.json()).transitions ?? [];
    return transitions.find((t) => statusIs(t.to?.name, OPEN_STATUS)) ?? null;
  }

  // Moves the bug to Open; returns a note for the report. Throws when it cannot.
  async function reopen(key) {
    const transition = await findOpenTransition(key);
    if (!transition) throw new Error('no transition to Open is available from the current status');
    if (dryRun) return `would move to Open via "${transition.name}"`;
    const res = await jiraFetch(
      `${issueUrl(key)}/transitions`,
      { method: 'POST', headers, body: JSON.stringify({ transition: { id: transition.id } }) },
      log,
    );
    if (!res.ok) throw new Error(await httpError(res, `transition "${transition.name}"`));
    return `moved to Open via "${transition.name}"`;
  }

  const incomplete = audit.filter((b) => b.complete === false);
  const complete = audit.filter((b) => b.complete === true);
  const rows = [];
  for (const bug of incomplete) {
    const row = { bug, status: '', detail: '', jiraStatus: '', move: '', moveDetail: '', label: '', labelDetail: '' };
    rows.push(row);
    if (!bug.comment || !String(bug.comment).trim()) {
      row.status = 'skipped';
      row.detail = 'no comment drafted';
      continue;
    }
    if (!base || !pat) {
      row.status = dryRun ? 'dry-run' : 'failed';
      row.detail = dryRun ? 'would post' : 'JIRA_BASE_URL / JIRA_PAT not set';
      if (dryRun) {
        row.move = 'dry-run';
        row.moveDetail = 'In Progress would move to Open, with the reason in the comment (status not checked)';
        row.label = 'dry-run';
        row.labelDetail = `would add ${REFINE_LABEL} if Open or In Progress`;
      }
      continue;
    }
    // Status is read before posting so the comment can say why an In Progress bug goes back to Open.
    let statusError = '';
    try {
      row.jiraStatus = await getStatus(bug.key);
    } catch (e) {
      statusError = String(e?.message ?? e);
    }
    const movingBack = !statusError && statusIs(row.jiraStatus, IN_PROGRESS_STATUS);
    const comment = movingBack ? withMoveBackReason(String(bug.comment)) : String(bug.comment);
    if (dryRun) {
      row.status = 'dry-run';
      row.detail = movingBack ? 'would post, with the move-back reason' : 'would post';
    } else {
      // The marker is what keeps re-runs from double-posting: never post without it.
      const body = comment.includes(MARKER) ? comment : `${comment}\n_${MARKER}_`;
      try {
        const res = await jiraFetch(`${issueUrl(bug.key)}/comment`, { method: 'POST', headers, body: JSON.stringify({ body }) }, log);
        if (res.ok) {
          row.status = 'posted';
          row.detail = movingBack ? 'with the move-back reason' : '';
        } else {
          row.status = 'failed';
          row.detail = await httpError(res, 'comment');
        }
      } catch (e) {
        row.status = 'failed';
        row.detail = String(e?.message ?? e);
      }
    }
    // Moving and need_refinement only follow a posted reminder.
    if (row.status !== 'posted' && row.status !== 'dry-run') {
      log('info', `${bug.key}: comment ${row.status}`);
      continue;
    }
    // Open: label only. In Progress: back to Open, then label. Any other status: left alone.
    let wantsLabel = false;
    if (statusError) {
      row.move = 'failed';
      row.moveDetail = statusError;
    } else if (statusIs(row.jiraStatus, OPEN_STATUS)) {
      row.move = 'already Open';
      wantsLabel = true;
    } else if (movingBack) {
      wantsLabel = true;
      try {
        row.moveDetail = await reopen(bug.key);
        row.move = dryRun ? 'dry-run' : 'moved';
      } catch (e) {
        row.move = 'failed';
        row.moveDetail = String(e?.message ?? e);
      }
    } else {
      row.move = 'not changed';
      row.label = 'not added';
      row.labelDetail = `status is ${row.jiraStatus || 'unknown'}, not Open or In Progress`;
    }
    // The label goes on even when the move failed: that failure pauses the run on its own.
    if (wantsLabel) {
      if (dryRun) {
        row.label = 'dry-run';
        row.labelDetail = `would add ${REFINE_LABEL}`;
      } else {
        const err = await addLabel(bug.key, REFINE_LABEL);
        row.label = err ? 'failed' : 'labelled';
        row.labelDetail = err;
      }
    }
    log('info', `${bug.key}: comment ${row.status}, status ${row.jiraStatus || '?'} -> ${row.move}, ${REFINE_LABEL} ${row.label || 'not added'}`);
  }

  // Complete bugs get the label in the label field itself, never as a comment.
  const labelRows = [];
  for (const bug of complete) {
    const row = { bug, status: '', detail: '' };
    labelRows.push(row);
    if (dryRun) {
      row.status = 'dry-run';
      row.detail = `would add ${READY_LABEL} to ${labelField}`;
      continue;
    }
    if (!base || !pat) {
      row.status = 'failed';
      row.detail = 'JIRA_BASE_URL / JIRA_PAT not set';
      continue;
    }
    const err = await addLabel(bug.key, READY_LABEL);
    row.status = err ? 'failed' : 'labelled';
    row.detail = err;
    log('info', `${bug.key}: ${row.status}`);
  }

  const count = (list, s, k = 'status') => list.filter((r) => r[k] === s).length;
  const failed = rows.filter((r) => r.status === 'failed');
  const moveFailed = rows.filter((r) => r.move === 'failed');
  const refineFailed = rows.filter((r) => r.label === 'failed');
  const labelFailed = labelRows.filter((r) => r.status === 'failed');
  const reporterOf = (bug) => bug.reporter?.displayName ?? bug.reporter?.name ?? bug.reporter ?? '';
  const withDetail = (s, d) => `${s}${d ? ` (${cell(d)})` : ''}`;
  const lines = [
    '# Bug template audit report',
    '',
    `${audit.length} bugs checked, ${incomplete.length} incomplete (reminder comment; Open: ${REFINE_LABEL}; In Progress: back to Open + ${REFINE_LABEL}), ` +
      `${complete.length} complete (label ${READY_LABEL}).` +
      (dryRun ? ' **Dry run: nothing was changed in Jira.**' : ''),
    '',
  ];
  if (!audit.length) {
    lines.push('No new bugs.');
  }
  if (rows.length) {
    lines.push(
      '## Incomplete bugs',
      '',
      `| Bug | Reporter | Priority | Missing | Comment | Status found | Back to Open | ${REFINE_LABEL} |`,
      '|---|---|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      lines.push(
        `| [${cell(r.bug.key)}](${r.bug.link ?? '#'}) | ${cell(reporterOf(r.bug))} | ${cell(r.bug.priority)} | ${cell((r.bug.missing ?? []).join(', '))} | ` +
          `${withDetail(r.status, r.detail)} | ${cell(r.jiraStatus)} | ${withDetail(r.move, r.moveDetail)} | ${withDetail(r.label, r.labelDetail)} |`,
      );
    }
    lines.push(
      '',
      `Posted: ${count(rows, 'posted')} · Dry run: ${count(rows, 'dry-run')} · Skipped: ${count(rows, 'skipped')} · Failed: ${failed.length} · ` +
        `Moved to Open: ${count(rows, 'moved', 'move')} · already Open: ${count(rows, 'already Open', 'move')} · other status: ${count(rows, 'not changed', 'move')} · ` +
        `move failed: ${moveFailed.length} · ${REFINE_LABEL} added: ${count(rows, 'labelled', 'label')} · label failed: ${refineFailed.length}`,
      '',
    );
  }
  if (labelRows.length) {
    lines.push(`## Complete bugs (${READY_LABEL})`, '', '| Bug | Reporter | Priority | Result |', '|---|---|---|---|');
    for (const { bug, status, detail } of labelRows) {
      lines.push(`| [${cell(bug.key)}](${bug.link ?? '#'}) | ${cell(reporterOf(bug))} | ${cell(bug.priority)} | ${withDetail(status, detail)} |`);
    }
    lines.push('', `Labelled: ${count(labelRows, 'labelled')} · Dry run: ${count(labelRows, 'dry-run')} · Failed: ${labelFailed.length}`);
  }

  const failures = failed.length + moveFailed.length + refineFailed.length + labelFailed.length;
  return {
    summary:
      `${rows.length} incomplete, ${count(rows, 'posted')} posted, ${count(rows, 'moved', 'move')} moved to Open, ${count(rows, 'labelled', 'label')} ${REFINE_LABEL}; ` +
      `${labelRows.length} complete, ${count(labelRows, 'labelled')} ${READY_LABEL}; ${failures} failed${dryRun ? ' (dry run)' : ''}`,
    outputs: { report: { value: lines.join('\n') + '\n' } },
    verdict: {
      summary: 'Post comments, reopen and label',
      issues: [
        ...failed.map((r) => ({ severity: 'major', title: `Comment on ${r.bug.key} was not posted`, detail: r.detail })),
        ...moveFailed.map((r) => ({ severity: 'major', title: `${r.bug.key} was not moved back to Open`, detail: r.moveDetail })),
        ...refineFailed.map((r) => ({ severity: 'major', title: `Label ${REFINE_LABEL} on ${r.bug.key} was not added`, detail: r.labelDetail })),
        ...labelFailed.map((r) => ({ severity: 'major', title: `Label ${READY_LABEL} on ${r.bug.key} was not added`, detail: r.detail })),
      ],
    },
  };
}
