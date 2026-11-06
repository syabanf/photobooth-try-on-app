// Every face kept, with who it is. Staff name untagged faces, find a person or a party by name or
// ticket number, and delete faces. Faces leave on their own when the photo retention window ends.

import { seesBranch } from '../../access';
import { blobUrl } from '../../blobs';
import { searchFaces, type FaceFilter } from '../../face-tags';
import type { PageContext } from '../router';
import { faceName, tagFaceDialog } from '../face-tag';
import { act, count, dateTime, el, page, pills, statRow } from '../kit';

const PAGE = 48;
const view = { query: '', filter: 'all' as FaceFilter, shown: PAGE };

export function renderFaces({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const faces = state.faces.filter((face) => seesBranch(actor, ops.branchOf(face.boothId)));
  const tagged = faces.filter((face) => face.name).length;
  const tickets = new Set(faces.map((face) => face.ticketId).filter(Boolean));
  const days = state.settings.retentionDays;
  const root = page('Faces', `Every face the gate and the booths captured, with who it is. Tap a face to name it. ${days ? `Faces are deleted after ${days} days.` : 'Faces are kept until someone deletes them.'}`);

  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Name or ticket number';
  search.value = view.query;
  search.addEventListener('change', () => {
    view.query = search.value;
    view.shown = PAGE;
    redraw();
  });
  const filters = el('div', 'ops-filters');
  filters.append(
    pills<FaceFilter>([{ value: 'all', label: 'All' }, { value: 'untagged', label: 'No name' }, { value: 'tagged', label: 'Named' }], view.filter, (filter) => {
      view.filter = filter;
      view.shown = PAGE;
      redraw();
    }),
    search,
  );

  const matches = searchFaces(faces, state.tickets, view.query, view.filter);
  const grid = el('div', 'face-gallery');
  for (const face of matches.slice(0, view.shown)) {
    const ticket = state.tickets.find((entry) => entry.id === face.ticketId);
    const card = el('button', 'face-card');
    card.type = 'button';
    const img = el('img');
    img.alt = face.name || 'Captured face';
    img.loading = 'lazy';
    void blobUrl(face.image).then((url) => (img.src = url));
    card.append(img, faceName(face, 'No name'), el('span', 'rank-meta', [ticket?.number, ops.boothName(face.boothId), dateTime(face.createdAt)].filter(Boolean).join(' · ')));
    card.addEventListener('click', () => tagFaceDialog(ops, face));
    grid.append(card);
  }

  root.body.append(
    statRow([
      { label: 'Faces', value: String(faces.length) },
      { label: 'Named', value: String(tagged) },
      { label: 'No name', value: String(faces.length - tagged) },
      { label: 'Tickets', value: String(tickets.size), hint: 'Parties the gate photographed' },
    ]),
    filters,
  );
  if (matches.length === 0) {
    const [title, detail] = !faces.length
      ? ['No faces yet', 'Faces arrive when the Gate scans a ticket or a customer captures one in AI presets.']
      : view.query
        ? ['No face matches', `Nothing matches "${view.query}". Clear the search or pick All.`]
        : view.filter === 'untagged'
          ? ['Everyone has a name', 'Every face kept here is named.']
          : ['No names yet', 'Tap a face under All to name it.'];
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-title', title), el('p', 'empty-desc', detail));
    root.body.append(empty);
  } else {
    root.body.append(grid);
  }
  if (matches.length > view.shown) {
    root.body.append(act(`Show more · ${count(matches.length - view.shown, 'face')} left`, 'btn btn-outline btn-block', () => {
      view.shown += PAGE;
      redraw();
    }));
  }
  return root.root;
}
