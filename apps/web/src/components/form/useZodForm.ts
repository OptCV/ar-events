import { useCallback, useRef, useState, type FormEvent } from 'react';
import type { z } from 'zod';

/**
 * Minimal controlled-form helper validated by a shared Zod contract. On invalid submit it sets per-field
 * messages and moves focus to the first invalid field (WCAG 3.3.1).
 */
export function useZodForm<S extends z.ZodType<Record<string, unknown>>>(schema: S, initial: z.input<S>) {
  const [values, setValues] = useState(initial as Record<string, string>);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const bind = useCallback(
    (name: string) => ({
      name,
      value: values[name] ?? '',
      onChange: (e: { target: { value: string } }) => {
        const v = e.target.value;
        setValues((s) => ({ ...s, [name]: v }));
        setErrors((er) => {
          if (!er[name]) return er;
          const { [name]: _drop, ...rest } = er;
          return rest;
        });
      },
      error: errors[name],
    }),
    [values, errors],
  );

  const handleSubmit = (onValid: (data: z.output<S>) => void | Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      const first = Object.keys(next)[0];
      if (first) formRef.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setErrors({});
    await onValid(parsed.data);
  };

  return { values, errors, bind, handleSubmit, formRef, setValues };
}
