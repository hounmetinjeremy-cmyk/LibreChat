// Outil `verifier` : lit l'état de la CI GitHub Actions et renvoie un résumé de quelques lignes.

const API = 'https://api.github.com';

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ministre-mcp',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function tailLog(text, lines = 25) {
  const cleaned = text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .filter((l) => l.trim());
  return cleaned.slice(-lines).join('\n').slice(-1500);
}

export async function verifier(env, { repo, branche }) {
  if (!env.GITHUB_TOKEN) return 'ERREUR : GITHUB_TOKEN non configuré sur le Ministre.';
  if (!repo || !repo.includes('/')) return 'ERREUR : paramètre repo attendu au format proprietaire/nom.';

  const q = new URLSearchParams({ per_page: '1' });
  if (branche) q.set('branch', branche);
  const r = await fetch(`${API}/repos/${repo}/actions/runs?${q}`, { headers: headers(env) });
  if (!r.ok) return `ERREUR GitHub ${r.status} sur ${repo}`;
  const run = ((await r.json()).workflow_runs || [])[0];
  if (!run) return 'Aucune exécution CI trouvée pour cette branche.';

  const head = `${run.name} · ${run.head_branch} · ${run.head_sha.slice(0, 7)}`;
  if (run.status !== 'completed') {
    return `EN COURS (${run.status}) — ${head}. Rappelle verifier dans ~30 s.`;
  }
  if (run.conclusion === 'success') return `OK — ${head}`;

  const jr = await fetch(`${API}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`, {
    headers: headers(env),
  });
  const jobs = jr.ok ? (await jr.json()).jobs || [] : [];
  const failed = jobs.filter((j) => j.conclusion === 'failure');
  const lines = failed.slice(0, 5).map((j) => {
    const step = (j.steps || []).find((s) => s.conclusion === 'failure');
    return `${j.name} → étape « ${step ? step.name : '?'} »`;
  });

  let log = '';
  if (failed[0]) {
    const lr = await fetch(`${API}/repos/${repo}/actions/jobs/${failed[0].id}/logs`, {
      headers: headers(env),
    }).catch(() => null);
    if (lr && lr.ok) log = tailLog(await lr.text());
  }

  return [
    `ÉCHEC (${run.conclusion}) — ${head}`,
    ...lines,
    log ? `--- fin du journal ---\n${log}` : '',
    run.html_url,
  ]
    .filter(Boolean)
    .join('\n');
}
