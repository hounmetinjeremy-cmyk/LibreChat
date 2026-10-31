import { memo, useEffect, useState } from 'react';
import { request, apiBaseUrl } from 'librechat-data-provider';

type JobInfo = {
  job_id: string;
  repo?: string;
  status: string;
  running: boolean;
  summary?: string | null;
  branch?: string | null;
  pull_request?: string | null;
  activity?: string[];
};

const POLL_MS = 3000;
const MAX_ERRORS = 5;
const MAX_LINES = 12;

/**
 * Panneau de suivi en direct d'une tâche du terminal, affiché sous le message.
 * Il interroge /api/sandbox-job/:id toutes les 3 secondes tant que la tâche tourne, puis s'arrête.
 * Aucun appel à l'IA : les étapes et les erreurs viennent directement du terminal.
 */
const SandboxJobLive = memo(function SandboxJobLive({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobInfo | null>(null);

  useEffect(() => {
    let stopped = false;
    let errors = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = (await request.get(apiBaseUrl() + '/api/sandbox-job/' + jobId)) as JobInfo;
        if (stopped) {
          return;
        }
        errors = 0;
        setJob(data);
        if (!data.running) {
          return;
        }
      } catch (e) {
        if (stopped) {
          return;
        }
        errors += 1;
        if (errors >= MAX_ERRORS) {
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  if (!job) {
    return null;
  }

  const running = job.running;
  const success = job.status === 'success';
  const lines = (job.activity ?? []).slice(-MAX_LINES);
  const prUrl =
    typeof job.pull_request === 'string' && job.pull_request.startsWith('https://github.com/')
      ? job.pull_request
      : undefined;
  const dot = running
    ? 'animate-pulse bg-orange-500'
    : success
      ? 'bg-green-500'
      : 'bg-red-500';
  const title = running
    ? 'Travail en cours, patiente un peu…'
    : success
      ? 'Travail terminé'
      : 'Travail échoué';

  return (
    <div
      className="mt-2 rounded-xl border border-border-light p-3 text-xs text-text-secondary"
      role="status"
      aria-live="polite"
    >
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
        <span className={'h-2 w-2 rounded-full ' + dot} />
        {title}
      </div>
      {job.repo ? <div className="mb-1 break-words">{job.repo}</div> : null}
      {lines.length > 0 ? (
        <ul className="space-y-0.5">
          {lines.map((line, i) => (
            <li key={i + '-' + line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {!running && job.summary ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-text-primary">{job.summary}</div>
      ) : null}
      {!running && prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block underline"
        >
          Voir sur GitHub
        </a>
      ) : null}
    </div>
  );
});

export default SandboxJobLive;
