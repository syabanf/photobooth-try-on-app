// Frames: print templates with transparent windows. Smart Frame finds the windows on upload;
// categories group them at the booth; stats show which sell.

import { confirmDialog, formDialog } from '../../../dialogs';
import { iconButton } from '../../../icons';
import { blobUrl, deleteBlob, putBlob } from '../../blobs';
import { detectSlots } from '../../frames';
import type { Frame, PaperSize, Preset } from '../../model';
import { LAYOUT_LABELS } from '../../presets';
import { PAPER, PAPER_SIZES } from '../../printing';
import type { PageContext } from '../router';
import { act, badge, el, fileInput, notice, page, pills, section, table } from '../kit';

const view = { category: '' };

async function readFrame(file: File): Promise<{ width: number; height: number; slots: Frame['slots'] }> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { width: bitmap.width, height: bitmap.height, slots: detectSlots(data, bitmap.width, bitmap.height) };
}

export function renderFrames({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Frames', 'Upload a PNG with transparent windows. Smart Frame finds each window and the shots fill them in order.');
  const upload = fileInput('image/png', async (file) => {
    try {
      const info = await readFrame(file);
      if (info.slots.length === 0) throw new Error('No transparent window found. Export the frame as a PNG with see-through holes.');
      const image = await putBlob(file);
      const frame: Frame = { id: ops.store.id(), name: file.name.replace(/\.png$/i, ''), category: view.category || 'General', size: '4R', image, ...info, active: true };
      ops.edit('frames.manage', 'frame.add', `Added frame ${frame.name} with ${info.slots.length} slots.`, (draft) => draft.frames.push(frame));
      notice(`Found ${info.slots.length} photo ${info.slots.length === 1 ? 'slot' : 'slots'}.`, 'ok');
    } catch (error) {
      notice((error as Error).message, 'error');
    }
  });
  root.actions.append(upload, act('Upload frame', 'btn btn-primary', () => upload.click(), 'upload'));

  const categories = [...new Set(state.frames.map((frame) => frame.category))].sort();
  if (categories.length > 1) {
    root.body.append(
      pills([{ value: '', label: 'All' }, ...categories.map((category) => ({ value: category, label: category }))], view.category, (category) => {
        view.category = category;
        redraw();
      }),
    );
  }

  // Best-selling: sessions per frame, all time.
  const sold = new Map<string, number>();
  for (const session of state.sessions) if (session.frameId) sold.set(session.frameId, (sold.get(session.frameId) ?? 0) + 1);
  const locked = new Set(state.vouchers.flatMap((voucher) => voucher.frameIds));

  const grid = el('div', 'frame-grid');
  const frames = state.frames.filter((frame) => !view.category || frame.category === view.category).sort((a, b) => (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0));
  if (frames.length === 0) grid.append(el('p', 'card-desc', 'No frames yet. Sessions print on the plain strip until you add one.'));
  for (const frame of frames) {
    const card = el('article', 'frame-card');
    const preview = el('div', 'frame-preview');
    const img = el('img');
    img.alt = frame.name;
    void blobUrl(frame.image).then((url) => (img.src = url));
    preview.append(img);
    // The detected slots, drawn over the preview so the operator can check them.
    for (const [index, slot] of frame.slots.entries()) {
      const box = el('span', 'frame-slot', String(index + 1));
      Object.assign(box.style, { left: `${(slot.x / frame.width) * 100}%`, top: `${(slot.y / frame.height) * 100}%`, width: `${(slot.width / frame.width) * 100}%`, height: `${(slot.height / frame.height) * 100}%` });
      preview.append(box);
    }
    const meta = el('div', 'frame-meta');
    const text = el('div', 'rank-text');
    text.append(el('span', 'rank-name', frame.name), el('span', 'rank-meta', `${frame.category} · ${frame.size} · ${frame.slots.length} slots · ${sold.get(frame.id) ?? 0} sessions`));
    const edit = iconButton('edit', `Edit ${frame.name}`);
    edit.addEventListener('click', () => editFrame(ops, frame));
    meta.append(text, edit);
    const tags = el('div', 'frame-tags');
    if (!frame.active) tags.append(badge('Hidden', 'muted'));
    if (locked.has(frame.id)) tags.append(badge('Voucher only', 'info'));
    card.append(preview, meta, tags);
    grid.append(card);
  }
  root.body.append(grid, presetsSection(ops));
  return root.root;
}

/** AI presets: the templates the face page fills, each with the prompt the AI redraws it from. */
function presetsSection(ops: PageContext['ops']): HTMLElement {
  const part = section('AI presets', 'Customers capture their face on the AI presets page and see it in every active template below, plus every active frame. The prompt tells the AI how to redraw the one they pick.');
  part.actions.append(act('Add preset', 'btn btn-outline btn-sm', () => editPreset(ops), 'plus'));
  part.body.append(
    table(
      [
        { label: 'Preset', cell: (preset: Preset) => preset.name },
        { label: 'Layout', cell: (preset) => (preset.layout === 'frame' ? `Frame · ${ops.state.frames.find((f) => f.id === preset.frameId)?.name ?? 'missing'}` : LAYOUT_LABELS[preset.layout]) },
        { label: 'AI prompt', cell: (preset) => preset.prompt },
        { label: 'Status', cell: (preset) => badge(preset.active ? 'On' : 'Off', preset.active ? 'ok' : 'muted') },
      ],
      ops.state.aiPresets,
      { empty: 'No presets.', onRow: (preset) => editPreset(ops, preset) },
    ),
  );
  return part.root;
}

function editPreset(ops: PageContext['ops'], preset?: Preset): void {
  formDialog({
    title: preset ? `Edit ${preset.name}` : 'Add AI preset',
    description: 'Decart asks for 20 to 30 words: the look you want, the light, and what must stay.',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: preset?.name ?? '', placeholder: 'Graduation portrait' },
      { name: 'layout', label: 'Layout', value: preset?.layout ?? 'cover', options: (Object.keys(LAYOUT_LABELS) as Preset['layout'][]).map((layout) => ({ value: layout, label: LAYOUT_LABELS[layout] })) },
      { name: 'frameId', label: 'Frame (for the frame layout)', value: preset?.frameId ?? '', options: [{ value: '', label: 'None' }, ...ops.state.frames.map((frame) => ({ value: frame.id, label: frame.name }))] },
      { name: 'prompt', label: 'AI prompt', value: preset?.prompt ?? '', type: 'textarea', placeholder: 'Restyle as a graduation portrait: navy studio backdrop, soft key light, gown and cap, proud smile kept as it is.' },
      { name: 'active', label: 'Show on the AI presets page', value: preset?.active ?? true },
    ],
    danger: preset && !preset.builtIn ? { label: 'Delete', run: (close) => { ops.edit('frames.manage', 'preset.delete', `Deleted AI preset ${preset.name}.`, (draft) => { draft.aiPresets = draft.aiPresets.filter((entry) => entry.id !== preset.id); }); close(); } } : undefined,
    async submit(values) {
      const name = String(values.name).trim();
      const prompt = String(values.prompt).trim();
      const layout = values.layout as Preset['layout'];
      if (!name) throw new Error('Enter a name.');
      if (prompt.split(/\s+/).length < 8) throw new Error('Write a fuller prompt: the look, the light, and what must stay.');
      if (layout === 'frame' && !values.frameId) throw new Error('Pick the frame for this layout.');
      ops.edit('frames.manage', 'preset.save', `Saved AI preset ${name}.`, (draft) => {
        const fields = { name, layout, prompt, frameId: layout === 'frame' ? String(values.frameId) : null, active: values.active as boolean };
        const existing = draft.aiPresets.find((entry) => entry.id === preset?.id);
        if (existing) Object.assign(existing, fields);
        else draft.aiPresets.push({ id: ops.store.id(), builtIn: false, ...fields });
      });
    },
  });
}

function editFrame(ops: PageContext['ops'], frame: Frame): void {
  formDialog({
    title: `Edit ${frame.name}`,
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: frame.name },
      { name: 'category', label: 'Category', value: frame.category, placeholder: 'Wedding, Birthday, Brand' },
      { name: 'size', label: 'Print size', value: frame.size, options: PAPER_SIZES.map((size) => ({ value: size, label: PAPER[size].label })) },
      { name: 'active', label: 'Show at the booth', value: frame.active },
    ],
    danger: {
      label: 'Delete',
      run: (close) => {
        close();
        confirmDialog({
          title: `Delete ${frame.name}?`,
          message: 'Sessions printed with it keep their record.',
          confirmLabel: 'Delete frame',
          async run() {
            await deleteBlob(frame.image);
            ops.edit('frames.manage', 'frame.delete', `Deleted frame ${frame.name}.`, (draft) => {
              draft.frames = draft.frames.filter((entry) => entry.id !== frame.id);
              for (const voucher of draft.vouchers) voucher.frameIds = voucher.frameIds.filter((id) => id !== frame.id);
            });
          },
        });
      },
    },
    async submit(values) {
      const name = String(values.name).trim();
      if (!name) throw new Error('Enter a name.');
      ops.edit('frames.manage', 'frame.save', `Updated frame ${name}.`, (draft) => {
        Object.assign(draft.frames.find((entry) => entry.id === frame.id)!, { name, category: String(values.category).trim() || 'General', size: values.size as PaperSize, active: values.active as boolean });
      });
    },
  });
}
