type HeaderLabelProps = {
  label: string;
  hoverLabel?: string | null;
};

/** Nom affiché au-dessus des réponses : toujours « Jérémy », quel que soit le modèle choisi
 *  (Aube, Soleil) ou le libellé technique de la connexion. Le choix du modèle se fait
 *  uniquement dans le sélecteur à côté du champ de saisie. */
const BRAND_NAME = 'Jérémy';
const MODEL_LABELS = ['Aube', 'Soleil', 'Assistant', 'Modèles', 'Vidéo'];

/** Agents and assistants are keyed by document id, and a message's `model`
 *  carries that id rather than a model name, so neither prefix may reach the
 *  header. */
const DOCUMENT_ID_PREFIXES = ['agent_', 'asst_'];

/** Skip document ids so the hover label is a real model name. */
export function getHeaderModelName(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  return candidates.find(
    (value): value is string =>
      value != null &&
      value !== '' &&
      !DOCUMENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix)),
  );
}

/** A preset or model spec that configured the sender has chosen what the header
 *  says, and `message.sender` already honours it. Revealing the model on hover
 *  would undo that choice, so no hover label is produced at all; the sr-only
 *  "Model:" text carries the same value and goes with it. Callers pass
 *  `hasConfiguredSender` first, then the candidates `getHeaderModelName` takes. */
export function getHeaderHoverLabel(
  hasConfiguredSender: boolean | undefined,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  if (hasConfiguredSender === true) {
    return undefined;
  }
  return getHeaderModelName(...candidates);
}

export default function HeaderLabel({ label }: HeaderLabelProps) {
  const shown = MODEL_LABELS.includes(label) ? BRAND_NAME : label;
  return <span className="min-w-0 truncate">{shown}</span>;
}
