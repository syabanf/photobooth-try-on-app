# Glosarium terjemahan UI staf (EN → ID)

Semua teks yang dilihat staf diterjemahkan ke Bahasa Indonesia, langsung di tempatnya (tanpa sistem i18n atau kamus runtime). Layar pelanggan (kiosk, TV, halaman foto, check-in) sudah berbahasa Indonesia; samakan istilahnya dengan daftar ini.

## Aturan gaya

- Kalimat pendek, kata kerja di depan untuk tombol: "Simpan", "Buka shift", "Tambah booth".
- Sapaan "Anda" hanya bila perlu. Lebih baik kalimat tanpa kata ganti: "Isi nama booth." bukan "Anda harus mengisi nama booth."
- Tanpa tanda pisah panjang (em dash —). Pakai titik, koma, atau titik dua.
- Hindari jargon teknis di layar staf. "Data belum terkirim" bukan "items waiting to sync".
- Huruf kapital hanya di awal kalimat dan nama diri: "Buka shift", bukan "Buka Shift".
- Angka rupiah tetap lewat `money()` / `formatRupiah` yang sudah ada.
- Tanggal dan jam: `toLocaleDateString('id-ID', …)`, `toLocaleTimeString('id-ID', …)`, `toLocaleString('id-ID', …)`. Jangan `undefined` atau `'en-US'`. Format id-ID sudah 24 jam ("17.11").
- Bahasa Indonesia tidak punya bentuk jamak: "1 pesanan", "3 pesanan". Hapus logika penambah "s".

## Yang TIDAK boleh diterjemahkan

- Identifier kode, nama tipe, key objek, nilai enum, `data-*`, nama class CSS, id elemen.
- Nilai `kind` pada activity log (mis. `'order.refund'`), id permission (`'pos.sell'`), id view (`'pos'`, `'session'`).
- String yang dibandingkan atau diurai kode (header CSV gateway di `parseGatewayCsv`, regex, nama format file). Cek dengan grep sebelum mengubah string yang muncul di `===`, `includes`, `startsWith`, `switch`.
- Komentar kode dan README (biarkan bahasa Inggris).
- Nama merek: QRIS, GoPay, DANA, OVO, Midtrans, Xendit, DOKU, Decart, Canon, Nikon, MacroDroid, Tasker.
- Teks `console.error` / `console.log`.

## Istilah

| English | Indonesia |
|---|---|
| Dashboard | Beranda |
| Point of sale (page) | Kasir |
| Cashier (role) | Kasir |
| Owner | Pemilik |
| Admin | Admin |
| Supervisor | Supervisor |
| Booth operator | Operator booth |
| Booth | Booth |
| Point (a booth/kiosk/gate unit) | Booth (atau "unit" bila perlu umum) |
| Location | Lokasi |
| Locations and booths | Lokasi dan booth |
| Branch | Cabang |
| Kiosk | Kiosk |
| Gate | Gerbang |
| Queue | Antrean |
| Ticket | Tiket |
| Check in | Check-in |
| Session | Sesi |
| Shift | Shift |
| Open shift / Close shift | Buka shift / Tutup shift |
| Opening cash | Modal awal |
| Counted cash / closing cash | Uang di laci |
| Cart | Keranjang |
| Charge Rp… | Bayar Rp… |
| Change (money back) | Kembalian |
| Change to give | Kembalian |
| Take cash | Terima tunai |
| Cash received | Uang diterima |
| Order | Pesanan |
| Void order | Batalkan pesanan |
| New sale | Penjualan baru |
| Paid | Lunas |
| Pending / waiting | Menunggu |
| Expired | Kedaluwarsa |
| Payment | Pembayaran |
| Payment method | Metode bayar |
| Cash / Card / E-wallet | Tunai / Kartu / E-wallet |
| Receipt | Struk |
| Print receipt / Email receipt | Cetak struk / Kirim struk |
| Refund | Refund |
| Voucher / voucher code | Voucher / kode voucher |
| Discount | Diskon |
| Subtotal / Total | Subtotal / Total |
| Sessions / Prints / Merchandise / Reprint (tabs) | Sesi / Cetak / Merchandise / Cetak ulang |
| Photo strip | Photo strip |
| Print (noun, a printed photo) | Cetakan |
| Print (verb) | Cetak |
| Frame | Bingkai |
| Branding | Merek |
| AI presets | Preset AI |
| Faces | Wajah |
| Gallery | Galeri |
| Photobooth | Photobooth |
| Try on | Coba pakai |
| Hand control | Kontrol tangan |
| Customer | Pelanggan |
| Customer screen | Layar pelanggan |
| Customer mode / Staff controls | Mode pelanggan / Kontrol staf |
| Reports | Laporan |
| Transactions | Transaksi |
| Activity history | Riwayat aktivitas |
| Settings | Pengaturan |
| Prices and rules | Harga dan aturan |
| Payments (settings page) | Pembayaran |
| Payment gateway | Gateway pembayaran |
| Cameras, printers and alerts | Kamera, printer dan peringatan |
| Devices | Perangkat |
| Camera / Printer / Paper | Kamera / Printer / Kertas |
| Alert | Peringatan |
| Team / Users | Tim / Pengguna |
| Team and access | Tim dan akses |
| Roles and permissions | Peran dan izin |
| Sign-in log | Log masuk |
| Sign in / Sign out | Masuk / Keluar |
| Password / PIN | Kata sandi / PIN |
| Invite | Undang |
| Setup guide | Panduan setup |
| Fleet and support | Pembaruan dan bantuan |
| Trial · 14 days left | Masa coba · sisa 14 hari |
| Sync / items waiting to sync | Sinkron / data belum terkirim |
| Online / Offline | Online / Offline |
| Save / Cancel / Delete / Edit / Add / Close / Retry / Search / Back / Next / Done / Confirm | Simpan / Batal / Hapus / Ubah / Tambah / Tutup / Coba lagi / Cari / Kembali / Lanjut / Selesai / Konfirmasi |
| Optional | Opsional |
| Active / Paused / Off | Aktif / Dijeda / Mati |
| Today / Yesterday / 7 days / 30 days | Hari ini / Kemarin / 7 hari / 30 hari |
| Not allowed (permission) | Tidak punya izin |
| Wrong PIN | PIN salah |
| Something went wrong | Terjadi kesalahan |
| Upload | Unggah |
| Download | Unduh |
| Share | Bagikan |
| Snapshot | Foto |
| Capture(s) | Hasil foto |
| Live view | Live view |
| Unique code (QRIS) | Kode unik |
| Notification | Notifikasi |
| Set aside (a notification) | Abaikan |
| Mark paid by hand | Tandai lunas manual |
