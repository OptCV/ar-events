import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { formatBytes, type AssetSummary, type ConversionSummary, type DerivativeOutput, type ImageObjectSettingsInput } from '@ar-creator/contracts';
import { ApiRequestError } from '../api/client.ts';
import { cx } from '../components/cx.ts';
import { Alert } from '../components/form/Alert.tsx';
import formStyles from '../components/form/Form.module.css';
import { SubmitButton } from '../components/form/SubmitButton.tsx';
import { useAsset, useConversion, useConversions, useStartConversion } from './api.ts';
import styles from './ImageObjects.module.css';

type Unit = 'cm' | 'in';
type AlphaChoice = ImageObjectSettingsInput['alphaMode'];
type Backdrop = 'checker' | 'light' | 'dark';

const TO_M: Record<Unit, number> = { cm: 0.01, in: 0.0254 };
/** Six decimals: µm precision, and equal inputs always produce equal settings (and so reuse earlier results). */
const roundM = (m: number) => Math.round(m * 1e6) / 1e6;
const fmtLen = (m: number, unit: Unit) => `${Number((m / TO_M[unit]).toFixed(unit === 'cm' ? 1 : 2))} ${unit}`;

export const ALPHA_LABEL: Record<'OPAQUE' | 'MASK' | 'BLEND', string> = { OPAQUE: 'Opaque', MASK: 'Cutout', BLEND: 'Blend' };
const ALPHA_CHOICES: { value: AlphaChoice; title: string; hint: string }[] = [
  { value: 'auto', title: 'Auto (recommended)', hint: 'Picks Cutout for hard edges, Blend for soft or see-through areas, Opaque when there is no transparency.' },
  { value: 'MASK', title: 'Cutout', hint: 'Each pixel is either fully shown or fully hidden. Sharpest edges; nothing is see-through.' },
  { value: 'BLEND', title: 'Blend', hint: 'Keeps soft edges, shadows and glass-like see-through areas.' },
  { value: 'OPAQUE', title: 'Opaque', hint: 'Ignores transparency. Only for images without transparent pixels.' },
];

const STATE_TEXT: Record<ConversionSummary['state'], string> = {
  queued: 'Waiting to start…',
  running: 'Converting… This usually takes a few seconds.',
  succeeded: 'Your AR object is ready.',
  failed: 'The conversion failed.',
};

export function ImageObjectPage() {
  const { assetId = '' } = useParams();
  const q = useAsset(assetId);
  if (q.isPending) {
    return (
      <p role="status" aria-live="polite">
        Loading image…
      </p>
    );
  }
  if (q.isError || q.data.role !== 'display-image' || q.data.state !== 'validated') {
    const missing = q.isError && q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <section className={styles.page} aria-labelledby="io-error">
        <h1 id="io-error">{missing ? 'Image not found' : q.isError ? 'Could not load this image' : 'This file cannot become an AR object'}</h1>
        <p>{missing ? 'It may have been deleted, or the link is wrong.' : q.isError ? q.error.message : 'Only uploaded display images (PNG or JPEG) can be converted. Tracking images are used to recognise a printed picture instead.'}</p>
        <p>
          <Link to="/library">Back to the library</Link>
        </p>
      </section>
    );
  }
  return <Converter asset={q.data} />;
}

function Converter({ asset }: { asset: AssetSummary }) {
  const [unit, setUnit] = useState<Unit>('cm');
  const [width, setWidth] = useState('50');
  const [alphaMode, setAlphaMode] = useState<AlphaChoice>('auto');
  const [cutoff, setCutoff] = useState(0.5);
  const [doubleSided, setDoubleSided] = useState(false);
  const [pivot, setPivot] = useState<'center' | 'bottom-center'>('bottom-center');
  const [orientation, setOrientation] = useState<'upright' | 'flat'>('upright');
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const start = useStartConversion(asset.id);
  const current = useConversion(currentId);
  const history = useConversions(asset.id);
  const widthId = useId();

  const img = asset.image!;
  const n = Number(width.replace(',', '.'));
  const widthM = Number.isFinite(n) && n > 0 ? roundM(n * TO_M[unit]) : NaN;
  const widthError = !Number.isFinite(widthM) ? 'Enter a width.' : widthM < 0.01 ? 'The smallest width is 1 cm.' : widthM > 20 ? 'The largest width is 20 m.' : null;
  const heightM = widthM * (img.height / img.width);
  const busy = start.isPending || current.data?.state === 'queued' || current.data?.state === 'running';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (widthError) return;
    start.mutate(
      { widthMeters: widthM, shapeMode: 'flat', alphaMode, alphaCutoff: cutoff, doubleSided, pivot, orientation },
      { onSuccess: (c) => setCurrentId(c.id) },
    );
  };
  const changeUnit = (u: Unit) => {
    if (Number.isFinite(widthM)) setWidth(String(Number((widthM / TO_M[u]).toFixed(u === 'cm' ? 1 : 2))));
    setUnit(u);
  };

  return (
    <section className={styles.page} aria-labelledby="io-title">
      <p className={styles.crumbs}>
        <Link to="/library">Library</Link> / {asset.filename ?? 'Image'}
      </p>
      <h1 id="io-title">Make an AR object</h1>
      <p className={styles.lead}>
        Turns <strong>{asset.filename ?? 'this image'}</strong> into a flat picture you can place in AR: a GLB file for Android and the web, and a USDZ file for iPhone and iPad. The picture stays flat; transparent areas
        stay see-through, but the shape is still a rectangle.
      </p>

      <div className={styles.layout}>
        <div className={styles.previewColumn}>
          <div className={cx(styles.stage, styles[backdrop])} data-testid="io-preview">
            {asset.contentUrl && <img src={asset.contentUrl} alt={`Preview of ${asset.filename ?? 'the image'}`} width={img.width} height={img.height} />}
          </div>
          <fieldset className={styles.segmented}>
            <legend className={styles.srOnly}>Preview background</legend>
            {(['checker', 'light', 'dark'] as const).map((b) => (
              <label key={b} className={cx(styles.segment, backdrop === b && styles.segmentOn)}>
                <input type="radio" name="backdrop" value={b} checked={backdrop === b} onChange={() => setBackdrop(b)} />
                {b === 'checker' ? 'Transparency grid' : b === 'light' ? 'Light' : 'Dark'}
              </label>
            ))}
          </fieldset>
          <p className={styles.hint}>
            {img.width} × {img.height} px{img.mayHaveAlpha ? ' · can contain transparency' : ' · no transparency'}. Check the edges on light and dark backgrounds: a dark or light fringe here will also show in AR.
          </p>
        </div>

        <form className={formStyles.form} onSubmit={submit} noValidate aria-describedby="io-honesty">
          <div className={formStyles.field}>
            <label className={formStyles.label} htmlFor={widthId}>
              Real-world width
            </label>
            <div className={styles.inline}>
              <input
                id={widthId}
                className={cx(formStyles.input, styles.number)}
                inputMode="decimal"
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                aria-invalid={widthError ? true : undefined}
                aria-describedby={`${widthId}-h`}
              />
              <fieldset className={styles.segmented}>
                <legend className={styles.srOnly}>Unit</legend>
                {(['cm', 'in'] as const).map((u) => (
                  <label key={u} className={cx(styles.segment, unit === u && styles.segmentOn)}>
                    <input type="radio" name="unit" value={u} checked={unit === u} onChange={() => changeUnit(u)} />
                    {u}
                  </label>
                ))}
              </fieldset>
            </div>
            <p id={`${widthId}-h`} className={widthError ? formStyles.error : formStyles.hint} data-testid="io-size">
              {widthError ?? `Height follows the image: ${fmtLen(heightM, unit)}. Size: ${fmtLen(widthM, unit)} × ${fmtLen(heightM, unit)}.`}
            </p>
          </div>

          <Choice legend="Transparency" name="alpha" value={alphaMode} onChange={setAlphaMode} options={ALPHA_CHOICES.map((c) => ({ value: c.value, title: c.title, hint: c.hint }))}>
            {!img.mayHaveAlpha && <p className={formStyles.hint}>This image has no transparency, so the result will be opaque whichever option you choose.</p>}
          </Choice>
          {alphaMode === 'MASK' && (
            <div className={formStyles.field}>
              <label className={formStyles.label} htmlFor={`${widthId}-cut`}>
                Cutout threshold: {Math.round(cutoff * 100)}%
              </label>
              <input id={`${widthId}-cut`} type="range" min={0} max={1} step={0.05} value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))} />
              <p className={formStyles.hint}>Pixels less opaque than this are hidden.</p>
            </div>
          )}

          <Choice
            legend="Orientation"
            name="orientation"
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: 'upright', title: 'Standing up', hint: 'Like a sign or a cut-out figure. Also used for wall art.' },
              { value: 'flat', title: 'Lying flat', hint: 'Like a mat or a sticker on a table.' },
            ]}
          />
          <Choice
            legend="Origin point"
            name="pivot"
            value={pivot}
            onChange={setPivot}
            options={[
              { value: 'bottom-center', title: 'Bottom edge', hint: 'Stands on the floor at its bottom edge.' },
              { value: 'center', title: 'Centre', hint: 'Positioned by its middle, e.g. on a wall or an image target.' },
            ]}
          />
          <Choice
            legend="Sides"
            name="sides"
            value={doubleSided ? 'both' : 'front'}
            onChange={(v) => setDoubleSided(v === 'both')}
            options={[
              { value: 'front', title: 'Front only', hint: 'The back is invisible.' },
              { value: 'both', title: 'Both sides', hint: 'The back shows the picture mirrored.' },
            ]}
          />

          {start.isError && <Alert tone="error">{start.error.message}</Alert>}
          <SubmitButton busy={busy} busyLabel="Converting…">
            Create AR object
          </SubmitButton>
          <p id="io-honesty" className={formStyles.hint}>
            Files are checked automatically, but how they look in AR Quick Look and Scene Viewer has not been verified on a device yet. Open them on your phone to check before sharing.
          </p>
        </form>
      </div>

      {currentId && <Result conversion={current.data} loading={current.isPending} />}
      <History conversions={history.data?.conversions ?? []} currentId={currentId} />
    </section>
  );
}

function Choice<T extends string>({ legend, name, value, onChange, options, children }: { legend: string; name: string; value: T; onChange: (v: T) => void; options: { value: T; title: string; hint: string }[]; children?: ReactNode }) {
  return (
    <fieldset className={styles.choices}>
      <legend className={formStyles.label}>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={cx(styles.choice, value === o.value && styles.choiceOn)}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className={styles.choiceTitle}>{o.title}</span>
          <span className={styles.choiceHint}>{o.hint}</span>
        </label>
      ))}
      {children}
    </fieldset>
  );
}

function describe(c: ConversionSummary): string {
  const s = c.settings;
  const size = c.widthMeters !== null && c.heightMeters !== null ? `${fmtLen(c.widthMeters, 'cm')} × ${fmtLen(c.heightMeters, 'cm')}` : fmtLen(s.widthMeters, 'cm') + ' wide';
  const alpha = c.resolvedAlphaMode ? ALPHA_LABEL[c.resolvedAlphaMode] + (s.alphaMode === 'auto' ? ' (auto)' : '') : s.alphaMode === 'auto' ? 'Auto' : ALPHA_LABEL[s.alphaMode];
  return [size, alpha, s.orientation === 'upright' ? 'standing' : 'flat', s.doubleSided ? 'both sides' : 'front only'].join(' · ');
}

function Download({ out, label }: { out: DerivativeOutput | null; label: string }) {
  if (!out?.contentUrl) return null;
  return (
    <a className={cx(formStyles.button, formStyles.secondary, styles.download)} href={`${out.contentUrl}&download=1`} download={out.downloadName}>
      {label}
      <span className={styles.size}>{out.sizeBytes !== null ? formatBytes(out.sizeBytes) : ''}</span>
    </a>
  );
}

function Result({ conversion: c, loading }: { conversion: ConversionSummary | undefined; loading: boolean }) {
  return (
    <section className={styles.result} aria-labelledby="io-result" data-testid="io-result">
      <h2 id="io-result">Result</h2>
      <p role="status" aria-live="polite" data-testid="io-status">
        {loading || !c ? 'Starting…' : STATE_TEXT[c.state]}
      </p>
      {c?.state === 'failed' && c.error && <Alert tone="error">{c.error.message}</Alert>}
      {c?.state === 'succeeded' && (
        <>
          <p className={styles.summary}>{describe(c)}</p>
          {c.alpha && c.alpha.transparentPixels + c.alpha.fractionalPixels > 0 && (
            <p className={formStyles.hint}>
              {Math.round(((c.alpha.transparentPixels + c.alpha.fractionalPixels) / c.alpha.pixels) * 100)}% of the pixels are transparent or partly transparent.
            </p>
          )}
          <div className={styles.downloads}>
            <Download out={c.outputs.usdz} label="Download USDZ (iPhone, iPad)" />
            <Download out={c.outputs.glb} label="Download GLB (Android, web)" />
          </div>
        </>
      )}
    </section>
  );
}

function History({ conversions, currentId }: { conversions: ConversionSummary[]; currentId: string | null }) {
  const others = conversions.filter((c) => c.id !== currentId);
  if (!others.length) return null;
  return (
    <section className={styles.result} aria-labelledby="io-history">
      <h2 id="io-history">Earlier versions</h2>
      <ul className={styles.history}>
        {others.map((c) => (
          <li key={c.id} data-testid="io-history-item">
            <span>{describe(c)}</span>
            <span className={styles.state}>{c.state === 'succeeded' ? 'Ready' : c.state === 'failed' ? `Failed: ${c.error?.message ?? ''}` : 'Working…'}</span>
            {c.state === 'succeeded' && (
              <span className={styles.downloads}>
                <Download out={c.outputs.usdz} label="USDZ" />
                <Download out={c.outputs.glb} label="GLB" />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
