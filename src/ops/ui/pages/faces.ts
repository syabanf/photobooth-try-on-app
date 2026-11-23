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
  const root = page('Wajah', `Setiap wajah yang dipotret gerbang dan booth, beserta namanya. Ketuk wajah untuk memberi nama. ${days ? `Wajah dihapus setelah ${days} hari.` : 'Wajah disimpan sampai ada yang menghapusnya.'}`);

  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Nama atau nomor tiket';
  search.value = view.query;
  search.addEventListener('change', () => {
    view.query = search.value;
    view.shown = PAGE;
    redraw();
  });
  const filters = el('div', 'ops-filters');
  filters.append(
    pills<FaceFilter>([{ value: 'all', label: 'Semua' }, { value: 'untagged', label: 'Tanpa nama' }, { value: 'tagged', label: 'Bernama' }], view.filter, (filter) => {
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
    img.alt = face.name || 'Wajah terpotret';
    img.loading = 'lazy';
    void blobUrl(face.image).then((url) => (img.src = url));
    card.append(img, faceName(face, 'Tanpa nama'), el('span', 'rank-meta', [ticket?.number, ops.boothName(face.boothId), dateTime(face.createdAt)].filter(Boolean).join(' · ')));
    card.addEventListener('click', () => tagFaceDialog(ops, face));
    grid.append(card);
  }

  root.body.append(
    statRow([
      { label: 'Wajah', value: String(faces.length) },
      { label: 'Bernama', value: String(tagged) },
      { label: 'Tanpa nama', value: String(faces.length - tagged) },
      { label: 'Tiket', value: String(tickets.size), hint: 'Rombongan yang dipotret gerbang' },
    ]),
    filters,
  );
  if (matches.length === 0) {
    const [title, detail] = !faces.length
      ? ['Belum ada wajah', 'Wajah masuk saat Gerbang memindai tiket atau pelanggan memotret wajah di Preset AI.']
      : view.query
        ? ['Tidak ada wajah yang cocok', `Tidak ada yang cocok dengan "${view.query}". Kosongkan pencarian atau pilih Semua.`]
        : view.filter === 'untagged'
          ? ['Semua sudah bernama', 'Setiap wajah di sini sudah punya nama.']
          : ['Belum ada nama', 'Ketuk wajah di Semua untuk memberi nama.'];
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-title', title), el('p', 'empty-desc', detail));
    root.body.append(empty);
  } else {
    root.body.append(grid);
  }
  if (matches.length > view.shown) {
    root.body.append(act(`Tampilkan lagi · sisa ${count(matches.length - view.shown, 'wajah')}`, 'btn btn-outline btn-block', () => {
      view.shown += PAGE;
      redraw();
    }));
  }
  return root.root;
}
