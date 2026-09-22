/**
 * Write a deck, check it, and get the files needed to deploy it.
 *
 * Validation runs through the same module the server uses when loading a deck
 * file, so a deck that is clean here is guaranteed to load there. That is the
 * whole point of the page: finding out a card is malformed at server boot, in
 * a log nobody is watching, is the bad version of this.
 */
import { useMemo, useState } from 'react';
import { validateDeck, type ValidationIssue } from '@cac/shared/deck-validate';
import {
  configMapYaml,
  createCommand,
  deckFileName,
  deckJson,
  helmCommand,
  podmanCommand,
} from '../lib/deckYaml.ts';

const EXAMPLE_PROMPTS = `Our standup is mostly ______.
The deploy failed because of ______.
What did we learn in the retro?
We replaced ______ with ______ and regretted it.`;

const EXAMPLE_RESPONSES = `A rogue cron job
The intern's first PR
Blaming DNS
A meeting that should have been an email
Someone force-pushing to main`;

function lines(text: string): string[] {
  return text.split('\n');
}

function IssueList({ issues, tone }: { issues: ValidationIssue[]; tone: 'error' | 'warn' }) {
  if (issues.length === 0) return null;
  const colour = tone === 'error' ? 'text-danger-400' : 'text-warn-400';
  return (
    <ul className={`flex flex-col gap-1 text-xs ${colour}`}>
      {issues.map((issue, i) => (
        <li key={i}>
          {issue.line !== undefined && <span className="font-mono opacity-70">line {issue.line}: </span>}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function CopyBlock({ label, hint, value }: { label: string; hint?: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked in some contexts; the text is selectable anyway.
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-bold tracking-wider text-felt-500 uppercase">{label}</h3>
        <button
          type="button"
          onClick={() => void copy()}
          className="text-xs font-semibold text-accent-400 transition hover:text-accent-500"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && <p className="-mt-1 text-xs text-felt-700">{hint}</p>}
      <pre className="max-h-72 overflow-auto rounded-xl bg-felt-950 p-3 text-[0.72rem] leading-relaxed text-felt-300 ring-1 ring-white/10">
        {value}
      </pre>
    </section>
  );
}

export function DeckBuilder({ onBack }: { onBack: () => void }) {
  const [id, setId] = useState('myteam');
  const [name, setName] = useState('My Team');
  const [description, setDescription] = useState('Inside jokes, mostly about the deploy pipeline.');
  const [promptText, setPromptText] = useState(EXAMPLE_PROMPTS);
  const [responseText, setResponseText] = useState(EXAMPLE_RESPONSES);
  const [configMapName, setConfigMapName] = useState('cac-custom-decks');
  const [namespace, setNamespace] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const result = useMemo(
    () =>
      validateDeck({
        id,
        name,
        description,
        prompts: lines(promptText),
        responses: lines(responseText),
      }),
    [id, name, description, promptText, responseText],
  );

  const errorsFor = (field: ValidationIssue['field']) => result.errors.filter((e) => e.field === field);
  const warningsFor = (field: ValidationIssue['field']) => result.warnings.filter((e) => e.field === field);

  /** Load an existing deck file back into the form, to check or edit it. */
  function importJson(raw: string) {
    setImportError(null);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const text = (v: unknown) =>
        typeof v === 'string' ? v : typeof (v as { text?: string })?.text === 'string' ? (v as { text: string }).text : '';
      setId(String(parsed['id'] ?? ''));
      setName(String(parsed['name'] ?? ''));
      setDescription(String(parsed['description'] ?? ''));
      setPromptText((Array.isArray(parsed['prompts']) ? parsed['prompts'] : []).map(text).join('\n'));
      setResponseText((Array.isArray(parsed['responses']) ? parsed['responses'] : []).map(text).join('\n'));
    } catch (err) {
      setImportError((err as Error).message);
    }
  }

  function download(filename: string, contents: string) {
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const deck = result.deck;
  const field =
    'rounded-lg bg-felt-800 px-3 py-2 text-white placeholder:text-felt-700 focus:ring-2 focus:ring-accent-500 focus:outline-none';

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-white">Deck builder</h1>
          <p className="mt-1 text-sm text-felt-500">
            Write your own cards, check them, and get the files to deploy them.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg bg-felt-900 px-4 py-2 text-sm font-bold text-felt-300 ring-1 ring-white/10 transition hover:text-white"
        >
          Back to the game
        </button>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">Deck id</span>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                className={`${field} font-mono`}
                placeholder="myteam"
              />
              <span className="text-[0.7rem] text-felt-700">
                Lowercase, no spaces. Used for the filename and card ids.
              </span>
              <IssueList issues={errorsFor('id')} tone="error" />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="My Team" />
              <span className="text-[0.7rem] text-felt-700">Shown beside the checkbox in the lobby.</span>
              <IssueList issues={errorsFor('name')} tone="error" />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={field}
              placeholder="What this deck is about"
            />
            <IssueList issues={errorsFor('description')} tone="error" />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-xs font-bold tracking-wider text-felt-500 uppercase">
              Prompts (black cards)
              <span className="font-mono normal-case">{deck?.prompts.length ?? 0}</span>
            </span>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={10}
              spellCheck
              className={`${field} font-mono text-[0.8rem] leading-relaxed`}
            />
            <span className="text-[0.7rem] text-felt-700">
              One per line. Write a blank as two or more underscores: <code>______</code>. Two blanks
              makes it a pick-2 card. A line with no blank becomes a straight question.
            </span>
            <IssueList issues={errorsFor('prompts')} tone="error" />
            <IssueList issues={warningsFor('prompts')} tone="warn" />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-xs font-bold tracking-wider text-felt-500 uppercase">
              Answers (white cards)
              <span className="font-mono normal-case">{deck?.responses.length ?? 0}</span>
            </span>
            <textarea
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              rows={10}
              spellCheck
              className={`${field} font-mono text-[0.8rem] leading-relaxed`}
            />
            <IssueList issues={errorsFor('responses')} tone="error" />
            <IssueList issues={warningsFor('responses')} tone="warn" />
          </label>

          <details className="rounded-xl bg-felt-900 ring-1 ring-white/10">
            <summary className="cursor-pointer px-4 py-3 text-xs font-bold tracking-wider text-felt-500 uppercase">
              Load an existing deck
            </summary>
            <div className="flex flex-col gap-2 border-t border-white/5 px-4 py-3">
              <p className="text-xs text-felt-700">
                Paste a deck JSON file to check or edit it.
              </p>
              <textarea
                rows={4}
                onChange={(e) => e.target.value.trim() && importJson(e.target.value)}
                placeholder='{ "id": "myteam", "name": "My Team", ... }'
                className={`${field} font-mono text-[0.75rem]`}
              />
              {importError && <p className="text-xs text-danger-400">Could not parse: {importError}</p>}
            </div>
          </details>
        </div>

        <div className="flex flex-col gap-5">
          <div
            className={`rounded-xl px-4 py-3 text-sm font-semibold ring-1 ${
              result.ok
                ? 'bg-accent-500/10 text-accent-400 ring-accent-500/30'
                : 'bg-danger-400/10 text-danger-400 ring-danger-400/30'
            }`}
          >
            {result.ok ? (
              <>
                Valid deck — {deck!.prompts.length} prompts, {deck!.responses.length} answers
                {result.warnings.length > 0 && `, ${result.warnings.length} thing(s) to look at`}
              </>
            ) : (
              <>
                {result.errors.length} problem{result.errors.length === 1 ? '' : 's'} to fix before this
                deck will load
              </>
            )}
          </div>

          {result.warnings.length > 0 && (
            <div className="rounded-xl bg-warn-400/10 px-4 py-3 ring-1 ring-warn-400/25">
              <IssueList issues={result.warnings} tone="warn" />
            </div>
          )}

          {deck && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">ConfigMap name</span>
                  <input
                    value={configMapName}
                    onChange={(e) => setConfigMapName(e.target.value)}
                    className={`${field} font-mono text-sm`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-wider text-felt-500 uppercase">
                    Namespace (optional)
                  </span>
                  <input
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    placeholder="happyhour"
                    className={`${field} font-mono text-sm`}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => download(deckFileName(deck), deckJson(deck))}
                  className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-bold text-felt-950 transition hover:bg-accent-400"
                >
                  Download {deckFileName(deck)}
                </button>
                <button
                  type="button"
                  onClick={() => download(`${configMapName}.yaml`, configMapYaml(deck, configMapName, namespace))}
                  className="rounded-lg bg-felt-800 px-4 py-2 text-sm font-bold text-white ring-1 ring-white/10 transition hover:bg-felt-700"
                >
                  Download ConfigMap YAML
                </button>
              </div>

              <CopyBlock
                label="ConfigMap"
                hint="Apply this, then point the chart at it. The server picks the deck up without a restart."
                value={configMapYaml(deck, configMapName, namespace)}
              />

              <CopyBlock
                label="Or create it from the file"
                hint="Same result, without keeping YAML around."
                value={`${createCommand(deck, configMapName)}\n\n${helmCommand(configMapName)}`}
              />

              <CopyBlock label="Running locally with podman" value={podmanCommand(deck)} />

              <CopyBlock label={deckFileName(deck)} value={deckJson(deck)} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
