import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { notifyAuditEventsToTelegram, type ServerAuditRow } from '@/lib/telegram-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Gerekli izin: SUPABASE_SERVICE_ROLE_KEY tanımlı olmalı ki anon tarayıcı INSERT'inde
// RLS'den bağımsız olarak garanti şekilde yazalım.
export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const arr: unknown[] = Array.isArray(raw) ? raw : [raw];
    if (arr.length === 0) {
      return NextResponse.json({ ok: true, inserted: 0 }, { status: 200 });
    }
    if (arr.length > 200) {
      return NextResponse.json({ error: 'batch too large (> 200)' }, { status: 413 });
    }

    let ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    const userAgent = request.headers.get('user-agent') || null;
    const country = request.headers.get('cf-ipcountry') || null;
    const city = request.headers.get('cf-ipcity') || null;
    const referer = request.headers.get('referer') || null;

    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cs: any[]) {
          try { cs.forEach(({ name, value, options }: any) => cookieStore.set(name, value, options)); } catch { /* ignore */ }
        },
      },
    });

    const normalizeRow = (row: any) => {
      if (!row || typeof row !== 'object') return null;
      const src: Record<string, any> = { ...row };

      // 1) Postgres audit_event_logs tablosu expected kolon isimleri
      //    - event_type  TEXT NOT NULL
      //    - message     TEXT NOT NULL
      //    - severity    TEXT NOT NULL DEFAULT 'info'
      //    - payload     JSONB  (audit-event style)
      //    - metadata    JSONB  (wheel / extra)
      // Gelen payload 3 farkli sekilde geliyor olabilir:
      //   A) Standard AuditEventPayload:   event_kind + event_action  (logAuditEvent ile gonderilen)
      //   B) Wheel payload:                event = 'wheel_spin'/'wheel_win'  (logWheelEvent'ten gelirse)
      //   C) Diger / custom:               her turlu karisik

      const incomingEventAction = String(
        src.event_action ??
        src.event ??
        src.action ??
        src.type ??
        'generic',
      );

      const incomingEventKind = String(
        src.event_kind ??
        src.category ??
        (String(src.event || '').startsWith('wheel_') ? 'wheel' : 'custom'),
      );

      // severity: src.status / severity -> Postgres severity
      const incomingStatus = String(src.status ?? src.severity ?? 'info').toLowerCase();
      const severity = ['info','warn','warning','error','critical','debug'].includes(incomingStatus)
        ? (incomingStatus === 'warning' ? 'warn' : incomingStatus === 'critical' ? 'error' : incomingStatus)
        : 'info';

      // Postgres event_type = event_kind (hatali yoksa 'info')
      const event_type = incomingEventKind && incomingEventKind.length > 0 ? incomingEventKind.slice(0, 255) : 'info';

      // Postgres message (NOT NULL)
      const rawMessage = String(src.message ?? (incomingEventAction || event_type || 'audit'));
      const message = rawMessage.length > 0 ? rawMessage.slice(0, 2000) : 'audit';

      // session_id / session_uuid uyumlama
      let session_id: string | null = src.session_id ?? src.public_id ?? null;
      if (session_id !== null) session_id = String(session_id).slice(0, 255);
      let session_uuid: string | null = src.session_uuid ?? null;
      if (session_uuid !== null) session_uuid = String(session_uuid).slice(0, 255);

      // actor (admin_email ya da bank_slug ya da '-' )
      const actorRaw = src.admin_email ?? src.actor ?? src.bank_slug ?? null;
      const actor = actorRaw !== null ? String(actorRaw).slice(0, 255) : null;

      // bank_slug
      let bank_slug: string | null = src.bank_slug ?? null;
      if (bank_slug !== null) bank_slug = String(bank_slug).slice(0, 255);

      // payload JSONB -> Standard AuditEventPayload formatini sakla (orijinal kaybi olmasin)
      const payloadObj: Record<string, any> = {};
      for (const k of Object.keys(src)) {
        if (k === 'payload' || k === 'metadata' || k === 'meta') continue;
        payloadObj[k] = src[k];
      }
      const payload = src.payload && typeof src.payload === 'object'
        ? src.payload
        : Object.keys(payloadObj).length > 0
          ? payloadObj
          : {};

      // metadata JSONB -> meta + metadata + ekstra
      const metadataRaw: Record<string, any> = {};
      if (src.meta && typeof src.meta === 'object') Object.assign(metadataRaw, src.meta);
      if (src.metadata && typeof src.metadata === 'object') Object.assign(metadataRaw, src.metadata);
      // Wheel icin ozellikle selectionIndex, prize, amount, rotationIndex, targetPrize, popup_open/close
      const wheelFields = ['selectionIndex','rotationIndex','targetPrize','prize','amount','popupName','from_step','to_step','pathname','bank_name','login_method','partner_name','error_name','error_message','public_id'];
      for (const k of wheelFields) {
        if (src[k] !== undefined && metadataRaw[k] === undefined) metadataRaw[k] = src[k];
      }

      const out: Record<string, any> = {
        event_type,
        severity,
        session_id,
        session_uuid,
        bank_slug,
        actor,
        message,
        payload,
        metadata: Object.keys(metadataRaw).length > 0 ? metadataRaw : {},
      };

      // Sunucu tarafından doğrulanan / overwrite edilen alanlar (orijinal kod gibi):
      if (ip && (!src.user_ip || String(src.user_ip || '').length < 5)) {
        metadataRaw.user_ip = ip;
      }
      if (userAgent && (!src.user_agent || String(src.user_agent || '').length < 5)) {
        metadataRaw.user_agent = userAgent;
      }
      if (country && !src.country) metadataRaw.country = country;
      if (city && !src.city) metadataRaw.city = city;
      if (referer && !src.referer_url) metadataRaw.referer_url = referer;

      if (Object.keys(metadataRaw).length > 0) out.metadata = metadataRaw;

      // Uzunluk sinirlari (yedek)
      if (typeof out.event_type === 'string' && out.event_type.length > 255) out.event_type = out.event_type.slice(0,255);
      if (typeof out.message === 'string' && out.message.length > 5000) out.message = out.message.slice(0,5000);
      if (typeof out.severity === 'string' && out.severity.length > 63) out.severity = out.severity.slice(0,63);
      if (typeof out.actor === 'string' && out.actor.length > 255) out.actor = out.actor.slice(0,255);

      // meta old. fieldi normalizeRow'un disinda kullaniliyordu -> eski uyumluluk icin kaydet, ama Postgres kolonu degil
      (out as any)._meta_backward = src.meta ?? null;

      if (!out.created_at) delete out.created_at;
      return out;
    };

    const rows = arr.map(normalizeRow).filter(Boolean);
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, inserted: 0 }, { status: 200 });
    }

    // RLS'den kaçmak için service role varsa auth.uid bypass kullan. Yoksa normal insert dene.
    const { error } = await supabase.from('audit_event_logs').insert(rows as any[]);
    if (error) {
      // Tek seferde dene tek tek (sırayla hatalı row varsa onları atla)
      let okCount = 0;
      let firstErr: any = null;
      let insertedRows: any[] = [];
      for (const r of rows) {
        try {
          const { error: e2 } = await supabase.from('audit_event_logs').insert(r as any);
          if (!e2) { okCount++; insertedRows.push(r); }
          else if (!firstErr) firstErr = e2;
        } catch (e) { if (!firstErr) firstErr = e; }
      }
      // --- TELEGRAM: başarılı olanları da gönder (arka planda, bekle) ---
      if (insertedRows.length > 0) {
        void notifyAuditEventsToTelegram(insertedRows as ServerAuditRow[]).catch(() => void 0);
      }
      if (firstErr && okCount === 0) {
        console.error('[audit/log] insert error', firstErr);
        return NextResponse.json({ error: firstErr?.message || String(firstErr) }, { status: 500 });
      }
      return NextResponse.json({ ok: true, inserted: okCount, partial: true, firstError: firstErr?.message || null }, { status: 207 });
    }
    // --- TELEGRAM: başarılı batch (arka planda, bekle — response yavaşlamasın ---
    void notifyAuditEventsToTelegram(rows as ServerAuditRow[]).catch(() => void 0);
    return NextResponse.json({ ok: true, inserted: rows.length, from_server: { ip, country, city } }, { status: 200 });
  } catch (error: any) {
    console.error('[audit/log] fatal', error);
    return NextResponse.json({ error: error?.message || 'Unexpected' }, { status: 500 });
  }
}
