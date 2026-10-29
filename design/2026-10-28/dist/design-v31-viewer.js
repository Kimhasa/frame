/* FRAME v3.1: viewer-facing broadcast information only. */
(() => {
  const F = window.F;
  if (!F?.modals?.info) return;
  const originalInfo = F.modals.info;
  const e = F.e;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const handles = ['spring', 'seojae', 'slow-night', 'green', 'moa', 'jido', 'afternoon', 'walk'];
  const descriptions = {
    code: '작은 기능을 하나씩 완성하는 과정을 함께 나눠요. 궁금한 점이나 이야기하고 싶은 내용은 채팅으로 남겨주세요.',
    design: '오늘 떠오른 색과 장면을 천천히 그려봅니다. 작업하는 동안 편하게 이야기 나눠요.',
    night: '익숙한 도시의 새로운 풍경을 찾아 떠나요. 음악을 들으며 오늘의 이야기를 함께 나눕니다.',
    game: '처음 만나는 길을 천천히 탐험해요. 새로운 장면과 작은 발견을 함께 즐겨주세요.',
    board: '각자의 작업에 집중하는 시간. 잠깐 쉬어가고 싶을 때 편하게 이야기 나눠요.',
    map: '마음이 가는 장소와 새로운 길을 살펴봅니다. 함께 가보고 싶은 곳을 들려주세요.'
  };
  const selectedIndex = () => Number.isInteger(F.selectedBroadcast) ? F.selectedBroadcast : 0;

  function information() {
    const index = selectedIndex();
    const broadcast = F.broadcasts?.[index];
    if (!broadcast) return null;
    const ownChannel = index === 0 ? F.accountDesign?.savedChannel : null;
    const title = text(broadcast.title);
    const name = text(ownChannel?.name) || text(broadcast.name);
    const category = text(broadcast.category);
    const handle = text(ownChannel?.handle) || text(broadcast.handle) || handles[index] || '';
    const description = Object.hasOwn(broadcast, 'description') ? text(broadcast.description) : descriptions[broadcast.scene] || '';
    const context = F.v31ViewerInfoContext;
    const ended = ['ended', '종료', '방송 종료', '오프라인'].includes(broadcast.status) || broadcast.live === false || (context?.index === index && context.state === '방송 종료');
    if (!title && !name && !description) return null;
    return {index, title, name, category, handle, description, ended, initial: text(broadcast.initial) || name.slice(0, 1)};
  }

  F.modals.info = viewState => {
    const original = originalInfo(viewState);
    const info = information();
    if (!info) return {...original, cls: 'v31-viewer-info', body: '<section class="v31-viewer-info-content v31-viewer-info-empty"><p>방송 정보를 확인할 수 없어요.</p></section>', footer: F.btn('닫기', 'close-modal')};
    const description = info.description ? `<div class="v31-viewer-info-description">${info.description.split(/\n{2,}/).map(paragraph => `<p>${e(paragraph).replaceAll('\n', '<br>')}</p>`).join('')}</div>` : '';
    const channel = info.name ? `<button type="button" class="v31-viewer-info-channel" data-action="v31-viewer-channel" data-channel-index="${info.index}" aria-label="${e(info.name)} 채널 보기">${F.avatar(info.initial, 'round')}<span class="v31-viewer-info-channel-copy"><strong>${e(info.name)}</strong>${info.handle ? `<small>@${e(info.handle)}</small>` : ''}</span>${F.icon('right')}</button>` : '';
    const meta = info.category || info.ended ? `<div class="v31-viewer-info-meta">${info.category ? `<span class="v31-viewer-info-category">${e(info.category)}</span>` : ''}${info.ended ? '<span class="v31-viewer-info-ended">종료된 방송</span>' : ''}</div>` : '';
    return {...original, cls: 'v31-viewer-info', body: `<section class="v31-viewer-info-content">${info.title ? `<h3>${e(info.title)}</h3>` : ''}${meta}${channel}${description}</section>`};
  };

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.go === 'info' || button.dataset.action === 'go:info') {
      F.v31ViewerInfoContext = {index: selectedIndex(), state: F.viewState, base: F.currentBase || F.screen};
      return;
    }
    if (!button.dataset.action?.startsWith('v31-viewer-')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.dataset.action === 'v31-viewer-channel') {
      const index = Number(button.dataset.channelIndex);
      if (!Number.isInteger(index) || !F.broadcasts?.[index]) return;
      F.selectedBroadcast = index;
      F.channelTab = '홈';
      F.navigate('channel');
    }
  }, true);
})();
