import { useId, type InputHTMLAttributes } from 'react';
import styles from './Form.module.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  name: string;
  error?: string | undefined;
  hint?: string | undefined;
}

/** Labelled input with hint/error text linked via aria-describedby; aria-invalid when errored. */
export function Field({ label, name, error, hint, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      <input id={id} name={name} className={styles.input} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
