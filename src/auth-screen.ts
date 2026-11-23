// The sign-in screen (sign in, create an account, set a password from a code, secure an old
// workspace) and the account sheet behind the avatar pill.

import type { AccountBackend } from './account/backend';
import { TRIAL_DAYS, TRIAL_LIMITS, initials, trialDaysLeft, trialExpired, type Account, type Session } from './account/model';
import { PASSWORD_RULES } from './account/password';
import { clearErrors, openDialog, showError } from './dialogs';
import { el } from './dom';
import { icon } from './icons';
import { uuid } from './uuid';

const longDate = (time: number) => new Date(time).toLocaleDateString('id-ID', { dateStyle: 'long' });
const daysLeftText = (days: number) => `sisa ${days} hari`;

type View = { kind: 'signin' | 'register' | 'forgot' } | { kind: 'code'; code: string } | { kind: 'claim'; account: Account } | { kind: 'expired'; session: Session };

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
  if (existing && !trialExpired(existing.account, Date.now()) && !inviteCode) return existing;

  const screen = document.querySelector<HTMLElement>('#authScreen')!;
  const card = document.querySelector<HTMLElement>('#authCard')!;
  screen.hidden = false;

  return new Promise((resolve) => {
    function finish(session: Session): void {
      if (trialExpired(session.account, Date.now())) {
        void show({ kind: 'expired', session });
        return;
      }
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
      const parts: HTMLElement[] = [head('Masuk', 'Pakai email yang dibuatkan pemilik usaha untuk Anda.'), signIn, footer('Baru di sini? ', linkButton('Buat akun', () => show({ kind: 'register' }))), footer('Dapat kode dari pemilik? ', linkButton('Atur kata sandi', () => show({ kind: 'code', code: '' })))];

      const waiting = await backend.unclaimed();
      if (waiting.length) {
        const group = el('div', 'pick-group auth-claim');
        group.append(el('p', 'kicker', 'Belum ada pemilik'), el('p', 'card-desc', 'Usaha ini dibuka sebelum ada fitur masuk. Amankan dengan email Anda agar tetap bisa dipakai.'));
        for (const account of waiting) {
          const row = el('button', 'pick-row');
          row.type = 'button';
          const text = el('span', 'pick-text');
          text.append(el('span', 'pick-name', account.business), el('span', 'card-desc', 'Ketuk untuk menambah pemilik'));
          row.append(el('span', 'avatar', initials(account.business)), text, icon('shield'));
          row.addEventListener('click', () => show({ kind: 'claim', account }));
          group.append(row);
        }
        parts.push(group);
      }
      return parts;
    }

    function registerView(): HTMLElement[] {
      const register = form(
        [
          field({ name: 'business', label: 'Nama usaha', autocomplete: 'organization', placeholder: 'Dusun Bambu', value: 'Dusun Bambu' }),
          field({ name: 'name', label: 'Nama Anda', autocomplete: 'name', placeholder: 'Contoh: Rizky Pratama' }),
          field({ name: 'email', label: 'Email kerja', type: 'email', autocomplete: 'email', placeholder: 'Contoh: nama@dusunbambu.id' }),
          field({ name: 'password', label: 'Kata sandi', type: 'password', autocomplete: 'new-password' }),
        ],
        'Buat akun',
        'Menyiapkan usaha Anda…',
        (values, key) => backend.register({ business: values.business, name: values.name, email: values.email, password: values.password }, key),
      );
      register.querySelector('[data-error-for="password"]')!.before(passwordChecklist(register));
      return [head('Buat akun', `Anda menjadi pemilik. ${TRIAL_DAYS} hari pertama gratis, untuk maksimal ${TRIAL_LIMITS.locations} lokasi dan ${TRIAL_LIMITS.points} booth.`), register, footer('Sudah punya akun? ', linkButton('Masuk', () => show({ kind: 'signin' })))];
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

    function claimView(account: Account): HTMLElement[] {
      const claim = form(
        [
          field({ name: 'name', label: 'Nama Anda', autocomplete: 'name' }),
          field({ name: 'email', label: 'Email kerja', type: 'email', autocomplete: 'email' }),
          field({ name: 'password', label: 'Kata sandi', type: 'password', autocomplete: 'new-password' }),
        ],
        `Amankan ${account.business}`,
        'Mengamankan…',
        (values, key) => backend.claim(account.id, { name: values.name, email: values.email, password: values.password }, key),
      );
      claim.querySelector('[data-error-for="password"]')!.before(passwordChecklist(claim));
      return [head(`Amankan ${account.business}`, 'Lokasi, booth dan penjualannya tetap seperti semula. Mulai sekarang, semua orang harus masuk untuk membukanya.'), claim, footer(linkButton('Kembali ke halaman masuk', () => show({ kind: 'signin' })))];
    }

    function forgotView(): HTMLElement[] {
      const steps = el('ol', 'auth-steps');
      for (const step of ['Hubungi pemilik, admin atau supervisor usaha Anda.', 'Mereka membuka Tim dan akses, Pengguna, memilih nama Anda lalu mengetuk Reset kata sandi.', 'Mereka memberi kode baru. Masukkan kode itu untuk membuat kata sandi baru.']) steps.append(el('li', '', step));
      const code = el('button', 'btn btn-primary btn-lg btn-block', 'Saya punya kode');
      code.type = 'button';
      code.addEventListener('click', () => show({ kind: 'code', code: '' }));
      return [head('Lupa kata sandi?', 'Pemilik usaha yang meresetnya untuk Anda. Orang di luar tim tidak bisa.'), steps, code, footer(linkButton('Kembali ke halaman masuk', () => show({ kind: 'signin' })))];
    }

    function expiredView(session: Session): HTMLElement[] {
      const out = el('button', 'btn btn-outline btn-block');
      out.type = 'button';
      out.append(icon('logout'), 'Masuk dengan akun lain');
      out.addEventListener('click', async () => {
        await backend.signOut();
        show({ kind: 'signin' });
      });
      return [head('Masa coba sudah berakhir', `Masa coba ${session.account.business} berakhir pada ${longDate(session.account.trialEndsAt)}. Lokasi, booth dan penjualannya tetap disimpan sampai paket dilanjutkan.`), out];
    }

    async function show(view: View): Promise<void> {
      const parts =
        view.kind === 'signin' ? await signInView()
        : view.kind === 'register' ? registerView()
        : view.kind === 'code' ? await codeView(view.code)
        : view.kind === 'claim' ? claimView(view.account)
        : view.kind === 'expired' ? expiredView(view.session)
        : forgotView();
      card.replaceChildren(...parts);
      [...card.querySelectorAll<HTMLInputElement>('input')].find((input) => !input.value)?.focus();
    }

    if (inviteCode) void show({ kind: 'code', code: decodeURIComponent(inviteCode) });
    else if (existing) void show({ kind: 'expired', session: existing });
    else void show({ kind: 'signin' });
  });
}

/** The avatar pill in the header: who is signed in, the trial, password and sign out. */
export function mountAccountButton(backend: AccountBackend, session: Session, role: () => { label: string; seesPlan: boolean }): void {
  const { account, member } = session;
  const button = document.querySelector<HTMLButtonElement>('#accountButton')!;
  const daysLeft = trialDaysLeft(account, Date.now());
  const daysText = daysLeftText(daysLeft);
  document.querySelector('#accountInitials')!.textContent = initials(member.name);
  const trial = document.querySelector<HTMLElement>('#accountTrial')!;
  trial.textContent = `Masa coba · ${daysText}`;
  trial.dataset.urgent = String(daysLeft <= 3);
  button.setAttribute('aria-label', `Akun ${member.name}`);

  button.addEventListener('click', () => {
    const who = el('div', 'account-who');
    const text = el('div');
    const { label, seesPlan } = role();
    text.append(el('p', 'device-name', member.name), el('p', 'card-desc', `${member.email} · ${label} di ${account.business}`));
    who.append(el('span', 'avatar avatar--lg', initials(member.name)), text);

    const meter = el('div', 'trial-meter');
    const top = el('div', 'trial-meter-head');
    top.append(el('span', 'kicker', 'Masa coba gratis'), el('strong', '', daysText));
    const bar = el('div', 'meter');
    const fill = el('span');
    fill.style.width = `${(daysLeft / TRIAL_DAYS) * 100}%`;
    bar.append(fill);
    meter.append(top, bar, el('p', 'field-hint', `Berakhir ${longDate(account.trialEndsAt)}. Berlaku untuk maksimal ${TRIAL_LIMITS.locations} lokasi dan ${TRIAL_LIMITS.points} booth.`));

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
    // The trial is the owner's business; the crew sees who they are and how to sign out.
    const handle = openDialog({ title: 'Akun Anda', body: seesPlan ? [who, meter] : [who], footer: [password, signOut] });
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
