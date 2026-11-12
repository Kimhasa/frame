import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';
import ui from './ManagementUI.module.css';

export function ManagementPage({ title, titleId, titleRef, actions, children }: {
  title: string;
  titleId?: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const id = titleId ?? generatedId;
  return <section className={ui.page} aria-labelledby={id} data-management-page>
    <header className={ui.pageHeader}>
      <h1 ref={titleRef} id={id} tabIndex={-1}>{title}</h1>
      {actions && <div className={ui.pageActions}>{actions}</div>}
    </header>
    {children}
  </section>;
}

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'live';

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={ui.badge} data-tone={tone}><i aria-hidden="true" />{children}</span>;
}

export function EmptyState({ title, description, icon, action }: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return <div className={ui.empty} role="status">
    {icon && <span className={ui.emptyIcon} aria-hidden="true">{icon}</span>}
    <h2>{title}</h2>
    {description && <p>{description}</p>}
    {action && <div className={ui.emptyAction}>{action}</div>}
  </div>;
}
