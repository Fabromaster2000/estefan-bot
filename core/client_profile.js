// core/client_profile.js
// =============================================================================
// ClientProfile — the "constructor" / skeleton for every client.
// Stefi reads this object at the start of every conversation.
// Each client is a "child" instance with their specific data filled in.
// =============================================================================
'use strict';

/**
 * Base skeleton — every client starts with these fields.
 * null = unknown, will be filled from DB.
 */
class ClientProfile {
  constructor() {
    // ── Identity ────────────────────────────────────────────────────────────
    this.phone        = null;
    this.firstName    = null;   // "Sol"
    this.lastName     = null;   // "Martínez"
    this.fullName     = null;   // "Sol Martínez"
    this.email        = null;

    // ── Relationship ────────────────────────────────────────────────────────
    this.isNewClient      = true;   // first visit ever
    this.visitCount       = 0;
    this.totalSpent       = 0;
    this.points           = 0;
    this.lastVisitDate    = null;   // "15/03/2026"
    this.daysSinceVisit   = null;   // number or null

    // ── Next appointment ────────────────────────────────────────────────────
    this.nextBooking      = null;   // { servicio, fecha, hora, code }

    // ── Service history ─────────────────────────────────────────────────────
    this.lastServices     = [];     // [{servicio, fecha}] last 3
    this.favoriteService  = null;   // most booked service name
    this.usualDay         = null;   // "sábado"
    this.usualTime        = null;   // "10:00"

    // ── Technical ficha ─────────────────────────────────────────────────────
    this.colorActual      = null;   // "castaño oscuro con raíz"
    this.tecnica          = null;   // "Balayage"
    this.processosPrevios = null;   // "keratina hace 2 meses"
    this.ultimoProceso    = null;   // "color entero - 01/02/2026"
    this.alergias         = null;
    this.observaciones    = null;
    this.largo            = null;   // "largo", "medio", "corto"
    this.textura          = null;   // "fino", "grueso", "ondulado"

    // ── Personality flags ────────────────────────────────────────────────────
    this.promoOptIn       = false;
    this.isVip            = false;  // visit_count >= 10 or total_spent >= 50000
    this.hasNotes         = false;
    this.staffNotes       = [];     // [{content, type, created_by, created_at}]

    // ── Upsell intelligence ──────────────────────────────────────────────────
    this.upsellOpportunities = [];  // services that pair well with their history
    this.neverBooked         = [];  // services they've never tried

    // ── Reliability score ────────────────────────────────────────────────────
    this.cancelCount         = 0;   // cancelaciones en últimos 12 turnos
    this.noShowCount         = 0;   // no-shows en últimos 12 turnos
    this.reliabilityScore    = 100; // 0-100
    this.requiresSena        = false; // true si score < 60
    this.cancelledServices   = [];  // [{servicio, fecha}]
  }

  /**
   * Hydrate this profile from DB data.
   * @param {object} client   - row from clients table
   * @param {array}  bookings - recent booking rows
   * @param {object} ficha    - row from client_ficha
   * @param {array}  notes    - rows from client_notes
   */
  hydrate(client, bookings = [], ficha = null, notes = []) {
    if (!client) return this;

    // Identidad
    this.clientId = client.client_id || null;
    this.phone    = client.phone     || null;
    this.email    = client.email     || null;

    // Identity
    this.phone     = client.phone;
    this.firstName = client.name  || null;
    this.lastName  = client.last_name || null;
    this.fullName  = [client.name, client.last_name].filter(Boolean).join(' ') || null;
    this.email     = client.email || null;

    // Relationship
    this.visitCount   = client.visit_count || 0;
    this.totalSpent   = parseFloat(client.total_spent) || 0;
    this.points       = client.points || 0;
    this.isNewClient  = this.visitCount === 0;
    this.isVip        = this.visitCount >= 10 || this.totalSpent >= 50000;
    this.promoOptIn   = !!client.promo_opt_in;

    if (client.last_visit) {
      const lv = new Date(client.last_visit);
      this.lastVisitDate  = lv.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
      this.daysSinceVisit = Math.floor((Date.now() - lv.getTime()) / 86400000);
    }

    // Bookings analysis — incluye cancelados para score de confiabilidad
    const completed   = bookings.filter(b => b.status === 'Completado' || b.status === 'Confirmado');
    const cancelled   = bookings.filter(b => b.status === 'Cancelado');
    const noShows     = bookings.filter(b => b.status === 'No asistió');
    const last12      = bookings.slice(0, 12); // últimos 12 turnos (cualquier estado)
    const upcoming    = bookings.filter(b =>
      !['Cancelado','Completado','Reprogramado','No asistió'].includes(b.status)
    );

    if (upcoming.length > 0) {
      const next = upcoming[0];
      this.nextBooking = {
        servicio: next.service || next.servicio,
        fecha:    next.date_str || next.fecha,
        hora:     next.time_str || next.hora,
        code:     next.booking_code || next.code,
        estado:   next.status || next.estado,
      };
    }

    // Last services
    this.lastServices = completed.slice(0, 3).map(b => ({
      servicio: b.service || b.servicio,
      fecha:    b.date_str || b.fecha,
    }));

    // Favorite service (most frequent)
    if (completed.length > 0) {
      const freq = {};
      for (const b of completed) {
        const s = b.service || b.servicio || '';
        freq[s] = (freq[s] || 0) + 1;
      }
      this.favoriteService = Object.entries(freq).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
    }

    // Usual day/time (most common in history)
    if (completed.length >= 3) {
      const days = {}, times = {};
      for (const b of completed) {
        if (b.date_str) {
          // date_str = "DD/MM/YYYY" → get day of week
          const parts = (b.date_str||'').split('/');
          if (parts.length === 3) {
            const d = new Date(parts[2], parts[1]-1, parts[0]);
            const dayName = d.toLocaleDateString('es-AR', { weekday:'long' });
            days[dayName] = (days[dayName]||0) + 1;
          }
        }
        if (b.time_str) {
          const hr = (b.time_str||'').split(':')[0];
          times[hr] = (times[hr]||0) + 1;
        }
      }
      this.usualDay  = Object.entries(days).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
      const usualHr  = Object.entries(times).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
      this.usualTime = usualHr ? `${usualHr}:00` : null;
    }

    // Score boost acumulado de canjes de puntos
    const scoreBoostTxns = (notes || []).filter(n => n.type === 'score_boost');
    this._scoreBonusFromPoints = scoreBoostTxns.reduce((sum, n) => {
      const match = (n.content || '').match(/\+(\d+) puntos de score/);
      return sum + (match ? parseInt(match[1]) : 0);
    }, 0);

    // Technical ficha
    if (ficha) {
      this.colorActual      = ficha.color_actual     || null;
      this.tecnica          = ficha.tecnica          || null;
      this.processosPrevios = ficha.procesos_previos || null;
      this.ultimoProceso    = ficha.ultimo_proceso   || null;
      this.alergias         = ficha.alergias         || null;
      this.observaciones    = ficha.observaciones    || null;
      this.largo            = ficha.largo            || null;
      this.textura          = ficha.textura          || null;
    }

    // Notes
    this.staffNotes = notes.slice(0, 5).map(n => ({
      content:    n.content,
      type:       n.type,
      created_by: n.created_by,
      date:       new Date(n.created_at).toLocaleDateString('es-AR'),
    }));
    this.hasNotes = this.staffNotes.length > 0;

    // Cancelled services history
    this.cancelledServices = cancelled.slice(0, 5).map(b => ({
      servicio: b.service || b.servicio,
      fecha:    b.date_str || b.fecha,
    }));

    // Reliability score
    this._computeReliability(last12, cancelled, noShows);

    // Upsell intelligence
    this._computeUpsell(completed);

    return this;
  }

  _computeReliability(last12, cancelled, noShows) {
    const total = last12.length;
    if (total === 0) { this.reliabilityScore = 100; return; }

    // Contar cancelaciones y no-shows en últimos 12
    const cancelInLast12 = last12.filter(b => b.status === 'Cancelado').length;
    const noShowInLast12 = last12.filter(b => b.status === 'No asistió').length;

    this.cancelCount = cancelInLast12;
    this.noShowCount = noShowInLast12;

    // Cancelaciones con menos de 24hs de anticipación (si tenemos cancelled_at)
    let lateCancel = 0;
    for (const b of last12.filter(bk => bk.status === 'Cancelado')) {
      if (b.cancelled_at && b.date_str && b.time_str) {
        try {
          // Reconstruir fecha del turno desde date_str (DD/MM/YYYY) + time_str (HH:MM)
          const [d, m, y] = (b.date_str || '').split('/');
          const turnoDate  = new Date(`${y}-${m}-${d}T${b.time_str}:00-03:00`);
          const cancelDate = new Date(b.cancelled_at);
          const horasAntes = (turnoDate - cancelDate) / (1000 * 60 * 60);
          if (horasAntes >= 0 && horasAntes < 24) lateCancel++;
        } catch {}
      }
    }
    this.lateCancelCount = lateCancel;

    // Score: empieza en 100
    // Cancelación normal:      -5
    // Cancelación < 24hs:      -12 (más grave, destruye la agenda)
    // No-show:                 -18 (no avisó nada)
    let score = 100;
    const normalCancel = cancelInLast12 - lateCancel;
    score -= normalCancel * 5;
    score -= lateCancel   * 12;
    score -= noShowInLast12 * 18;
    score = Math.max(0, Math.min(100, score));

    this.reliabilityScore = score;

    // Boost por puntos: cada 100 puntos canjeados = +10 de score
    // Se registra en loyalty_transactions con type='score_boost'
    // Aplicar boost guardado (viene de score_boost en DB)
    const boostedScore = Math.min(100, score + (this._scoreBonusFromPoints || 0));
    this.reliabilityScoreBase   = score;        // score sin boost
    this.reliabilityScore       = boostedScore; // score real con boost aplicado

    // Umbral: score < 60 → requiere seña en todos los servicios
    this.requiresSena = boostedScore < 60;

    // Info para Stefi: cuántos puntos necesita para subir el score
    if (boostedScore < 60 && this.points > 0) {
      const puntosNecesarios = Math.ceil((60 - boostedScore) / 10) * 100;
      this.puntosParaRehabilitacion = puntosNecesarios;
    } else {
      this.puntosParaRehabilitacion = null;
    }
  }

  _computeUpsell(bookings) {
    const ALL_SERVICES = [
      'Corte de pelo', 'Corte + Brushing', 'Brushing / Planchita',
      'Lavado + Aireado', 'Ozono', 'Head Spa completo', 'Ampolla',
      'Retoque / Raíz', 'Color entero', 'Contorno', 'Balayage',
      'Decoloración total', 'Peinado fiesta / 15', 'Peinado novia'
    ];
    const UPSELL_PAIRS = {
      'Corte de pelo':       ['Ampolla', 'Ozono'],
      'Corte + Brushing':    ['Ampolla', 'Ozono'],
      'Retoque / Raíz':      ['Ampolla', 'Head Spa completo'],
      'Color entero':        ['Ampolla', 'Head Spa completo'],
      'Balayage':            ['Head Spa completo', 'Ampolla'],
      'Brushing / Planchita':['Ampolla'],
    };

    const booked = new Set(bookings.map(b => b.service || b.servicio || ''));
    this.neverBooked = ALL_SERVICES.filter(s => !booked.has(s));

    if (this.favoriteService && UPSELL_PAIRS[this.favoriteService]) {
      this.upsellOpportunities = UPSELL_PAIRS[this.favoriteService]
        .filter(s => !booked.has(s) || booked.size < 3); // suggest even if tried once
    }
  }

  /**
   * Returns a compact string summary for injection into Stefi's system prompt.
   * Stefi reads this and responds accordingly.
   */
  toPromptContext() {
    const lines = [];

    // Who is this person?
    if (this.isNewClient) {
      lines.push(`CLIENTE: Nueva clienta — primer contacto.`);
    } else {
      lines.push(`CLIENTE: ${this.fullName || this.firstName || 'Clienta conocida'}`);
      lines.push(`  Visitas: ${this.visitCount} | Gastó: $${this.totalSpent.toLocaleString('es-AR')} | Puntos: ${this.points}${this.isVip ? ' ⭐ VIP' : ''}`);
      if (this.lastVisitDate) {
        const when = this.daysSinceVisit === 0 ? 'hoy'
          : this.daysSinceVisit === 1 ? 'ayer'
          : `hace ${this.daysSinceVisit} días`;
        lines.push(`  Última visita: ${this.lastVisitDate} (${when})`);
      }
    }

    // Next appointment
    if (this.nextBooking) {
      lines.push(`  Próximo turno: ${this.nextBooking.servicio} el ${this.nextBooking.fecha} a las ${this.nextBooking.hora} (${this.nextBooking.estado}) — código #${this.nextBooking.code}`);
    }

    // Service history
    if (this.lastServices.length > 0) {
      const hist = this.lastServices.map(s => `${s.servicio} (${s.fecha})`).join(', ');
      lines.push(`  Últimos servicios: ${hist}`);
    }
    if (this.favoriteService) lines.push(`  Servicio favorito: ${this.favoriteService}`);
    if (this.usualDay || this.usualTime) {
      lines.push(`  Prefiere: ${[this.usualDay, this.usualTime].filter(Boolean).join(' a las ')}`);
    }

    // Technical ficha
    const fichaLines = [];
    if (this.colorActual)      fichaLines.push(`color actual: ${this.colorActual}`);
    if (this.tecnica)          fichaLines.push(`técnica: ${this.tecnica}`);
    if (this.processosPrevios) fichaLines.push(`procesos: ${this.processosPrevios}`);
    if (this.largo)            fichaLines.push(`largo: ${this.largo}`);
    if (this.textura)          fichaLines.push(`textura: ${this.textura}`);
    if (this.alergias)         fichaLines.push(`⚠️ alergias: ${this.alergias}`);
    if (this.observaciones)    fichaLines.push(`obs: ${this.observaciones}`);
    if (fichaLines.length > 0) lines.push(`  Ficha técnica: ${fichaLines.join(' | ')}`);

    // Staff notes
    if (this.staffNotes.length > 0) {
      lines.push(`  Notas del staff:`);
      for (const n of this.staffNotes.slice(0, 3)) {
        lines.push(`    • [${n.date}] ${n.content}`);
      }
    }

    // Reliability score
    if (!this.isNewClient) {
      if (this.requiresSena) {
        let scoreMsg = `  ⚠️ REQUIERE SEÑA: Score de confiabilidad ${this.reliabilityScore}/100`;
        if (this.reliabilityScoreBase !== this.reliabilityScore) {
          scoreMsg += ` (base ${this.reliabilityScoreBase}/100, mejorado con puntos)`;
        }
        scoreMsg += `. Todos los servicios requieren seña no reembolsable.`;
        if (this.puntosParaRehabilitacion && this.points >= this.puntosParaRehabilitacion) {
          scoreMsg += ` Tiene ${this.points} puntos — puede canjear ${this.puntosParaRehabilitacion} puntos para subir el score y evitar la seña.`;
        } else if (this.puntosParaRehabilitacion) {
          scoreMsg += ` Necesitaría ${this.puntosParaRehabilitacion} puntos para mejorar el score (tiene ${this.points}).`;
        }
        lines.push(scoreMsg);
      } else if (this.cancelCount >= 2) {
        lines.push(`  ⚠️ Atención: canceló ${this.cancelCount} turno${this.cancelCount > 1 ? 's' : ''} recientemente (score: ${this.reliabilityScore}/100).`);
      }
      if (this.cancelledServices.length > 0) {
        const canc = this.cancelledServices.map(s => `${s.servicio} (${s.fecha})`).join(', ');
        lines.push(`  Turnos cancelados: ${canc}`);
      }
      if (this.noShowCount > 0) {
        lines.push(`  No-shows: ${this.noShowCount}`);
      }
    }

    // Upsell opportunities
    if (this.upsellOpportunities.length > 0) {
      lines.push(`  💡 Oportunidad upsell: ofrecer ${this.upsellOpportunities.slice(0,2).join(' o ')} si tiene sentido en la conversación`);
    }
    if (this.neverBooked.length > 0 && !this.isNewClient) {
      lines.push(`  Nunca probó: ${this.neverBooked.slice(0,3).join(', ')}`);
    }

    return lines.join('\n');
  }
}

module.exports = { ClientProfile };