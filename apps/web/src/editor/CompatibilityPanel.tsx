import type { Runtime } from '@ar-creator/platform-launch';
import { FEATURE_LABEL, RUNTIMES_FOR, RUNTIME_NAME, SUPPORT_LABEL, capability, featuresUsed, interactionIssues, planInteractions, type Route, type RuntimePlan } from '@ar-creator/capabilities';
import type { DraftExperienceScene } from '@ar-creator/schema';
import { cx } from '../components/cx.ts';
import formStyles from '../components/form/Form.module.css';
import { actionTitle, describeAction } from './actions.ts';
import styles from './Editor.module.css';

const surfaceLabel = (r: Route, runtime: Runtime) => {
  switch (r.surface) {
    case 'native-button':
      return runtime.startsWith('ios_') ? 'Main button (Quick Look banner)' : 'Main button (Scene Viewer link)';
    case 'overlay-button':
      return 'On-screen button';
    case 'tap':
      return 'Tap';
    case 'auto-play':
      return 'Plays by itself';
    case 'page':
      return 'Experience page';
  }
};

/**
 * Compatibility (Phase 4 M13, ADR-031): what this scene uses and where every action ends up on the two viewers of its
 * placement, the resulting warnings, and the experience page's buttons. Planning from the capability registry — not
 * device evidence; "experimental" and "planned" are shown as such.
 */
export function CompatibilityPanel({ scene, blendImageObjects }: { scene: DraftExperienceScene; blendImageObjects: number }) {
  const runtimes = RUNTIMES_FOR[scene.placement.mode];
  const plans = runtimes.map((r) => planInteractions(scene, r));
  const features = featuresUsed(scene, { blendImageObjects });
  const issues = interactionIssues(scene);

  return (
    <section className={styles.compat} aria-labelledby="compat-h" data-testid="compatibility">
      <div className={styles.actionsHead}>
        <h3 id="compat-h" className={styles.paneTitle}>
          Compatibility
        </h3>
        <p className={formStyles.hint}>How this scene is planned to work in each AR viewer for {scene.placement.mode} placement. Nothing here has been confirmed on a device yet.</p>
      </div>

      {features.length === 0 && scene.actions.length === 0 ? (
        <p className={formStyles.hint}>Add objects or actions to see how each viewer will show them.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.matrix}>
            <thead>
              <tr>
                <th scope="col">In this scene</th>
                {runtimes.map((r) => (
                  <th key={r} scope="col">
                    {RUNTIME_NAME[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <tr key={f} data-testid={`compat-feature-${f}`}>
                  <th scope="row">{FEATURE_LABEL[f]}</th>
                  {runtimes.map((r) => {
                    const e = capability(f, r);
                    return (
                      <td key={r} className={cx(styles.cell, styles[`status_${e.status}`])}>
                        <span className={styles.cellStatus}>{SUPPORT_LABEL[e.status]}</span>
                        <span className={styles.cellNote}>{e.message}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {scene.actions.map((a, i) => (
                <tr key={a.id} data-testid="compat-action">
                  <th scope="row">
                    {actionTitle(a, scene.nodes)}
                    <span className={styles.cellNote}>{describeAction(a, scene.nodes)}</span>
                  </th>
                  {plans.map((p) => (
                    <ActionCell key={p.runtime} plan={p} index={i} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {issues.length > 0 && (
        <ul className={styles.budgetIssues} data-testid="compat-issues">
          {issues.map((i) => (
            <li key={i.message} className={styles.issueWarning}>
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <PagePreview plan={plans[0]!} />
    </section>
  );
}

function ActionCell({ plan, index }: { plan: RuntimePlan; index: number }) {
  const a = plan.actions[index]!;
  if (a.unavailable) {
    return (
      <td className={cx(styles.cell, styles.status_unsupported)}>
        <span className={styles.cellStatus}>Not available</span>
        <span className={styles.cellNote}>{a.unavailable}</span>
      </td>
    );
  }
  return (
    <td className={styles.cell}>
      {a.routes.map((r) => (
        <span key={r.surface} className={cx(styles.route, styles[`status_${r.status}`])} title={r.note}>
          {surfaceLabel(r, plan.runtime)}
          {r.status !== 'native' && <span className={styles.cellNote}> · {SUPPORT_LABEL[r.status].toLowerCase()}</span>}
        </span>
      ))}
    </td>
  );
}

/** The public experience page's buttons, the same on every device: no link is ever lost when a viewer cannot show it. */
function PagePreview({ plan }: { plan: RuntimePlan }) {
  return (
    <div className={styles.pagePreview} data-testid="page-preview">
      <p className={styles.pagePreviewTitle}>Experience page (preview)</p>
      <div className={styles.pageButtons}>
        <span className={cx(formStyles.button, styles.fakeButton)}>View in AR</span>
        {plan.page.map((p) => (
          <span key={p.actionId} className={cx(formStyles.button, !p.primary && formStyles.secondary, styles.fakeButton)} data-testid="page-button">
            {p.label}
          </span>
        ))}
      </div>
      <p className={formStyles.hint}>
        {plan.page.length ? 'Every link is listed here on all devices, including the ones an AR viewer cannot show.' : 'No links yet: the page shows only the AR button.'}
      </p>
    </div>
  );
}
