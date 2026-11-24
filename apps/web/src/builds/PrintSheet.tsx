import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import formStyles from '../components/form/Form.module.css';
import { usePublicExperience } from './api.ts';
import styles from './Builds.module.css';

/**
 * Printable tracking image for a published image experience (Phase 6 M19, ADR-037). The image is sized in real
 * centimetres, which browsers honour when printing at 100 % ("Actual size"); the sheet says to check with a ruler,
 * because AR content is scaled from this width and the browser cannot verify the printout.
 */
export function PrintSheet() {
  const { slug = '' } = useParams();
  const q = usePublicExperience(slug);
  useEffect(() => {
    if (q.data) document.title = `${q.data.name} — print sheet`;
  }, [q.data]);
  if (q.isPending) return <p role="status">Loading…</p>;
  if (q.isError || !q.data.tracking) {
    return (
      <section className={styles.page}>
        <h1>No print sheet</h1>
        <p>This experience is not published, or it does not use a printed image.</p>
      </section>
    );
  }
  const t = q.data;
  const cm = Number((t.tracking!.widthMeters * 100).toFixed(1));
  return (
    <section className={styles.sheet} data-testid="print-page">
      <div className={styles.noPrint}>
        <p>
          <Link to={`/x/${slug}`}>← Back to {t.name}</Link>
        </p>
        <h1>Print the tracking image</h1>
        <p>
          Print at <strong>100 % / “Actual size”</strong> (not “Fit to page”). Then measure the printed image: it must be <strong>{cm} cm</strong> wide, edge to
          edge. If it is not, the AR content will appear at the wrong size.
        </p>
        <button type="button" className={formStyles.button} onClick={() => window.print()}>
          Print
        </button>
      </div>
      <figure className={styles.printFigure}>
        <img src={t.tracking!.imageUrl} alt={`Tracking image for ${t.name}`} style={{ width: `${cm}cm` }} data-testid="print-image" data-width-cm={cm} />
        <figcaption>
          {t.name} — print width {cm} cm. Scan the QR code on the experience page, then point the camera at this image.
        </figcaption>
      </figure>
    </section>
  );
}
