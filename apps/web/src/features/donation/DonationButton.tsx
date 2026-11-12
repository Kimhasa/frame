import { Gift } from 'lucide-react';
import styles from './DonationButton.module.css';

export function DonationButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className={styles.button} data-channel-action="donate" aria-haspopup="dialog" onClick={onClick}><Gift size={17} aria-hidden="true" />후원하기</button>;
}
