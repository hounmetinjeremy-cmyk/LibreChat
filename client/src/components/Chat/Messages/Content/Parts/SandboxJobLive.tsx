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
const LOGO = '/assets/jeremy-logo.svg';

/** Logo qui tourne tant que le terminal travaille. */
function WorkingLogo({ spinning }: { spinning: boolean }) {
  return (
    <img
      src={LOGO}
      alt=""
      aria-hidden="true"
      className={spinning ? 'h-5 w-5 animate-[spin_2s_linear_infinite]' : 'h-5 w-5'}
    />
  );
}

/**
 * Suivi d'une tâche du terminal, façon Claude : une simple ligne sans contour sous le message
 * (logo qui tourne + « Travail en cours… » + flèche). Un appui ouvre une page complète avec toutes les
 * étapes. Interroge /api/sandbox-job/:id toutes les 3 secondes tant que la tâche tourne.
 */
const SandboxJobLive = memo(function SandboxJobLive({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobInfo | null>(null);
  const [open, setOpen] = useState(false);

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
  const lines = job.activity ?? [];
  const prUrl =
    typeof job.pull_request === 'string' && job.pull_request.startsWith('https://github.com/')
      ? job.pull_request
      : undefined;
  const title = running ? 'Travail en cours…' : success ? 'Travail terminé' : 'Travail échoué';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-2 text-left text-sm text-text-secondary"
        aria-live="polite"
      >
        <WorkingLogo spinning={running} />
        <span>{title}</span>
        <span aria-hidden="true" className="text-base leading-none">
          &rsaquo;
        </span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[1000] flex flex-col bg-surface-primary pt-[env(safe-area-inset-top)]"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Retour"
              className="p-1 text-2xl leading-none text-text-primary"
            >
              &lsaquo;
            </button>
            <WorkingLogo spinning={running} />
            <div className="text-base font-medium text-text-primary">{title}</div>
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-10 text-sm text-text-secondary">
            {job.repo ? <div className="mb-3 break-words">{job.repo}</div> : null}
            {lines.length > 0 ? (
              <ol className="space-y-2">
                {lines.map((line, i) => (
                  <li key={i + '-' + line} className="whitespace-pre-wrap break-words">
                    {line}
                  </li>
                ))}
              </ol>
            ) : (
              <p>Aucune étape pour le moment.</p>
            )}
            {!running && job.summary ? (
              <div className="mt-4 whitespace-pre-wrap break-words text-text-primary">{job.summary}</div>
            ) : null}
            {!running && prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block underline"
              >
                Voir sur GitHub
              </a>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
});

export default SandboxJobLive;
