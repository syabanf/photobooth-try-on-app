// The sign-in screen (sign in, set up the owner on a fresh device, set a password from a code) and
// the account sheet behind the avatar pill.

import type { AccountBackend } from './account/backend';
import { BUSINESS, initials, type Session } from './account/model';
import { PASSWORD_RULES } from './account/password';
import { clearErrors, openDialog, showError } from './dialogs';
import { el } from './dom';
import { icon } from './icons';
import { uuid } from './uuid';

type View = { kind: 'signin' | 'owner' | 'forgot' } | { kind: 'code'; code: string };

interface FieldSpec {
  name: string;
  label: string;
  type?: string;
  autocomplete?: string;
  placeholder?: string;
  value?: string;
  hint?: string;
}

function errorSlot(field: string): HTMLParagraphElement {
  const slot = el('p', 'field-error');
  slot.dataset.errorFor = field;
  slot.hidden = true;
  return slot;
}

/** A labelled input with its error line. Password inputs get a show button and a Caps Lock note. */
function field(spec: FieldSpec): HTMLElement {
  const label = el('label', 'field');
  const input = el('input', 'input');
  input.name = spec.name;
  input.type = spec.type ?? 'text';
  input.autocomplete = (spec.autocomplete ?? 'off') as AutoFill;
  input.placeholder = spec.placeholder ?? '';
  input.value = spec.value ?? '';
  input.spellcheck = false;
  label.append(el('span', 'field-label', spec.label));
  if (spec.type === 'password') {
    const wrap = el('span', 'input-wrap');
    const toggle = el('button', 'input-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Tampilkan kata sandi');
    toggle.append(icon('eye'));
    toggle.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      toggle.setAttribute('aria-label', shown ? 'Tampilkan kata sandi' : 'Sembunyikan kata sandi');
      toggle.replaceChildren(icon(shown ? 'eye' : 'eyeOff'));
      input.focus();
    });
    wrap.append(input, toggle);
    const caps = el('span', 'field-hint caps-note', 'Caps Lock menyala.');
    caps.hidden = true;
    input.addEventListener('keyup', (event) => (caps.hidden = !event.getModifierState?.('CapsLock')));
    label.append(wrap, caps);
  } else {
    label.append(input);
  }
  if (spec.hint) label.append(el('span', 'field-hint', spec.hint));
  label.append(errorSlot(spec.name));
  return label;
}

/** The live checklist under a new password, ticking each rule as the person types. */
function passwordChecklist(form: HTMLFormElement, name = 'password'): HTMLElement {
  const list = el('ul', 'pw-rules');
  const items = PASSWORD_RULES.map((rule) => {
    const item = el('li', '', rule.label);
    list.append(item);
    return { rule, item };
  });
  const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const update = () => {
    for (const { rule, item } of items) item.classList.toggle('is-met', rule.test(input.value));
  };
  input.addEventListener('input', update);
  update();
  return list;
}

function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'link', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** Resolves with the signed-in session, showing the sign-in screen first when nobody is signed in. */
export async function signedIn(backend: AccountBackend): Promise<Session> {
  const existing = await backend.session();
  const inviteCode = /#invite=([^&]+)/.exec(location.hash)?.[1];
  if (existing && !inviteCode) return existing;

  const screen = document.querySelector<HTMLElement>('#authScreen')!;
  const card = document.querySelector<HTMLElement>('#authCard')!;
  screen.hidden = false;

  return new Promise((resolve) => {
    function finish(session: Session): void {
      if (inviteCode) history.replaceState(null, '', location.pathname);
      screen.hidden = true;
      resolve(session);
    }

    /**
     * One form per view. Its idempotency key lives as long as the view, so a double tap or a retry
     * after a dropped connection creates one account, not two.
     */
    function form(fields: HTMLElement[], submitLabel: string, busyLabel: string, run: (values: Record<string, string>, key: string) => Promise<Session | void>): HTMLFormElement {
      const key = uuid();
      const element = el('form', 'form-stack');
      element.noValidate = true;
      const submit = el('button', 'btn btn-primary btn-lg btn-block', submitLabel);
      submit.type = 'submit';
      element.append(errorSlot('form'), ...fields, submit);
      element.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        clearErrors(element);
        submit.disabled = true;
        submit.textContent = busyLabel;
        try {
          const values = Object.fromEntries([...new FormData(element)].map(([name, value]) => [name, String(value)]));
          const session = await run(values, key);
          if (session) finish(session);
        } catch (error) {
          showError(element, error);
        } finally {
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
      return element;
    }

    function head(title: string, description: string): HTMLElement {
      const block = el('div', 'auth-head');
      const heading = el('h2', 'auth-title', title);
      heading.append(el('span', 'accent-dot', '.'));
      block.append(heading, el('p', 'card-desc', description));
      return block;
    }

    function footer(...items: (HTMLElement | string)[]): HTMLElement {
      const row = el('p', 'auth-switch');
      row.append(...items);
      return row;
    }

    async function signInView(): Promise<HTMLElement[]> {
      const signIn = form(
        [field({ name: 'email', label: 'Email', type: 'email', autocomplete: 'username', placeholder: 'Contoh: nama@dusunbambu.id' }), field({ name: 'password', label: 'Kata sandi', type: 'password', autocomplete: 'current-password' })],
        'Masuk',
        'Sedang masuk…',
        (values) => backend.signIn(values.email, values.password),
      );
      const forgot = linkButton('Lupa kata sandi?', () => show({ kind: 'forgot' }));
      forgot.classList.add('auth-forgot');
      signIn.querySelector('[data-error-for="password"]')!.after(forgot);
      return [head('Masuk', 'Pakai email yang dibuatkan pemilik usaha untuk Anda.'), signIn, footer('Dapat kode dari pemilik? ', linkButton('Atur kata sandi', () => show({ kind: 'code', code: '' })))];
    }

    /** A fresh device, or records kept from before sign-in: the owner comes first, once. */
    function ownerView(): HTMLElement[] {
      const setup = form(
        [
          field({ name: 'name', label: 'Nama Anda', autocomplete: 'name', placeholder: 'Contoh: Rizky Pratama' }),
          field({ name: 'email', label: 'Email kerja', type: 'email', autocomplete: 'email', placeholder: 'Contoh: nama@dusunbambu.id' }),
          field({ name: 'password', label: 'Kata sandi', type: 'password', autocomplete: 'new-password' }),
        ],
        'Simpan dan masuk',
        'Menyimpan…',
        (values, key) => backend.setupOwner({ name: values.name, email: values.email, password: values.password }, key),
      );
      setup.querySelector('[data-error-for="password"]')!.before(passwordChecklist(setup));
      return [head(`Atur pemilik ${BUSINESS}`, 'Perangkat ini belum punya pemilik. Pemilik mengatur booth, harga dan tim, lalu mengundang staf lain lewat kode.'), setup, footer('Dapat kode dari pemilik? ', linkButton('Atur kata sandi', () => show({ kind: 'code', code: '' })))];
    }

    async function codeView(code: string): Promise<HTMLElement[]> {
      const back = footer(linkButton('Kembali ke halaman masuk', () => show({ kind: 'signin' })));
      if (code) {
        try {
          const { account, member } = await backend.inviteFor(code);
          const setPassword = form(
            [field({ name: 'password', label: 'Kata sandi baru', type: 'password', autocomplete: 'new-password' })],
            'Simpan kata sandi dan masuk',
            'Menyimpan…',
            (values, key) => backend.acceptInvite(code, values.password, key),
          );
          setPassword.querySelector('[data-error-for="password"]')!.before(passwordChecklist(setPassword));
          const who = el('div', 'auth-who');
          who.append(el('span', 'avatar avatar--lg', initials(member.name)), el('div'));
          who.lastElementChild!.append(el('p', 'device-name', member.name), el('p', 'card-desc', `${member.email} · ${account.business}`));
          return [head(`Selamat datang, ${member.name.split(' ')[0]}`, 'Buat kata sandi. Mulai sekarang, masuk dengan email dan kata sandi ini.'), who, setPassword, back];
        } catch (error) {
          // A bad code falls through to the code box, with the reason under it.
          const parts = await codeView('');
          showError(parts[1], error);
          return parts;
        }
      }
      const enter = form(
        [field({ name: 'code', label: 'Kode', placeholder: 'K7QM-2XPA', autocomplete: 'one-time-code', hint: '8 karakter dari pemilik atau supervisor Anda.' })],
        'Lanjut',
        'Memeriksa…',
        async (values) => {
          await backend.inviteFor(values.code);
          show({ kind: 'code', code: values.code });
        },
      );
      return [head('Atur kata sandi', 'Pakai kode yang Anda terima saat bergabung atau saat kata sandi direset.'), enter, back];
    }

    function forgotView(): HTMLElement[] {
      const steps = el('ol', 'auth-steps');
      for (const step of ['Hubungi pemilik, admin atau supervisor usaha Anda.', 'Mereka membuka Tim dan akses, Pengguna, memilih nama Anda lalu mengetuk Reset kata sandi.', 'Mereka memberi kode baru. Masukkan kode itu untuk membuat kata sandi baru.']) steps.append(el('li', '', step));
      const code = el('button', 'btn btn-primary btn-lg btn-block', 'Saya punya kode');
      code.type = 'button';
      code.addEventListener('click', () => show({ kind: 'code', code: '' }));
      return [head('Lupa kata sandi?', 'Pemilik usaha yang meresetnya untuk Anda. Orang di luar tim tidak bisa.'), steps, code, footer(linkButton('Kembali ke halaman masuk', () => show({ kind: 'signin' })))];
    }

    async function show(view: View): Promise<void> {
      const parts =
        view.kind === 'signin' ? await signInView()
        : view.kind === 'owner' ? ownerView()
        : view.kind === 'code' ? await codeView(view.code)
        : forgotView();
      card.replaceChildren(...parts);
      [...card.querySelectorAll<HTMLInputElement>('input')].find((input) => !input.value)?.focus();
    }

    if (inviteCode) void show({ kind: 'code', code: decodeURIComponent(inviteCode) });
    else void backend.needsOwner().then((fresh) => show({ kind: fresh ? 'owner' : 'signin' }));
  });
}

/** The avatar pill in the header: who is signed in, their password and sign out. */
export function mountAccountButton(backend: AccountBackend, session: Session, role: () => string): void {
  const { account, member } = session;
  const button = document.querySelector<HTMLButtonElement>('#accountButton')!;
  document.querySelector('#accountInitials')!.textContent = initials(member.name);
  button.setAttribute('aria-label', `Akun ${member.name}`);

  button.addEventListener('click', () => {
    const who = el('div', 'account-who');
    const text = el('div');
    text.append(el('p', 'device-name', member.name), el('p', 'card-desc', `${member.email} · ${role()} di ${account.business}`));
    who.append(el('span', 'avatar avatar--lg', initials(member.name)), text);

    const password = el('button', 'btn btn-ghost');
    password.type = 'button';
    password.append(icon('key'), 'Ganti kata sandi');
    password.addEventListener('click', () => {
      handle.close();
      changePassword(backend);
    });
    const signOut = el('button', 'btn btn-outline');
    signOut.type = 'button';
    signOut.append(icon('logout'), 'Keluar');
    signOut.addEventListener('click', async () => {
      await backend.signOut();
      // A reload stops the camera and every model, and lands on the sign-in screen.
      location.reload();
    });
    const handle = openDialog({ title: 'Akun Anda', body: [who], footer: [password, signOut] });
  });
}

function changePassword(backend: AccountBackend): void {
  const form = el('form', 'form-stack');
  form.id = 'changePassword';
  form.noValidate = true;
  form.append(errorSlot('form'), field({ name: 'current', label: 'Kata sandi sekarang', type: 'password', autocomplete: 'current-password' }), field({ name: 'next', label: 'Kata sandi baru', type: 'password', autocomplete: 'new-password' }));
  form.querySelector('[data-error-for="next"]')!.before(passwordChecklist(form, 'next'));
  const cancel = el('button', 'btn btn-outline', 'Batal');
  cancel.type = 'button';
  cancel.dataset.close = '';
  const save = el('button', 'btn btn-primary', 'Simpan kata sandi');
  save.type = 'submit';
  save.setAttribute('form', form.id);
  const handle = openDialog({ title: 'Ganti kata sandi', description: 'Perangkat lain tetap masuk sampai keluar sendiri.', body: [form], footer: [cancel, save] });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    clearErrors(form);
    save.disabled = true;
    try {
      const values = new FormData(form);
      await backend.changePassword(String(values.get('current')), String(values.get('next')));
      handle.close();
    } catch (error) {
      showError(form, error);
    } finally {
      save.disabled = false;
    }
  });
}
