// The tag panel: one face large, who it is, and where it was taken. The Gate, the booth's face
// list and the Faces page all open this same dialog.

import { confirmDialog, openDialog } from '../../dialogs';
import { blobUrl } from '../blobs';
import { knownNames, NAME_LIMIT } from '../face-tags';
import type { FaceRecord } from '../model';
import type { Ops } from '../ops';
import { dateTime, el, notice } from './kit';

let formCount = 0;

/** The caption under a face tile: its name, or a muted prompt to add one. */
export function faceName(face: FaceRecord, empty = 'Tambah nama'): HTMLElement {
  return el('span', `face-name${face.name ? '' : ' is-empty'}`, face.name || empty);
}

/** The caption as a button under a face tile, opening the tag panel for that face. */
export function nameButton(ops: Ops, face: FaceRecord): HTMLButtonElement {
  const button = el('button', 'face-name-btn');
  button.type = 'button';
  button.setAttribute('aria-label', face.name ? `Ganti nama ${face.name}` : 'Beri nama wajah ini');
  button.append(faceName(face));
  button.addEventListener('click', () => tagFaceDialog(ops, face));
  return button;
}

export function tagFaceDialog(ops: Ops, face: FaceRecord): void {
  const ticket = ops.state.tickets.find((entry) => entry.id === face.ticketId) ?? null;

  const picture = el('img', 'face-tag-photo');
  picture.alt = face.name || 'Wajah yang dipotret';
  void blobUrl(face.image).then((url) => (picture.src = url));

  const form = el('form', 'form-stack');
  form.id = `face-tag-${++formCount}`;
  const label = el('label', 'field');
  const input = el('input', 'input');
  input.name = 'name';
  input.value = face.name;
  input.maxLength = NAME_LIMIT;
  input.placeholder = 'Siapa ini?';
  input.autocomplete = 'off';
  const list = el('datalist');
  list.id = `${form.id}-names`;
  for (const name of knownNames(ops.state.faces, ticket)) list.append(new Option(name));
  input.setAttribute('list', list.id);
  label.append(el('span', 'field-label', 'Nama'), input, list);
  const facts = el('dl', 'facts');
  for (const [term, value] of [
    ['Tiket', ticket ? [ticket.number, ticket.name].filter(Boolean).join(' · ') : 'Tidak ada, dipotret di booth'],
    ['Dipotret di', ops.boothName(face.boothId)],
    ['Waktu', dateTime(face.createdAt)],
  ]) {
    facts.append(el('dt', '', term), el('dd', '', value));
  }
  form.append(label, facts);

  const remove = el('button', 'btn btn-ghost btn-danger', 'Hapus wajah');
  remove.type = 'button';
  const cancel = el('button', 'btn btn-outline', 'Batal');
  cancel.type = 'button';
  cancel.dataset.close = '';
  const save = el('button', 'btn btn-primary', 'Simpan');
  save.type = 'submit';
  save.setAttribute('form', form.id);

  const handle = openDialog({ title: face.name || 'Beri nama wajah ini', description: 'Nama tampil di bawah wajah di booth dan di halaman Wajah. Nama ikut terhapus bersama wajahnya.', body: [picture, form], footer: [remove, cancel, save] });
  setTimeout(() => input.focus());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      ops.tagFace(face.id, input.value);
      handle.close();
    } catch (error) {
      notice((error as Error).message, 'error');
    }
  });
  remove.addEventListener('click', () => {
    handle.close();
    confirmDialog({
      title: 'Hapus wajah ini?',
      message: 'Wajah dan namanya keluar dari daftar wajah dan tidak bisa dipakai lagi. Foto yang sudah dibuat dengannya tetap ada di galeri.',
      confirmLabel: 'Hapus',
      run: () => ops.deleteFace(face.id),
    });
  });
}
