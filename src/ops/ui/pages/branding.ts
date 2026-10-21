// Branding: the template editor. Colours, logo, the booth's welcome and thank-you lines, social
// links and the client's own domain, with a live preview of the booth screen and the gallery page.

import { blobUrl, deleteBlob, putBlob } from '../../blobs';
import type { Branding } from '../../model';
import type { PageContext } from '../router';
import { act, el, fileInput, notice, page, section } from '../kit';

let draft: Branding | null = null;

export function renderBranding({ ops, redraw }: PageContext): HTMLElement {
  const saved = ops.state.branding;
  draft ??= { ...saved };
  const current = draft;
  const root = page('Branding', 'What customers see on the booth and on their photo page. The preview updates as you type; Save applies it to every booth.');

  const layout = el('div', 'brand-layout');
  const form = el('div', 'form-stack brand-form');
  const preview = el('div', 'brand-preview');

  const field = (key: keyof Branding, label: string, type = 'text', hint = '') => {
    const wrap = el('label', 'field');
    const input = el(type === 'textarea' ? 'textarea' : 'input', type === 'color' ? 'input input-color' : 'input') as HTMLInputElement;
    if (type !== 'textarea') input.type = type;
    input.value = String(current[key] ?? '');
    input.addEventListener('input', () => {
      (current[key] as string) = input.value;
      paint();
    });
    wrap.append(el('span', 'field-label', label), input);
    if (hint) wrap.append(el('span', 'field-hint', hint));
    form.append(wrap);
  };
  field('brandName', 'Brand name');
  const colours = el('div', 'brand-colours');
  form.append(colours);
  field('accent', 'Accent', 'color');
  field('ink', 'Text and buttons', 'color');
  field('background', 'Background', 'color');
  for (const swatch of [...form.querySelectorAll('.field')].slice(1, 4)) colours.append(swatch);
  field('welcome', 'Booth start screen');
  field('thanks', 'Photo page heading');
  field('instagram', 'Instagram link');
  field('tiktok', 'TikTok link');
  field('website', 'Website');
  field('customDomain', 'Custom domain for photo links', 'text', 'Point a CNAME such as photos.yourbrand.com at the gallery service. QR codes then use it.');

  const logoInput = fileInput('image/*', async (file) => {
    if (current.logo && current.logo !== saved.logo) await deleteBlob(current.logo);
    current.logo = await putBlob(file);
    paint();
  });
  const logoRow = el('div', 'field');
  logoRow.append(el('span', 'field-label', 'Logo'), logoInput, act(current.logo ? 'Replace logo' : 'Upload logo', 'btn btn-outline btn-sm', () => logoInput.click(), 'upload'));
  form.prepend(logoRow);

  async function paint(): Promise<void> {
    const logo = await blobUrl(current.logo);
    preview.style.setProperty('--brand-accent', current.accent);
    preview.style.setProperty('--brand-ink', current.ink);
    preview.style.setProperty('--brand-bg', current.background);
    const booth = el('div', 'preview-screen preview-booth');
    const mark = logo ? Object.assign(el('img', 'preview-logo'), { src: logo, alt: '' }) : el('span', 'preview-name', current.brandName || ops.account.business);
    booth.append(mark, el('p', 'preview-hero', current.welcome || 'Tap to start'), el('span', 'preview-button', 'Start'));
    const gallery = el('div', 'preview-screen preview-gallery');
    const thumbs = el('div', 'preview-thumbs');
    for (let i = 0; i < 4; i++) thumbs.append(el('span', 'preview-thumb'));
    const links = el('div', 'preview-links');
    for (const [label, value] of [['Instagram', current.instagram], ['TikTok', current.tiktok], ['Website', current.website]]) if (value) links.append(el('span', 'preview-link', label));
    gallery.append(
      logo ? Object.assign(el('img', 'preview-logo'), { src: logo, alt: '' }) : el('span', 'preview-name', current.brandName || ops.account.business),
      el('p', 'preview-sub', current.thanks || 'Your photos'),
      thumbs,
      el('span', 'preview-button', 'Download all'),
      links,
      el('p', 'preview-url', `${current.customDomain.trim() || location.host}/g/…`),
    );
    preview.replaceChildren(el('p', 'kicker', 'Booth screen'), booth, el('p', 'kicker', 'Photo page on the phone'), gallery);
  }
  void paint();

  const changed = JSON.stringify(current) !== JSON.stringify(saved);
  root.actions.append(
    act('Reset', 'btn btn-ghost', () => {
      draft = null;
      redraw();
    }),
    act('Save', changed ? 'btn btn-primary' : 'btn btn-primary', () => {
      const domain = current.customDomain.trim();
      if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.replace(/^https?:\/\//, '').replace(/\/$/, ''))) throw new Error(`${domain} is not a domain name.`);
      ops.edit('branding.manage', 'branding.save', 'Updated the branding.', (state) => {
        state.branding = { ...current, customDomain: domain };
      });
      draft = null;
      notice('Branding saved.', 'ok');
    }),
  );

  const formSection = section('Brand');
  formSection.body.append(form);
  layout.append(formSection.root, preview);
  root.body.append(layout);
  return root.root;
}
