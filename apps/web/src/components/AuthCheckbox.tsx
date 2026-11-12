import { Check, Minus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './AuthCheckbox.module.css';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  children: ReactNode;
  indeterminate?: boolean;
};

export function AuthCheckbox({ children, className = '', indeterminate = false, ...inputProps }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate; }, [indeterminate]);
  return <label className={`${styles.label} ${className}`}>
    <span className={styles.control}>
      <input {...inputProps} ref={input} type="checkbox" className={styles.input} />
      <span className={styles.box} aria-hidden="true">
        <Check className={styles.check} size={15} strokeWidth={2.8} />
        <Minus className={styles.partial} size={15} strokeWidth={2.8} />
      </span>
    </span>
    <span className={styles.text}>{children}</span>
  </label>;
}
