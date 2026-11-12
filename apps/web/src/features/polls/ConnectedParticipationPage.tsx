import { Link, useSearchParams } from 'react-router';
import ui from '../../components/management/ManagementUI.module.css';
import type { AccountSession } from '../account/account-client';
import { ConnectedPollsPage } from './ConnectedPollsPage';
import { ConnectedQuestionsPage } from './ConnectedQuestionsPage';

export function ConnectedParticipationPage(props: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params] = useSearchParams(), questions = params.get('tab') === 'questions';
  const navigation = <nav className={ui.tabs} aria-label="투표 및 질문 관리 메뉴">
    <Link to="/studio/polls" aria-current={!questions ? 'page' : undefined}>투표</Link>
    <Link to="/studio/polls?tab=questions" aria-current={questions ? 'page' : undefined}>질문</Link>
  </nav>;
  return questions ? <ConnectedQuestionsPage {...props} navigation={navigation} /> : <ConnectedPollsPage {...props} navigation={navigation} />;
}
