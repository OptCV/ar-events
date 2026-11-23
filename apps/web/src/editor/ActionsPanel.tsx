import { useId, useState, type FormEvent } from 'react';
import type { Action, SceneNode } from '@ar-creator/schema';
import { cx } from '../components/cx.ts';
import formStyles from '../components/form/Form.module.css';
import { ACTION_TYPES, actionOption, actionTitle, canBePrimary, checkAction, describeAction, removeAction, setPrimary, upsertAction, usageOf, type ActionType, type Content } from './actions.ts';
import { nodeLabel } from './sceneModel.ts';
import styles from './Editor.module.css';

/** Short url-safe action id, unique in the scene. */
function newActionId(actions: Action[]): string {
  for (;;) {
    const id = `act-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    if (!actions.some((a) => a.id === id)) return id;
  }
}

/**
 * Actions and the main button (Phase 4 M12, ADR-030). Lists every action with where it is used; creates, edits and
 * deletes them; picks the primary button. Every change goes through `onEdit` (undoable, autosaved).
 */
export function ActionsPanel(props: {
  content: Content;
  busy: boolean;
  clipsFor: (nodeId: string) => string[] | null;
  onEdit: (fn: (c: Content) => Content) => void;
  onNotice: (text: string, tone: 'info' | 'error') => void;
}) {
  const { content: c, busy, onEdit, onNotice } = props;
  const [editing, setEditing] = useState<Action | 'new' | null>(null);
  const primaryId = useId();
  const primary = c.actions.find((a) => a.id === c.primaryActionId) ?? null;
  const links = c.actions.filter(canBePrimary);

  const save = (a: Action) => {
    const wasPrimary = c.primaryActionId === a.id;
    onEdit((x) => upsertAction(x, a));
    setEditing(null);
    if (wasPrimary && !canBePrimary(a)) onNotice('This action is no longer the main button: only web links can be.', 'info');
  };
  const remove = (a: Action) => {
    const r = removeAction(c, a.id);
    if (!r.ok) return onNotice(r.message, 'error');
    onEdit((x) => {
      const again = removeAction(x, a.id);
      return again.ok ? again.content : x;
    });
    onNotice(r.cleared.length ? `Action deleted; ${r.cleared.join('; ')}.` : 'Action deleted.', 'info');
  };

  return (
    <section className={styles.actions} aria-labelledby="actions-h" data-testid="actions-panel">
      <div className={styles.actionsHead}>
        <h3 id="actions-h" className={styles.paneTitle}>
          Actions <span className={styles.count}>({c.actions.length})</span>
        </h3>
        <p className={formStyles.hint}>Links and behaviours visitors can use. Give one to an object (“On tap” in the inspector), to a hotspot, or make a web link the main button.</p>
      </div>

      <div className={styles.primary}>
        <label className={formStyles.label} htmlFor={primaryId}>
          Main button
        </label>
        <select
          id={primaryId}
          className={styles.input}
          value={primary?.id ?? ''}
          disabled={busy}
          onChange={(e) => onEdit((x) => setPrimary(x, e.target.value || null))}
          aria-describedby={`${primaryId}-hint`}
        >
          <option value="">None</option>
          {links.map((a) => (
            <option key={a.id} value={a.id}>
              {actionOption(a, c.nodes)}
            </option>
          ))}
        </select>
        <p id={`${primaryId}-hint`} className={formStyles.hint}>
          {links.length ? 'One web link shown as the AR viewer’s own button (Quick Look banner, Scene Viewer link) or an on-screen button. Only web links can be the main button.' : 'Add a “web page” action to choose a main button.'}
        </p>
      </div>

      {c.actions.length > 0 && (
        <ul className={styles.actionList}>
          {c.actions.map((a) => {
            const u = usageOf(c, a.id);
            const uses = [...(u.primary ? ['main button'] : []), ...u.nodes.map((n) => `${n.kind === 'hotspot' ? 'hotspot' : 'tap on'} “${nodeLabel(n)}”`)];
            return (
              <li key={a.id} className={styles.actionRow} data-testid="action-row">
                {editing !== 'new' && editing?.id === a.id ? (
                  <ActionForm initial={a} nodes={c.nodes} clipsFor={props.clipsFor} onSave={save} onCancel={() => setEditing(null)} />
                ) : (
                  <>
                    <span className={styles.actionText}>
                      <span className={styles.treeName}>{actionTitle(a, c.nodes)}</span>
                      <span className={styles.treeKind}>{describeAction(a, c.nodes)}</span>
                      <span className={styles.treeKind}>{uses.length ? `Used by: ${uses.join(', ')}` : 'Not used yet'}</span>
                    </span>
                    <span className={styles.actionButtons}>
                      <button type="button" className={styles.iconButton} disabled={busy} onClick={() => setEditing(a)} aria-label={`Edit ${actionTitle(a, c.nodes)}`}>
                        Edit
                      </button>
                      <button type="button" className={cx(styles.iconButton, styles.danger)} disabled={busy} onClick={() => remove(a)} aria-label={`Delete ${actionTitle(a, c.nodes)}`}>
                        Delete
                      </button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing === 'new' ? (
        <ActionForm initial={null} nodes={c.nodes} clipsFor={props.clipsFor} onSave={(a) => save({ ...a, id: newActionId(c.actions) })} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} disabled={busy} onClick={() => setEditing('new')}>
          Add action
        </button>
      )}
    </section>
  );
}

interface Draft {
  type: ActionType;
  url: string;
  address: string;
  number: string;
  label: string;
  nodeId: string;
  clip: string;
}

const draftOf = (a: Action | null): Draft => ({
  type: a?.type ?? 'open-url',
  url: a?.type === 'open-url' ? a.url : 'https://',
  address: a?.type === 'mailto' ? a.address : '',
  number: a?.type === 'tel' ? a.number : '',
  label: a && 'label' in a ? (a.label ?? '') : '',
  nodeId: a && 'nodeId' in a ? a.nodeId : '',
  clip: a?.type === 'play-animation' ? a.clip : '',
});

function ActionForm({ initial, nodes, clipsFor, onSave, onCancel }: { initial: Action | null; nodes: SceneNode[]; clipsFor: (nodeId: string) => string[] | null; onSave: (a: Action) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(initial));
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const id = useId();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const models = nodes.filter((n) => n.kind === 'model');
  const clips = d.nodeId ? clipsFor(d.nodeId) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const label = d.label.trim() ? { label: d.label.trim() } : {};
    const candidate =
      d.type === 'open-url'
        ? { id: initial?.id ?? 'new', type: d.type, url: d.url.trim(), ...label }
        : d.type === 'mailto'
          ? { id: initial?.id ?? 'new', type: d.type, address: d.address.trim(), ...label }
          : d.type === 'tel'
            ? { id: initial?.id ?? 'new', type: d.type, number: d.number.trim(), ...label }
            : d.type === 'toggle-visibility'
              ? { id: initial?.id ?? 'new', type: d.type, nodeId: d.nodeId }
              : { id: initial?.id ?? 'new', type: d.type, nodeId: d.nodeId, clip: d.clip };
    if ((d.type === 'toggle-visibility' || d.type === 'play-animation') && !nodes.some((n) => n.id === d.nodeId)) return setError({ field: 'nodeId', message: 'Choose an object.' });
    if (d.type === 'play-animation' && !d.clip.trim()) return setError({ field: 'clip', message: 'Choose an animation.' });
    const r = checkAction(candidate);
    if (!r.ok) return setError({ field: r.field, message: r.message });
    setError(null);
    onSave(r.action);
  };
  const err = (field: string) => (error?.field === field ? { 'aria-invalid': true, 'aria-describedby': `${id}-err` } : {});

  return (
    <form className={styles.actionForm} onSubmit={submit} noValidate aria-label={initial ? 'Edit action' : 'New action'}>
      <label className={formStyles.label} htmlFor={`${id}-type`}>
        What it does
      </label>
      <select id={`${id}-type`} className={styles.input} value={d.type} onChange={(e) => set({ type: e.target.value as ActionType })}>
        {ACTION_TYPES.map((t) => (
          <option key={t.type} value={t.type} disabled={t.type === 'play-animation' && models.length === 0}>
            {t.label}
            {t.type === 'play-animation' && models.length === 0 ? ' (needs a 3D model in the scene)' : ''}
          </option>
        ))}
      </select>
      {d.type === 'open-url' && <Field id={`${id}-url`} label="Web address" value={d.url} onChange={(v) => set({ url: v })} inputMode="url" extra={err('url')} />}
      {d.type === 'mailto' && <Field id={`${id}-mail`} label="Email address" value={d.address} onChange={(v) => set({ address: v })} inputMode="email" extra={err('address')} />}
      {d.type === 'tel' && <Field id={`${id}-tel`} label="Phone number" value={d.number} onChange={(v) => set({ number: v })} inputMode="tel" extra={err('number')} />}
      {(d.type === 'open-url' || d.type === 'mailto' || d.type === 'tel') && (
        <Field id={`${id}-label`} label="Button text (optional)" value={d.label} onChange={(v) => set({ label: v })} extra={{ ...err('label'), maxLength: 60, placeholder: d.type === 'open-url' ? 'Visit website' : d.type === 'mailto' ? 'Send email' : 'Call' }} />
      )}
      {(d.type === 'toggle-visibility' || d.type === 'play-animation') && (
        <>
          <label className={formStyles.label} htmlFor={`${id}-node`}>
            {d.type === 'play-animation' ? '3D model' : 'Object'}
          </label>
          <select id={`${id}-node`} className={styles.input} value={d.nodeId} onChange={(e) => set({ nodeId: e.target.value, clip: '' })} {...err('nodeId')}>
            <option value="">Choose…</option>
            {(d.type === 'play-animation' ? models : nodes).map((n) => (
              <option key={n.id} value={n.id}>
                {nodeLabel(n)}
              </option>
            ))}
          </select>
        </>
      )}
      {d.type === 'play-animation' && d.nodeId && (
        <>
          <label className={formStyles.label} htmlFor={`${id}-clip`}>
            Animation
          </label>
          {clips && clips.length > 0 ? (
            <select id={`${id}-clip`} className={styles.input} value={d.clip} onChange={(e) => set({ clip: e.target.value })} {...err('clip')}>
              <option value="">Choose…</option>
              {clips.map((cl) => (
                <option key={cl} value={cl}>
                  {cl}
                </option>
              ))}
            </select>
          ) : (
            <p className={formStyles.hint}>{clips ? 'This model has no animations.' : 'Show the model in the 3D view to list its animations.'}</p>
          )}
        </>
      )}
      {error && (
        <p id={`${id}-err`} className={formStyles.error} role="alert">
          {error.message}
        </p>
      )}
      <div className={styles.inspectorActions}>
        <button type="submit" className={formStyles.button}>
          {initial ? 'Save action' : 'Add'}
        </button>
        <button type="button" className={cx(formStyles.button, formStyles.secondary)} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ id, label, value, onChange, inputMode, extra }: { id: string; label: string; value: string; onChange: (v: string) => void; inputMode?: 'url' | 'email' | 'tel'; extra?: Record<string, unknown> }) {
  return (
    <>
      <label className={formStyles.label} htmlFor={id}>
        {label}
      </label>
      <input id={id} className={styles.input} value={value} onChange={(e) => onChange(e.target.value)} {...(inputMode ? { inputMode } : {})} {...extra} />
    </>
  );
}
