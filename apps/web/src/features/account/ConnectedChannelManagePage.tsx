import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { channelPath } from '../../preview/community-types';
import studio from '../../preview/assets/creative-studio.webp';
import forest from '../../preview/assets/forest-game.webp';
import city from '../../preview/assets/night-drive.webp';
import styles from '../channel-manage/ChannelManagePage.module.css';
import connected from './ConnectedAccount.module.css';
import editor from './ConnectedChannelManagePage.module.css';
import { channelCategories } from './account-client';
import type { ChannelChanges, ChannelLink, ProductChannel } from './account-client';

export const channelBanners = { studio, forest, city };
export function channelBanner(channel: ProductChannel) { return channel.bannerUrl ?? (channel.bannerPreset ? channelBanners[channel.bannerPreset] : null); }
const values = (channel: ProductChannel): ChannelChanges => ({ displayName: channel.displayName, description: channel.description, notice: channel.notice,
  category: channel.category, bannerPreset: channel.bannerPreset, handle: channel.handle, countryCode: channel.countryCode, links: channel.links.map(link => ({ ...link })) });
const normalizeHandle = (handle: string) => handle.trim().replace(/^@/, '').toLowerCase();
const handlePattern = /^[a-z][a-z0-9_-]{2,23}$/;
const regionNames = new Intl.DisplayNames(['ko'], { type: 'region' });
const countryCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const countries = countryCodes.map(code => ({ code, name: regionNames.of(code) ?? code })).sort((a, b) => a.code === 'KR' ? -1 : b.code === 'KR' ? 1 : a.name.localeCompare(b.name, 'ko'));

export function ConnectedChannelManagePage({ channel, onSave }: { channel: ProductChannel; onSave: (changes: ChannelChanges) => Promise<ProductChannel> }) {
  const [params] = useSearchParams();
  const branding = params.get('tab') === 'branding';
  const [draft, setDraft] = useState(() => values(channel));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(values(channel));
  const banner = draft.bannerPreset ? channelBanners[draft.bannerPreset] : null;
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const canonicalAddress = new URL(`channel/${encodeURIComponent(channel.handle)}`, base).href;
  const stableAddress = new URL(`channel/id/${encodeURIComponent(channel.id)}`, base).href;
  function update<K extends keyof ChannelChanges>(key: K, value: ChannelChanges[K]) { setDraft(previous => ({ ...previous, [key]: value })); setError(''); setNotice(''); }
  function updateLink(index: number, key: keyof ChannelLink, value: string) { update('links', draft.links.map((link, position) => position === index ? { ...link, [key]: value } : link)); }
  function moveLink(index: number, direction: -1 | 1) {
    const links = [...draft.links], target = index + direction;
    if (target < 0 || target >= links.length) return;
    [links[index], links[target]] = [links[target], links[index]]; update('links', links);
  }
  function invalid(message: string, name?: string) { setError(message); if (name) form.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || !dirty) return;
    const handle = normalizeHandle(draft.handle);
    if (!handlePattern.test(handle)) { invalid('채널 핸들은 영문으로 시작하는 3~24자의 영문 소문자·숫자·밑줄(_)·하이픈(-)으로 입력해 주세요.', 'handle'); return; }
    if (![...draft.displayName.trim()].length || [...draft.displayName.trim()].length > 30) { invalid('채널 이름은 1~30자로 입력해 주세요.', 'displayName'); return; }
    if ([...draft.description].length > 500) { invalid('채널 소개는 500자 이내로 입력해 주세요.', 'description'); return; }
    if ([...draft.notice].length > 1000) { invalid('채널 공지는 1,000자 이내로 입력해 주세요.', 'notice'); return; }
    const links = draft.links.map(link => ({ title: link.title.trim(), url: link.url.trim() }));
    for (let index = 0; index < links.length; index++) {
      const link = links[index];
      if (!link.title || [...link.title].length > 50 || /[\u0000-\u001f\u007f]/.test(link.title)) { invalid(`${index + 1}번째 링크의 제목을 1~50자로 입력해 주세요.`, `link-title-${index}`); return; }
      let validUrl = false;
      try { const url = new URL(link.url); validUrl = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; } catch { /* Keep the draft for correction. */ }
      if (!validUrl || link.url.length > 500 || /[\u0000-\u0020\u007f]/.test(link.url)) { invalid(`${index + 1}번째 링크에 http:// 또는 https://로 시작하는 500자 이내 주소를 입력해 주세요. 공백은 %20으로 입력해 주세요.`, `link-url-${index}`); return; }
    }
    const changes: ChannelChanges = { ...draft, displayName: draft.displayName.trim(), handle, links };
    if (new TextEncoder().encode(JSON.stringify(changes)).length > 8192) { invalid('채널 정보가 너무 길어요. 소개나 링크 내용을 줄여 주세요.', links.length ? 'link-url-0' : 'description'); return; }
    inFlight.current = true; setPending(true); setError(''); setNotice('');
    try { const updated = await onSave(changes); setDraft(values(updated)); setNotice('채널 정보를 저장했어요.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '채널 정보를 저장하지 못했어요.'); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <ManagementPage title="채널 관리" titleId="channel-manage-title" actions={<Link className={ui.button} to={channelPath(channel.handle)}>내 채널 보기</Link>}>
    <div className={styles.layout}>
      <nav className={ui.tabs} aria-label="채널 관리 메뉴"><Link to="/studio/channel" aria-current={!branding ? 'page' : undefined}>기본 정보</Link><Link to="/studio/channel?tab=branding" aria-current={branding ? 'page' : undefined}>브랜딩</Link></nav>
      <div className={styles.grid}>
        <form ref={form} className={styles.editor} onSubmit={submit} aria-busy={pending} noValidate>
          <fieldset className={connected.formFields} disabled={pending}>
            {branding ? <section className={styles.brandingBlock} aria-label="배너 설정">
              <div className={styles.subheading}><h2>배너 이미지</h2></div>
              <div className={styles.bannerEditor}>{banner && <img src={banner} alt="선택한 채널 배너" />}</div>
              <div className={styles.bannerOptions} role="group" aria-label="배너 이미지 선택">{(['studio', 'forest', 'city'] as const).map((preset, index) => <button type="button" key={preset} aria-label={`${['작업실', '숲', '도시'][index]} 배너 선택`} aria-pressed={draft.bannerPreset === preset} onClick={() => update('bannerPreset', preset)}><img src={channelBanners[preset]} alt="" /></button>)}</div>
              <button type="button" className={ui.button} disabled={draft.bannerPreset === null} onClick={() => update('bannerPreset', null)}>배너 없음</button>
            </section> : <>
              <div className={styles.fields}>
                <label className={styles.field}><span>채널 이름</span><input className={ui.control} name="displayName" value={draft.displayName} maxLength={60} required onChange={event => update('displayName', event.target.value)} /></label>
                <label className={styles.field}><span>채널 소개</span><textarea className={ui.control} name="description" rows={4} value={draft.description} maxLength={1000} onChange={event => update('description', event.target.value)} /><small>{[...draft.description].length.toLocaleString('ko-KR')} / 500</small></label>
                <label className={styles.field}><span>채널 핸들</span><input className={ui.control} name="handle" value={draft.handle} maxLength={25} autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="channel-handle-help channel-address" onChange={event => update('handle', event.target.value)} onBlur={() => { const handle = normalizeHandle(draft.handle); if (handlePattern.test(handle)) update('handle', handle); }} /><small id="channel-handle-help">영문으로 시작하는 3~24자. 영문 소문자·숫자·밑줄(_)·하이픈(-)을 사용할 수 있어요.</small></label>
                <div className={editor.addresses}><p id="channel-address"><span>채널 주소</span><Link to={channelPath(channel.handle)}>{canonicalAddress}</Link></p><label className={styles.field}><span>고정 공유 주소</span><input className={ui.control} value={stableAddress} aria-label="고정 공유 주소" readOnly onFocus={event => event.currentTarget.select()} /><small>핸들을 변경해도 이 주소로 채널을 찾을 수 있어요.</small></label></div>
                <div className={styles.fieldPair}>
                  <label className={styles.field}><span>주요 콘텐츠</span><select className={ui.control} name="category" value={draft.category} onChange={event => update('category', event.target.value)}>{channelCategories.map(category => <option key={category}>{category}</option>)}</select></label>
                  <label className={styles.field}><span>국가/지역</span><select className={ui.control} name="countryCode" value={draft.countryCode ?? ''} onChange={event => update('countryCode', event.target.value || null)}><option value="">선택 안 함</option>{countries.map(country => <option key={country.code} value={country.code}>{country.name}</option>)}</select></label>
                </div>
                <label className={styles.field}><span>채널 공지</span><textarea className={ui.control} name="notice" rows={3} value={draft.notice} maxLength={2000} onChange={event => update('notice', event.target.value)} /><small>{[...draft.notice].length.toLocaleString('ko-KR')} / 1,000</small></label>
              </div>
              <section className={editor.links} aria-labelledby="channel-links-title">
                <div className={styles.subheading}><h2 id="channel-links-title">외부 링크</h2><span>{draft.links.length} / 14</span></div>
                <ol className={editor.linkList}>{draft.links.map((link, index) => <li key={index} className={editor.linkRow}>
                  <div className={editor.linkFields}><label className={styles.field}><span>링크 제목 {index + 1}</span><input className={ui.control} name={`link-title-${index}`} value={link.title} maxLength={100} placeholder="예: 홈페이지" onChange={event => updateLink(index, 'title', event.target.value)} /></label><label className={styles.field}><span>URL</span><input className={ui.control} name={`link-url-${index}`} type="url" value={link.url} maxLength={500} placeholder="https://" autoCapitalize="none" spellCheck={false} onChange={event => updateLink(index, 'url', event.target.value)} /></label></div>
                  <div className={editor.linkActions}><button type="button" className={ui.button} aria-label={`링크 ${index + 1} 위로 이동`} disabled={index === 0} onClick={() => moveLink(index, -1)}><ArrowUp size={16} /></button><button type="button" className={ui.button} aria-label={`링크 ${index + 1} 아래로 이동`} disabled={index === draft.links.length - 1} onClick={() => moveLink(index, 1)}><ArrowDown size={16} /></button><button type="button" className={ui.button} aria-label={`링크 ${index + 1} 삭제`} onClick={() => update('links', draft.links.filter((_, position) => position !== index))}><X size={16} /></button></div>
                </li>)}</ol>
                <button type="button" className={ui.button} disabled={draft.links.length >= 14} onClick={() => { const index = draft.links.length; update('links', [...draft.links, { title: '', url: '' }]); requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>(`[name="link-title-${index}"]`)?.focus()); }}><Plus size={17} aria-hidden="true" />링크 추가</button>
              </section>
            </>}
            {error && <p className={connected.error} role="alert">{error}</p>}{notice && <p className={connected.notice} role="status">{notice}</p>}
            <div className={styles.saveBar}><button type="button" className={ui.button} disabled={!dirty} onClick={() => { setDraft(values(channel)); setError(''); setNotice(''); }}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!dirty}>{pending ? '저장 중' : '저장'}</button></div>
          </fieldset>
        </form>
        <aside className={styles.preview} aria-label="채널 미리보기"><h2>채널 미리보기</h2><div className={styles.previewCard}>
          <div className={styles.previewBanner}>{banner && <img src={banner} alt="채널 배너" />}</div>
          <div className={styles.previewProfile}><span className={styles.avatar} aria-hidden="true">{Array.from(draft.displayName.trim())[0] ?? 'F'}</span><strong>{draft.displayName}</strong><span>@{normalizeHandle(draft.handle)}</span><p>{draft.description}</p><span className={styles.followerCount}>팔로워 {channel.followerCount.toLocaleString('ko-KR')}명</span></div>
          <div className={styles.previewTabs} aria-hidden="true"><strong>홈</strong><span>다시보기</span><span>클립</span><span>정보</span></div>
        </div></aside>
      </div>
    </div>
  </ManagementPage>;
}
