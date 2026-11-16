import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreateExperienceInput } from '@ar-creator/contracts';
import type { PlacementMode } from '@ar-creator/schema';
import { fieldErrors } from '../api/client.ts';
import { Alert } from '../components/form/Alert.tsx';
import { Field } from '../components/form/Field.tsx';
import formStyles from '../components/form/Form.module.css';
import { SubmitButton } from '../components/form/SubmitButton.tsx';
import { useCreateExperience } from './api.ts';
import { PlacementSelector } from './PlacementSelector.tsx';
import styles from './Experiences.module.css';

export function NewExperiencePage() {
  const navigate = useNavigate();
  const create = useCreateExperience();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<PlacementMode>('floor');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = CreateExperienceInput.safeParse({ name, description: description || undefined, placementMode: mode });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      setErrors(next);
      e.currentTarget.querySelector<HTMLElement>(`[name="${Object.keys(next)[0]}"]`)?.focus();
      return;
    }
    setErrors({});
    try {
      const created = await create.mutateAsync(parsed.data);
      navigate(`/experiences/${created.id}`, { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  };

  return (
    <>
      <p className={styles.breadcrumb}>
        <Link to="/dashboard">← Your experiences</Link>
      </p>
      <div className={styles.pageHeader}>
        <h1>New experience</h1>
      </div>
      <form className={formStyles.form} onSubmit={onSubmit} noValidate>
        <section className={styles.section} aria-labelledby="details-title">
          <h2 id="details-title">Details</h2>
          {create.isError && Object.keys(errors).length === 0 && <Alert tone="error">{create.error.message}</Alert>}
          <Field label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required maxLength={120} />
          <div className={formStyles.field}>
            <label className={formStyles.label} htmlFor="new-description">
              Description (optional)
            </label>
            <textarea
              id="new-description"
              name="description"
              className={styles.textarea}
              value={description}
              maxLength={2000}
              aria-invalid={errors.description ? true : undefined}
              onChange={(e) => setDescription(e.target.value)}
            />
            {errors.description && <p className={formStyles.error}>{errors.description}</p>}
          </div>
        </section>
        <section className={styles.section} aria-labelledby="placement-title">
          <h2 id="placement-title">Where should it appear?</h2>
          <PlacementSelector value={mode} onChange={setMode} legend="Placement mode" name="new-placement" />
        </section>
        <div>
          <SubmitButton busy={create.isPending} busyLabel="Creating…">
            Create experience
          </SubmitButton>
        </div>
      </form>
    </>
  );
}
