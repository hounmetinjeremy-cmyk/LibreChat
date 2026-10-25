import { memo, useMemo, useState } from 'react';
import { ContentTypes } from 'librechat-data-provider';

type Step = {
  key: string;
  kind: 'think' | 'tool';
  title: string;
  detail: string;
  done: boolean;
};

type Props = {
  content?: Array<any>;
  isSubmitting?: boolean;
  nested?: boolean;
};

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const toolLabel = (name?: string): string => (name ? name.split('_mcp_')[0] : 'outil');

const describeArgs = (args: unknown): string => {
  try {
    const o = typeof args === 'string' ? JSON.parse(args) : args;
    if (o && typeof o === 'object') {
      const a = o as Record<string, unknown>;
      if (typeof a.method === 'string' && typeof a.path === 'string') {
        return a.method + ' ' + a.path;
      }
      const first = Object.values(a).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : '';
    }
  } catch (e) {
    /* arguments encore en cours de réception : ignorés */
  }
  return '';
};

const buildSteps = (content: Array<any> | undefined, isSubmitting: boolean): Step[] => {
  const steps: Step[] = [];
  (content ?? []).forEach((part, i) => {
    if (!part) {
      return;
    }
    if (part.type === ContentTypes.THINK) {
      const text = typeof part.think === 'string' ? part.think : '';
      if (text.trim()) {
        steps.push({ key: 'think-' + i, kind: 'think', title: 'Réflexion', detail: clip(text, 140), done: true });
      }
      return;
    }
    if (part.type === ContentTypes.TOOL_CALL) {
      const tc: any = part[ContentTypes.TOOL_CALL] ?? {};
      const done = !isSubmitting || tc.output != null || (tc.progress ?? 0) >= 1;
      steps.push({
        key: tc.id || 'call-' + i,
        kind: 'tool',
        title: toolLabel(tc.name),
        detail: clip(describeArgs(tc.args), 140),
        done,
      });
    }
  });
  return steps;
};

const ResumeSheet = memo(function ResumeSheet({ content, isSubmitting, nested }: Props) {
  const [open, setOpen] = useState(false);
  const steps = useMemo(() => buildSteps(content, !!isSubmitting), [content, isSubmitting]);
  if (nested || steps.length === 0) {
    return null;
  }
  const activeKey = isSubmitting ? [...steps].reverse().find((s) => !s.done)?.key : undefined;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-2 rounded-full border border-border-light px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover"
        aria-label="Ouvrir le résumé des étapes"
      >
        <span className={'h-2 w-2 rounded-full ' + (activeKey ? 'bg-orange-500' : 'bg-gray-400')} />
        Résumé · {steps.length} {steps.length > 1 ? 'étapes' : 'étape'}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[1000] flex items-end bg-black/40"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="max-h-[75vh] w-full overflow-y-auto rounded-t-2xl bg-surface-primary p-5 text-text-primary shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Résumé"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Résumé</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full px-3 py-1 text-sm hover:bg-surface-hover"
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <ol className="ml-2 border-l border-border-light">
              {steps.map((s) => (
                <li key={s.key} className="relative pb-5 pl-6">
                  <span
                    className={
                      'absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ' +
                      (s.key === activeKey ? 'bg-orange-500' : 'bg-gray-400')
                    }
                  />
                  <div className="text-sm font-medium">
                    {s.title}
                    {s.key === activeKey ? ' · en cours' : ''}
                  </div>
                  {s.detail ? (
                    <div className="mt-0.5 break-words text-xs text-text-secondary">{s.detail}</div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </>
  );
});

export default ResumeSheet;
