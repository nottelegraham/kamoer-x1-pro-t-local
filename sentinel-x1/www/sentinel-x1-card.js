// Sentinel X1 branding only; scoped two-color custom icon.
window.customIcons = window.customIcons || {};
window.customIcons.sentinel = {getIcon: async () => ({path: 'M117 25L192 57V100C192 145 164 174 118 193C70 174 44 143 44 101V57Z', secondaryPath: 'M75 71H97L105 92L128 71H151L116 105L129 136H107L99 115L78 136H59L91 102ZM138 80L157 71H170L154 136H135L147 91L136 97Z', viewBox: '35 20 166 178'})};
customElements.whenDefined('ha-icon').then(() => {
 const proto = customElements.get('ha-icon').prototype;
 if (proto._sentinelBranding) return;
 proto._sentinelBranding = true;
 const loadIcon = proto._loadIcon;
 proto._loadIcon = function(...args) {
   if (this.icon === 'sentinel:x1') this._legacy = false;
   return loadIcon.apply(this, args);
 };
 const refresh = root => {
   for (const el of root.querySelectorAll('*')) {
     if (el.localName === 'ha-icon' && el.icon === 'sentinel:x1') {
       el._loadIcon(); el.requestUpdate();
     }
     if (el.shadowRoot) refresh(el.shadowRoot);
   }
 };
 queueMicrotask(() => refresh(document));
 const updated = proto.updated;
 proto.updated = function(changed) {
   if (updated) updated.call(this, changed);
   if (this.icon === 'sentinel:x1') {
     this.style.setProperty('--icon-primary-color', '#ff7900');
     this.style.setProperty('--icon-secondary-color', '#fff');
     this.style.setProperty('--icon-secondary-opactity', '1');
     this._sentinelColored = true;
   } else if (this._sentinelColored) {
     ['--icon-primary-color','--icon-secondary-color','--icon-secondary-opactity'].forEach(k => this.style.removeProperty(k));
     this._sentinelColored = false;
   }
 };
});
/* Sentinel X1 Pro-T card · custom Lovelace card for the Sentinel X1 dosing package.
 * Views: dosing | status | settings.   type: custom:sentinel-x1-card   view: dosing
 * Front end only: every control calls the same helpers/scripts the package already exposes. */
const SX_VERSION = '1.7.0';
const C = { ink:'#13233A', muted:'#56657C', line:'#E6EBF2', soft:'#F6F8FC', bg:'#F4F7FB', blue:'#1F6FEB', teal:'#0E9FB3',
  green:'#1E9E6A', amber:'#D9821E', red:'#D64545', grey:'#9AA6B8', slate:'#8492A8' };
const E = 'sensor.sentinel_x1_engine';
const PRIME_TXT = 'Prime the line? The pump will run at full speed for the set prime time, whatever the other settings are. Make sure the dose line is where you want it.';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const num = (v, d = 0) => { const x = parseFloat(v); return isNaN(x) ? d : x; };
const fmt = (v, dp) => { const x = num(v); return dp === undefined ? String(+x.toFixed(4)) : x.toFixed(dp); };
const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const decimals = (step) => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };

class SentinelX1Card extends HTMLElement {
  setConfig(c) { this._cfg = Object.assign({ view: 'dosing' }, c || {}); if (this._hass) this._render(); }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 'auto' }; }
  set hass(h) {
    this._hass = h;
    const sig = this._signature();
    if (sig !== this._sig) { this._sig = sig; if (!this._editing && !this._modalOpen) this._render(); else this._dirty = true; }
    this._askCheck();
  }
  /* "restart the schedule?" prompt: shown on every open dashboard while HA has a question
     pending; answering on one device clears it everywhere. No backdrop dismiss. */
  _askCheck() {
    if (!this.shadowRoot) return;
    const pending = this.s('input_boolean.sentinel_x1_cal_ask_restart') === 'on';
    if (pending && !this._askM && !this._modalOpen) {
      this._askM = this._modal(`<h4>Calibration run finished</h4><p>Restart the dosing schedule?</p><p class="hint">Choose No if you have more calibration steps to run. If the schedule is still off in 15 minutes you'll get an alert, then one every 30 minutes until you restart it or acknowledge.</p>
        <div class="dlg-a"><button class="ghost" data-x="0">No</button><button class="primary" data-x="1">Yes, restart</button></div>`);
      this._askM.addEventListener('click', e => {
        const x = e.target.closest('[data-x]'); if (!x) return;
        const m = this._askM; this._askM = null; this._close(m);
        this.runScript(x.dataset.x === '1' ? 'script.sentinel_x1_cal_restart_yes' : 'script.sentinel_x1_cal_restart_no');
      });
    } else if (!pending && this._askM) { const m = this._askM; this._askM = null; this._close(m); }
  }
  /* start a calibration run; if the schedule is on, offer to turn it off first */
  _calRun(id) {
    if (!this.on('input_boolean.sentinel_x1_enabled')) return this.runScript(id);
    const m = this._modal(`<h4>Dosing schedule is on</h4><p>Calibration can't run while the schedule is dosing. Turn the schedule off and start this calibration run?</p>
      <div class="dlg-a"><button class="ghost" data-x="0">No</button><button class="primary" data-x="1">Yes, turn off and start</button></div>`);
    m.addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (!x && e.target !== m) return;
      this._close(m);
      if (x && x.dataset.x === '1') this.runScript('script.sentinel_x1_cal_begin', { run: id });
    });
  }
  /* ---------- state helpers ---------- */
  st(id) { return this._hass.states[id]; }
  s(id) { const o = this.st(id); return o ? o.state : undefined; }
  a(id, k) { const o = this.st(id); return o && o.attributes ? o.attributes[k] : undefined; }
  on(id) { return this.s(id) === 'on'; }
  _signature() {
    const parts = [];
    for (const [k, v] of Object.entries(this._hass.states)) {
      if (k.includes('sentinel_x1') || k.includes('kamoer_x1_pro_t')) parts.push(k + v.last_updated);
    }
    return parts.join('|');
  }
  /* ---------- service calls ---------- */
  async call(domain, service, data) {
    try { await this._hass.callService(domain, service, data); }
    catch (e) { this._toast(`Couldn't do that: ${e.message || e}`); }
  }
  setNum(id, v) {
    const dom = id.split('.')[0];
    const min = num(this.a(id, 'min'), -1e9), max = num(this.a(id, 'max'), 1e9);
    const val = Math.min(max, Math.max(min, v));
    return this.call(dom, 'set_value', { entity_id: id, value: val });
  }
  runScript(id, variables) { return this.call('script', 'turn_on', variables ? { entity_id: id, variables } : { entity_id: id }); }

  /* ---------- UI atoms ---------- */
  icon(i, color, size = 20) { return `<ha-icon icon="${i}" style="--mdc-icon-size:${size}px;color:${color}"></ha-icon>`; }
  pill(txt, c) { return `<span class="pill" style="background:${c}1F;color:${c}"><i style="background:${c}"></i>${esc(txt)}</span>`; }
  kpi(icon, lab, val, c, sub) {
    return `<div class="kpi"><div class="kpi-i" style="background:${c}1A">${this.icon(icon, c, 19)}</div>
      <div class="kpi-t"><div class="lab">${lab}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
  }
  panel(title, icon, body, opts = {}) {
    return `<section class="panel ${opts.cls || ''}"><header>${this.icon(icon, C.blue, 20)}<h3>${title}</h3>${opts.right || ''}</header>${body}</section>`;
  }
  row(label, control, hint) {
    return `<div class="row"><div class="rl"><div class="rn">${label}</div>${hint ? `<div class="rh">${hint}</div>` : ''}</div><div class="rc">${control}</div></div>`;
  }
  stepper(id, opts = {}) {
    const o = this.st(id); if (!o) return `<span class="na">unavailable</span>`;
    const step = num(opts.step ?? o.attributes.step, 1), unit = opts.unit ?? o.attributes.unit_of_measurement ?? '';
    const dp = opts.dp ?? decimals(step);
    return `<div class="step"><button data-act="dec" data-e="${id}" data-s="${step}" aria-label="decrease">−</button>
      <input inputmode="decimal" data-act="num" data-e="${id}" value="${fmt(o.state, dp)}"/><span class="u">${esc(unit)}</span>
      <button data-act="inc" data-e="${id}" data-s="${step}" aria-label="increase">+</button></div>`;
  }
  seg(id, labels) {
    const opts = this.a(id, 'options') || [], cur = this.s(id);
    return `<div class="seg">${opts.map(o => `<button class="${o === cur ? 'on' : ''}" data-act="sel" data-e="${id}" data-v="${esc(o)}">${esc((labels && labels[o]) || o)}</button>`).join('')}</div>`;
  }
  select(id, wide) {
    const opts = this.a(id, 'options') || [], cur = this.s(id);
    return `<div class="sel ${wide ? 'wide' : ''}"><select data-act="pick" data-e="${id}">${opts.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>${this.icon('mdi:chevron-down', C.muted, 18)}</div>`;
  }
  toggle(id) {
    const on = this.on(id);
    return `<button class="sw ${on ? 'on' : ''}" data-act="tog" data-e="${id}" role="switch" aria-checked="${on}"><i></i></button>`;
  }
  time(id) {
    const v = (this.s(id) || '00:00:00').slice(0, 5);
    return `<input class="time" type="time" data-act="time" data-e="${id}" value="${v}"/>`;
  }
  btn(label, icon, act, attrs = '', tone = C.blue, sub = '', cls = '') {
    return `<button class="act ${cls}" data-act="${act}" ${attrs} style="--t:${tone}"><span class="ai">${this.icon(icon, cls.includes('solid') ? '#fff' : tone, 21)}</span>
      <span class="at"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  }
  banner(tone, icon, title, text, extra = '', cls = '') {
    return `<div class="banner ${cls}" style="--t:${tone}">${this.icon(icon, tone, 22)}<div><b>${title}</b>${text ? `<p>${text}</p>` : ''}${extra}</div></div>`;
  }
  note(text, icon = 'mdi:information-outline') { return `<p class="note">${this.icon(icon, C.muted, 16)}<span>${text}</span></p>`; }
  bar(pct, c) { return `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${c}"></i></div>`; }

  /* ---------- shared blocks ---------- */
  engine() { const o = this.st(E); return o ? o.attributes : {}; }
  phInfo() {
    const v = parseFloat(this.s('sensor.sentinel_x1_ph')), hi = num(this.s('input_number.sentinel_x1_ph_stop'), 99), lo = num(this.s('input_number.sentinel_x1_ph_resume'), 0);
    return { v, hi, lo, c: isNaN(v) ? C.grey : (v > hi || v < lo) ? C.red : C.green };
  }
  hero(acts = '') {
    const e = this.engine(), block = String(e.block || '').trim(), en = this.on('input_boolean.sentinel_x1_enabled');
    const phOn = e.ph_on === true || e.ph_on === 'True';
    const today = num(this.s('input_number.sentinel_x1_today_ml')), daily = num(e.daily), cap = num(e.daily_cap);
    const goal = phOn ? cap : daily, pct = goal > 0 ? Math.min(100, today / goal * 100) : 0;
    let label, col;
    if (!en || block === 'Disabled') { label = 'Off'; col = C.grey; }
    else if (block) { label = 'Paused'; col = C.amber; }
    else if (phOn) { label = 'Holding pH'; col = C.teal; }
    else { label = 'Dosing'; col = C.green; }
    const ring = label === 'Off' ? '#C3CCD9' : phOn ? C.teal : C.blue;
    const R = 40, CIRC = 2 * Math.PI * R, off = CIRC * (1 - pct / 100);
    const sub = phOn ? `Target pH ${this.s('input_number.sentinel_x1_ph_target')} · up to ${num(this.s('input_number.sentinel_x1_ph_max_ml_h'))} mL/h`
      : `${daily} mL/day · ${esc(e.window_text || '')} · ${esc(this.s('input_select.sentinel_x1_curve'))}`;
    const ph = this.phInfo();
    const dv = num(this.s('sensor.sentinel_x1_container_days')), cml = num(this.s('input_number.sentinel_x1_container_ml'));
    const pump = this.s('sensor.kamoer_x1_pro_t_kamoer_status') || 'unknown', pc = ['idle', 'running'].includes(pump) ? C.green : C.red;
    const left = num(e.pause_left_min);
    let banner = '';
    if (block.startsWith('Pump fault')) {
      const f = this.st('binary_sensor.kamoer_x1_pro_t_kamoer_pulse_fault'), fa = f ? f.attributes : {};
      banner = this.banner(C.red, 'mdi:alert-octagon', 'Pump fault: all dosing stopped',
        `${esc((fa.reason || 'fault').charAt(0).toUpperCase() + (fa.reason || 'fault').slice(1))}${fa.on_s ? `: a pulse ran ${fa.on_s} s against ${fa.planned_s} s planned (${fa.ratio}×)` : ''}${fa.at ? ` at ${esc(String(fa.at).slice(11, 16))}` : ''}. Check the line and the bridge, then clear it.`,
        `<div class="inline-acts"><button class="link strong" data-act="confirm-run" data-e="script.sentinel_x1_fault_clear" data-msg="Clear the pump fault and allow dosing again? Make sure the cause is understood first.">Clear fault</button></div>`);
    } else if (block === 'pH above alarm limit' || block === 'KH above ceiling')
      banner = this.banner(C.red, 'mdi:flask-off', `Paused: ${esc(block)}`, block.startsWith('pH')
        ? `Overdose guard. Resumes by itself once pH has been under ${esc(this.s('input_number.sentinel_x1_ph_stop'))} for 30 minutes.`
        : `Overdose guard. Resumes when a KH reading is back under target + max rise per day.`);
    else if (block && block !== 'Disabled') banner = this.banner(C.amber, 'mdi:pause-circle', `Paused: ${esc(block)}`, left > 0 ? `${left} min left` : '');
    else if (!en && this.on('input_boolean.sentinel_x1_cal_paused') && !this.on('input_boolean.sentinel_x1_calibrating')) {
      const ta = this.s('timer.sentinel_x1_sched_alert') === 'active' ? Date.parse(this.a('timer.sentinel_x1_sched_alert', 'finishes_at')) : NaN;
      banner = this.banner(C.amber, 'mdi:calendar-remove', 'Dosing schedule is off for calibration',
        isNaN(ta) ? 'Alerts repeat every 30 minutes until you restart it or acknowledge.' : `Next alert: <span class="cd" data-end="${ta}">${mmss(ta - Date.now())} left</span>`,
        `<div class="inline-acts"><button class="link strong" data-act="run" data-e="script.sentinel_x1_cal_restart_yes">Restart schedule</button><button class="link" data-act="run" data-e="script.sentinel_x1_sched_ack">Acknowledge, keep it off</button></div>`);
    }
    return `<div class="hero">
      <div class="hero-top"><div class="brand"><div class="logo"><img src="/local/sentinel-x1/sentinel-x1-logo.svg" alt="Sentinel X1" width="40" height="40"></div>
        <div><div class="bt">Sentinel X1 Pro-T</div><div class="bs">Kamoer X1 Pro-T doser</div></div></div>${this.pill(label, col)}</div>
      <div class="hero-main">
        <svg class="ring" viewBox="0 0 112 112"><circle cx="56" cy="56" r="${R}" fill="none" stroke="#EDF1F7" stroke-width="11"/>
          <circle cx="56" cy="56" r="${R}" fill="none" stroke="${ring}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${off}" transform="rotate(-90 56 56)"/>
          <text x="56" y="54" text-anchor="middle" class="rp">${pct.toFixed(0)}%</text>
          <text x="56" y="72" text-anchor="middle" class="rs">${today.toFixed(1)} / ${goal.toFixed(goal < 10 ? 1 : 0)} mL</text></svg>
        <div class="hero-txt"><div class="eyebrow">${phOn ? 'pH hold' : 'Today'}</div><div class="headline">${esc(e.summary || '')}</div><div class="hsub">${sub}</div></div>
        <div class="hero-ctl">${this.enableSwitch(en)}${acts ? `<div class="hacts">${acts}</div>` : ''}</div>
      </div>
      ${banner}
      <div class="kpis">
        ${this.kpi('mdi:ph', 'pH', isNaN(ph.v) ? '—' : ph.v.toFixed(2), ph.c, `alarm ${ph.lo}–${ph.hi}`)}
        ${this.kpi('mdi:bottle-tonic', 'Container', dv > 0 ? `${dv} day${dv === 1 ? '' : 's'}` : `${cml.toFixed(0)} mL`, dv > 0 ? (dv < 7 ? C.red : dv < 14 ? C.amber : C.green) : C.blue, dv > 0 ? `${cml.toFixed(0)} mL left` : 'left in container')}
        ${this.kpi('mdi:pump', 'Pump', pump.charAt(0).toUpperCase() + pump.slice(1), pc, this.pumpRate(e))}
        ${this.kpi('mdi:water-sync', 'Delivery', esc(e.active_mode || '—'), C.blue, this.s('input_select.sentinel_x1_mode') === 'Auto' ? 'Auto' : 'Forced')}
      </div></div>`;
  }
  enableSwitch(en) {
    return `<button class="enable ${en ? 'on' : ''}" data-act="tog" data-e="input_boolean.sentinel_x1_enabled">
      <span class="et"><b>Pump Enable</b><small>${en ? 'Automatic dosing on' : 'Automatic dosing off'}</small></span><span class="sw big ${en ? 'on' : ''}"><i></i></span></button>`;
  }
  calBanners() {
    let out = '';
    const nocal = ['number.kamoer_x1_pro_t_kamoer_cal_low', 'number.kamoer_x1_pro_t_kamoer_cal_200_rpm', 'number.kamoer_x1_pro_t_kamoer_cal_350_rpm'].some(id => num(this.s(id)) < 0.01);
    if (nocal) out += `<button class="banner-btn" data-act="nav" data-p="pump">${this.banner(C.amber, 'mdi:beaker-alert', 'Calibrate before dosing', 'Doses can’t be sized until the three-speed calibration is done.', '<span class="go">Open Settings ›</span>', 'slim')}</button>`;
    const age = num(this.s('sensor.sentinel_x1_calibration_age'));
    if (age > 89 && !this.on('input_boolean.sentinel_x1_cal_reminder_dismissed')) {
      out += this.banner(C.blue, 'mdi:beaker-clock', 'Recalibration recommended', `Last calibrated ${age} days ago. A fresh three-speed calibration keeps doses accurate as tubing wears. Optional.`,
        `<div class="inline-acts"><button class="link" data-act="run" data-e="script.sentinel_x1_cal_reminder_dismiss">Dismiss</button><button class="link strong" data-act="nav" data-p="pump">Calibrate now</button></div>`);
    }
    return out;
  }

  /* ---------- views ---------- */
  viewDosing() {
    const e = this.engine(), k = e.pause_kind, paused = k === 'Feed' || k === 'Maintenance';
    const actions = `
      ${this.btn('Manual dose', 'mdi:hand-water', 'manual', '', C.blue, 'Choose an amount')}
      ${this.btn('Prime', 'mdi:pipe-valve', 'confirm-run', `data-e="script.sentinel_x1_prime" data-msg="${esc(PRIME_TXT)}"`, C.teal, 'Asks first')}
      ${this.btn('STOP', 'mdi:stop-circle', 'confirm-run', `data-e="script.sentinel_x1_stop_all" data-msg="Stop the pump and disable Sentinel X1 dosing?"`, C.red, 'Stop and disable', 'solid')}`;
    const pauses = this.panel('Pauses', 'mdi:pause-circle-outline',
      (paused ? this.banner(C.amber, k === 'Feed' ? 'mdi:fish' : 'mdi:wrench', `${k} pause · ${num(e.pause_left_min)} min left`, 'Runs the matching Sentinel Controller pause.', '', 'slim')
        : `<div class="pstat">${this.icon('mdi:play-circle-outline', C.blue, 18)}<span><b>No pause running</b> · Feed ${num(this.s('input_number.sentinel_x1_feed_minutes'))} min · Maintenance ${num(this.s('input_number.sentinel_x1_maint_minutes'))} min</span></div>`) +
      `<div class="grid2 mini">
        ${this.btn('Feed', 'mdi:fish', 'run', 'data-e="script.sentinel_x1_pause_feed"', C.amber, '', k === 'Feed' ? 'active' : '')}
        ${this.btn('Maintenance', 'mdi:wrench', 'run', 'data-e="script.sentinel_x1_pause_maint"', C.amber, '', k === 'Maintenance' ? 'active' : '')}
        ${this.btn('+30 min', 'mdi:timer-plus-outline', 'run', 'data-e="script.sentinel_x1_pause_add30"', C.blue)}
        ${this.btn('End pause', 'mdi:play-circle', 'run', 'data-e="script.sentinel_x1_resume"', C.blue)}</div>`);
    const volume = this.panel('Daily volume', 'mdi:cup-water',
      `<div class="bignum">${this.stepper('input_number.sentinel_x1_target_ml')}<div class="bn-l">Daily target</div></div>` +
      this.row('In effect today', `<span class="ro">${num(e.daily)} mL</span>`, this.on('input_boolean.sentinel_x1_ramp') ? 'Eases toward the target by 5% a day' : '') +
      this.row('Ease changes in', this.toggle('input_boolean.sentinel_x1_ramp'), '5% per day') +
      `<div class="field"><div class="fl">Delivery</div>${this.seg('input_select.sentinel_x1_mode')}</div>` +
      this.doseSpeed(e) +
      (e.why ? this.note(esc(e.why), 'mdi:lightbulb-on-outline') : ''));
    const win24 = this.s('input_select.sentinel_x1_window') === '24 hours', flat = this.s('input_select.sentinel_x1_curve') === 'Flat';
    const schedule = this.panel('Schedule', 'mdi:clock-outline',
      `<div class="field"><div class="fl">Dose across</div>${this.seg('input_select.sentinel_x1_window')}</div>` +
      (win24 ? '' : `<div class="times">${this.row('Start', this.time('input_datetime.sentinel_x1_start'))}${this.row('Stop', this.time('input_datetime.sentinel_x1_stop'), 'Earlier than start = overnight')}</div>`) +
      `<div class="field"><div class="fl">Distribution</div>${this.seg('input_select.sentinel_x1_curve', { 'Follow photoperiod': 'Photoperiod', 'Night-weighted': 'Night' })}</div>` +
      (flat ? '' : `<div class="times">${this.row('Lights on', this.time('input_datetime.sentinel_x1_lights_on'))}${this.row('Lights off', this.time('input_datetime.sentinel_x1_lights_off'))}</div>`) +
      this.dayPlan(e));
    const cp = num(this.s('sensor.sentinel_x1_container_percent')), dv = num(this.s('sensor.sentinel_x1_container_days'));
    const container = this.panel('Container', 'mdi:bottle-tonic',
      `<div class="meter"><div class="mt"><b>${cp.toFixed(0)}<small>%</small></b><span>${num(this.s('input_number.sentinel_x1_container_ml')).toFixed(0)} of ${num(this.s('input_number.sentinel_x1_container_size')).toFixed(0)} mL${dv > 0 ? ` · about ${dv} day${dv === 1 ? '' : 's'}` : ''}</span></div>${this.bar(cp, cp < 15 ? C.red : cp < 30 ? C.amber : C.green)}</div>` +
      this.btn('Container refilled', 'mdi:bottle-tonic-plus', 'confirm-run', 'data-e="script.sentinel_x1_refilled" data-msg="Mark the container as refilled to its full size?"', C.teal, 'Resets to full size', 'wide slim') +
      this.details('cont-set', 'Container settings', 'mdi:cog-outline',
        this.row('Container size', this.stepper('input_number.sentinel_x1_container_size')) +
        this.row('Alert at', this.stepper('input_number.sentinel_x1_container_alert_days')) +
        this.row('Stop dosing at', this.stepper('input_number.sentinel_x1_container_stop_ml')) +
        this.row('Remaining', this.stepper('input_number.sentinel_x1_container_ml', { step: 10, dp: 0 }), 'Adjust if you topped up partway')));
    return `${this.hero(actions)}${this.calBanners()}<div class="dwrap"><div class="dgrid">${volume}${schedule}<div class="dstack">${pauses}${container}</div></div></div>`;
  }
  dayPlan(e) {
    const hm = e.hour_plan || [], w = e.weights || [], d = num(e.daily);
    if (!hm.length) return '';
    let s = 0; for (let i = 0; i < hm.length; i++) s += hm[i] * w[i];
    const vals = hm.map((m, i) => s > 0 ? d * m * w[i] / s : 0), mx = Math.max(...vals, 0.0001), h = new Date().getHours();
    return `<div class="plan"><div class="fl">Planned per hour</div><div class="bars">${vals.map((v, i) =>
      `<i title="${String(i).padStart(2, '0')}:00 · ${v.toFixed(2)} mL" style="height:${Math.max(3, v / mx * 100)}%;background:${i === h ? C.blue : v > 0 ? '#9DBDF5' : '#E6EBF2'}"></i>`).join('')}</div>
      <div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>`;
  }
  gauge(label, icon, value, sub, pct, c, extra = '') {
    return `<div class="g"><div class="g-h">${this.icon(icon, c, 18)}<span class="g-l">${label}</span><span class="g-v">${value}</span></div>
      ${pct === null ? '' : this.bar(pct, c)}<div class="g-s">${sub}${extra}</div></div>`;
  }
  phScale(v, lo, hi, target) {
    const min = Math.min(lo, isNaN(v) ? lo : v, target || lo) - 0.2, max = Math.max(hi, isNaN(v) ? hi : v, target || hi) + 0.2;
    const x = (t) => Math.max(0, Math.min(100, (t - min) / (max - min) * 100));
    const ok = !isNaN(v) && v >= lo && v <= hi;
    return `<div class="phs"><div class="phs-track"><div class="phs-band" style="left:${x(lo)}%;width:${x(hi) - x(lo)}%"></div>
      ${target ? `<div class="phs-tgt" style="left:${x(target)}%" title="Target ${target}"></div>` : ''}
      ${isNaN(v) ? '' : `<div class="phs-dot" style="left:${x(v)}%;background:${ok ? C.green : C.red}"></div>`}</div>
      <div class="phs-ax"><span>${min.toFixed(1)}</span><span>alarm ${lo}–${hi}${target ? ` · target ${target}` : ''}</span><span>${max.toFixed(1)}</span></div></div>`;
  }
  viewStatus() {
    const e = this.engine(), block = String(e.block || '').trim(), ph = this.phInfo();
    const en = this.on('input_boolean.sentinel_x1_enabled'), phOn = e.ph_on === true || e.ph_on === 'True';
    const today = num(this.s('input_number.sentinel_x1_today_ml')), cap = num(e.daily_cap);
    const hour = num(this.s('input_number.sentinel_x1_hour_ml')), hcap = num(e.hourly_cap);
    const cp = num(this.s('sensor.sentinel_x1_container_percent')), dv = num(this.s('sensor.sentinel_x1_container_days'));
    const khv = parseFloat(this.s('sensor.sentinel_x1_kh')), khT = num(this.s('input_number.sentinel_x1_kh_target'));
    const khAge = num(this.a('sensor.sentinel_x1_kh', 'age_h'), 999), khFrom = this.a('sensor.sentinel_x1_kh', 'from');
    const age = num(this.s('sensor.sentinel_x1_calibration_age'), 999);
    const pump = this.s('sensor.kamoer_x1_pro_t_kamoer_status') || 'unknown', pumpOk = ['idle', 'running'].includes(pump);
    const retE = (this.s('input_text.sentinel_x1_return_entity') || '').trim(), retS = retE ? this.s(retE) : null;
    const k = e.pause_kind, paused = k === 'Feed' || k === 'Maintenance';
    const awc = this.on('binary_sensor.sentinel_controller_water_change');
    const pct = (a, b) => b > 0 ? Math.min(100, a / b * 100) : 0;
    const tone = (p, w = 80, bad = 100) => p >= bad ? C.red : p >= w ? C.amber : C.green;
    // overall verdict
    let vt, vc, vi, vs;
    if (!en || block === 'Disabled') { vt = 'Pump Enable is off'; vc = C.grey; vi = 'mdi:shield-off-outline'; vs = 'Guards are watching, but nothing doses until you turn it on.'; }
    else if (block) { vt = `Paused: ${esc(block)}`; vc = C.amber; vi = 'mdi:shield-alert'; vs = num(e.pause_left_min) > 0 ? `${num(e.pause_left_min)} min left` : 'Dosing resumes automatically when this clears.'; }
    else if (!isNaN(ph.v) && ph.c === C.red) { vt = 'pH outside alarm range'; vc = C.red; vi = 'mdi:shield-alert'; vs = 'Alert only: dosing continues.'; }
    else { vt = 'All clear'; vc = C.green; vi = 'mdi:shield-check'; vs = phOn ? 'pH hold is dosing kalkwasser to the target.' : 'Dosing the daily plan within every limit.'; }
    const checks = [!block || block === 'Disabled', pct(today, cap) < 100, pct(hour, hcap) < 100, cp >= 15, isNaN(ph.v) || ph.c !== C.red, pumpOk, retS !== 'off'];
    const okN = checks.filter(Boolean).length;
    const overview = `<div class="ov">
      <div class="ov-hd"><div class="ov-badge" style="background:${vc}1A">${this.icon(vi, vc, 34)}</div>
        <div class="ov-t"><div class="eyebrow">Safety status</div><div class="headline">${vt}</div><div class="hsub">${vs}</div></div>
        <div class="ov-score"><b style="color:${okN === checks.length ? C.green : C.amber}">${okN}/${checks.length}</b><span>guards OK</span></div></div>
      <div class="ov-grid">
        ${this.gauge('Daily ceiling', 'mdi:water-check', `${today.toFixed(1)} / ${cap} mL`, phOn ? 'pH hold daily max' : `${num(this.s('input_number.sentinel_x1_daily_cap_pct'))}% of daily volume`, pct(today, cap), tone(pct(today, cap)))}
        ${this.gauge('Hourly ceiling', 'mdi:timer-outline', `${hour.toFixed(2)} / ${hcap} mL`, 'This hour so far', pct(hour, hcap), tone(pct(hour, hcap)))}
        ${this.gauge('Container', 'mdi:bottle-tonic', `${cp.toFixed(0)}%`, `${num(this.s('input_number.sentinel_x1_container_ml')).toFixed(0)} mL${dv > 0 ? ` · ${dv} day${dv === 1 ? '' : 's'}` : ''}`, cp, cp < 15 ? C.red : cp < 30 ? C.amber : C.green)}
        ${this.gauge('Calibration', 'mdi:beaker-check', age < 900 ? `${age} day${age === 1 ? '' : 's'}` : 'Never', 'Recalibration suggested at 90 days', age < 900 ? pct(age, 90) : 100, age >= 90 ? C.amber : C.green)}
        <div class="g wide"><div class="g-h">${this.icon('mdi:ph', ph.c, 18)}<span class="g-l">pH</span><span class="g-v" style="color:${ph.c}">${isNaN(ph.v) ? 'No probe' : ph.v.toFixed(2)}</span></div>
          ${this.phScale(ph.v, ph.lo, ph.hi, phOn ? num(this.s('input_number.sentinel_x1_ph_target')) : 0)}</div>
        ${this.gauge('KH', 'mdi:test-tube', isNaN(khv) ? 'No reading' : `${khv.toFixed(2)} dKH`, isNaN(khv) ? 'Enter a test on the KH auto-tune panel' : `target ${khT} · ${khAge < 999 ? `${khAge} h old` : ''}${khFrom ? ` · ${esc(khFrom)}` : ''}`, null, C.teal)}
        ${this.gauge('Return pump', 'mdi:pump', !retE ? 'Not used' : retS === 'off' ? 'Off · pausing' : 'Flowing', retE ? esc(retE) : 'Pick an outlet under Tank conditions', null, !retE ? C.grey : retS === 'off' ? C.amber : C.green)}
        ${this.gauge('Pump bridge', 'mdi:lan-connect', pump.charAt(0).toUpperCase() + pump.slice(1), esc(this.s('sensor.kamoer_x1_pro_t_kamoer_last_run') || ''), null, pumpOk ? C.green : C.red)}
        ${this.gauge('Pauses', 'mdi:pause-circle-outline', paused ? `${k} · ${num(e.pause_left_min)} min` : awc ? 'Water change' : 'None', awc ? 'Sentinel Controller water change running' : 'Feed and maintenance from the Dosing tab', null, paused || awc ? C.amber : C.green)}
      </div></div>`;
    const limits = this.panel('Limits', 'mdi:speedometer',
      this.row('Daily ceiling', this.stepper('input_number.sentinel_x1_daily_cap_pct'), `Today: ${num(e.daily_cap)} mL`) +
      this.row('Hourly ceiling', this.stepper('input_number.sentinel_x1_hourly_cap_x', { unit: '×' }), `× busiest hour · now ${num(e.hourly_cap)} mL/h`) +
      this.row('Manual dose limit', this.stepper('input_number.sentinel_x1_manual_max')));
    const tank = this.panel('Tank conditions', 'mdi:ph',
      `<div class="field"><div class="fl">pH probe</div>${this.select('input_select.sentinel_x1_ph_source', true)}</div>` +
      this.row('Alarm above', this.stepper('input_number.sentinel_x1_ph_stop')) +
      this.row('Alarm below', this.stepper('input_number.sentinel_x1_ph_resume')) +
      this.note('The pH alarm only alerts you. It never changes dosing.', 'mdi:bell-alert-outline') +
      `<div class="field"><div class="fl">Return pump outlet <span class="muted">(off = pause)</span></div>${this.select('input_select.sentinel_x1_return_source', true)}</div>`);
    const fb = this.on('input_boolean.sentinel_x1_ph_fallback');
    const isKalk = this.s('input_select.sentinel_x1_kh_product') === 'Saturated kalkwasser';
    const holdSw = this.on('input_boolean.sentinel_x1_ph_hold');
    const phStatus = !isKalk && !fb ? this.banner(C.grey, 'mdi:lock-outline', 'Needs kalkwasser · dosing the daily plan', 'pH hold only works with Saturated kalkwasser. Your product is ' + esc(this.s('input_select.sentinel_x1_kh_product') || 'not set') + '. To use pH hold, pick Saturated kalkwasser under Tank &amp; product.')
      : !phOn && !holdSw ? this.banner(C.grey, 'mdi:ph', 'Off · dosing the daily plan', 'Turn on to dose kalkwasser to hold pH at the target instead of a set volume.')
      : fb ? this.banner(C.amber, 'mdi:backup-restore', 'Back on the daily plan', esc(this.s('input_text.sentinel_x1_ph_fallback_why')), `<div class="inline-acts"><button class="link strong" data-act="run" data-e="script.sentinel_x1_ph_retry">Retry pH hold</button></div>`)
      : this.banner(C.teal, 'mdi:target', `Holding pH ${this.s('input_number.sentinel_x1_ph_target')} · now ${this.s('sensor.sentinel_x1_ph')}`, esc(e.summary || ''));
    const phHold = this.panel('pH hold · Meckley Method', 'mdi:target', phStatus +
      this.row('pH hold', isKalk ? this.toggle('input_boolean.sentinel_x1_ph_hold') : `<button class="sw dis" disabled aria-disabled="true" role="switch" aria-checked="false" title="Needs Saturated kalkwasser"><i></i></button>`, isKalk ? 'Kalkwasser only' : 'Locked · needs kalkwasser') +
      this.row('Target pH', this.stepper('input_number.sentinel_x1_ph_target')) +
      this.row('Max per hour', this.stepper('input_number.sentinel_x1_ph_max_ml_h')) +
      this.row('Max per day', this.stepper('input_number.sentinel_x1_ph_max_ml_day')) +
      this.row('Stop if KH above', this.stepper('input_number.sentinel_x1_ph_max_kh')) +
      this.note('Falls back to the daily plan and alerts you if the probe fails or pH doesn’t respond the way the dosed kalk should.', 'mdi:shield-half-full'));
    const khOn = this.on('input_boolean.sentinel_x1_kh_enabled'), phase = this.s('input_select.sentinel_x1_kh_phase');
    const corr = num(this.s('input_number.sentinel_x1_kh_corr_ml_day'));
    const kh = this.panel('KH auto-tune', 'mdi:tune-variant',
      this.row('Auto-tune', this.toggle('input_boolean.sentinel_x1_kh_enabled'), khOn ? 'Checks 06:05 daily' : 'Off') +
      `<div class="khhead"><span>State</span>${this.pill(phase || '—', !khOn ? C.grey : phase === 'Needs manual test' ? C.amber : C.green)}</div>
       <div class="kpis two">
        ${this.kpi('mdi:scale-balance', 'Holds steady', `${num(this.s('input_number.sentinel_x1_kh_base_ml')).toFixed(1)} mL/d`, C.blue)}
        ${this.kpi('mdi:plus-minus', 'Correction', `${corr >= 0 ? '+' : ''}${corr.toFixed(1)} mL/d`, C.teal)}
        ${this.kpi('mdi:chart-line-variant', 'Expected', `${num(this.s('input_number.sentinel_x1_kh_expected')).toFixed(2)} dKH`, C.slate)}
        ${this.kpi('mdi:calendar-clock', 'Waiting', `Day ${num(this.s('input_number.sentinel_x1_kh_cycle_day'))} of ${num(this.s('input_number.sentinel_x1_kh_wait_days'))}`, C.slate)}</div>` +
      this.row('KH target', this.stepper('input_number.sentinel_x1_kh_target')) +
      `<div class="field"><div class="fl">KH reading from</div>${this.select('input_select.sentinel_x1_kh_source', true)}</div>` +
      this.btn('Enter KH test', 'mdi:test-tube', 'khtest', '', C.teal, isNaN(khv) ? 'No reading yet' : `Now ${khv.toFixed(2)} dKH`, 'wide') +
      this.details('kh-prot', 'Protection', 'mdi:shield-half-full',
        this.row('Max KH rise per day', this.stepper('input_number.sentinel_x1_kh_max_rise')) +
        this.row('Waiting period', this.stepper('input_number.sentinel_x1_kh_wait_days')) +
        this.row('Tolerance', this.stepper('input_number.sentinel_x1_kh_tolerance'))));
    const custom = this.s('input_select.sentinel_x1_kh_product') === 'Custom';
    const product = this.panel('Tank & product', 'mdi:flask-outline',
      this.row('Tank water volume', this.stepper('input_number.sentinel_x1_tank_volume', { step: 1, dp: 1 })) +
      `<div class="field"><div class="fl">Unit</div>${this.seg('input_select.sentinel_x1_volume_unit')}</div>` +
      `<div class="field"><div class="fl">Alkalinity product</div>${this.select('input_select.sentinel_x1_kh_product', true)}</div>` +
      (custom ? this.row('Strength', this.stepper('input_number.sentinel_x1_kh_custom_strength'), 'dKH per mL per 100 L') : '') +
      this.row('Raises KH 1 dKH per', `<span class="ro">${num(this.a('sensor.sentinel_x1_kh', 'ml_per_dkh'))} mL</span>`) +
      this.note('Used by KH auto-tune and by the pH hold response check.'));
    const alerts = this.panel('Alerts', 'mdi:bell-ring-outline',
      `<div class="field"><div class="fl">Also send alerts to</div>${this.select('input_select.sentinel_x1_notify_target', true)}</div>` +
      this.note('Alerts always appear in Home Assistant notifications. Pick a phone or Pushover to get them there too.'));
    return `${overview}<div class="cols">${limits}${tank}${kh}${phHold}${product}${alerts}</div>`;
  }
  /* ---------- speed in mL/min ----------
   * The pump takes RPM. mL/min comes from the three-point calibration curve
   * (engine attribute flow_curve, same straight-line interpolation as the bridge
   * and engine). Typed mL/min is converted to the nearest whole RPM; the field then
   * shows the mL/min that RPM actually delivers. */
  curve() { const c = this.engine().flow_curve; return Array.isArray(c) && c.length >= 2 ? c.map(p => [num(p[0]), num(p[1])]) : null; }
  flowAt(rpm) {
    const p = this.curve(); if (!p) return null;
    for (let i = 1; i < p.length; i++) if (rpm <= p[i][0] || i === p.length - 1)
      return p[i - 1][1] + (rpm - p[i - 1][0]) * (p[i][1] - p[i - 1][1]) / (p[i][0] - p[i - 1][0]);
    return null;
  }
  rpmAt(flow) {
    const p = this.curve(); if (!p) return null;
    for (let i = 1; i < p.length; i++) if (flow <= p[i][1] || i === p.length - 1)
      return p[i - 1][0] + (flow - p[i - 1][1]) * (p[i][0] - p[i - 1][0]) / Math.max(p[i][1] - p[i - 1][1], 1e-4);
    return null;
  }
  setFlow(id, flow) {
    const r = this.rpmAt(flow); if (r == null || isNaN(r)) return;
    return this.setNum(id, Math.round(Math.min(350, Math.max(1, r))));
  }
  flowStepper(id) {
    const o = this.st(id); if (!o) return `<span class="na">unavailable</span>`;
    const fl = this.flowAt(num(o.state));
    if (fl == null) return this.stepper(id) + `<span class="na"> calibrate for mL/min</span>`;
    return `<div class="step"><button data-act="fdec" data-e="${id}" aria-label="decrease">−</button>
      <input inputmode="decimal" data-act="flow" data-e="${id}" value="${fl.toFixed(1)}"/><span class="u">mL/min</span>
      <button data-act="finc" data-e="${id}" aria-label="increase">+</button></div>`;
  }
  pumpRate(e) {
    const m = String(e.active_mode || '').trim(), rpm = m === 'Continuous' ? num(e.rpm_now) : num(e.pulse_rpm), fl = this.flowAt(rpm);
    if (!(rpm > 0) || fl == null) return '';
    return m === 'Continuous' ? `${fl.toFixed(1)} mL/min` : `pulses at ${fl.toFixed(1)} mL/min`;
  }
  /* dose speed: pulse speed for microdose/bolus; continuous speed follows the daily volume */
  doseSpeed(e) {
    if (String(e.active_mode || '').trim() === 'Continuous') {
      const rpm = num(e.rpm_now), fl = this.flowAt(rpm);
      return this.row('Dose speed', `<span class="ro">${rpm > 0 && fl != null ? `${fl.toFixed(1)} mL/min` : '—'}</span>`, 'Continuous: set by the daily volume') +
        this.row('Slowest allowed', this.flowStepper('input_number.sentinel_x1_min_rpm'), 'Below this the engine pulses instead');
    }
    const pf = num(e.pulse_flow), pml = num(e.pulse_ml), fac = num(this.s('number.kamoer_x1_pro_t_kamoer_pulse_factor'), 1) || 1;
    const secs = pf > 0 && pml > 0 ? pml / (pf / 60) / (pml <= 1 ? fac : 1) : 0;
    const hint = secs ? `${fmt(pml, 1)} mL pulse runs ${secs < 10 ? secs.toFixed(2) : secs.toFixed(0)} s at this speed` : 'Speed each pulse runs at';
    return this.row('Dose speed', this.flowStepper('input_number.sentinel_x1_pulse_rpm'), hint) +
      this.note('Changing it changes pulse length. Run the pulse check (Settings › Calibration) after a change.', 'mdi:information-outline');
  }
  /* pulse check: preview what Save will do (same math as script.sentinel_x1_pulse_save) */
  pulsePreview(size, running) {
    const measured = num(this.s('input_number.sentinel_x1_pulse_check_ml')), expected = 50 * size;
    const old = num(this.s('number.kamoer_x1_pro_t_kamoer_pulse_factor'), 1) || 1;
    const save = (ok, sub) => ok ? this.btn('Save result', 'mdi:content-save-check', 'run', 'data-e="script.sentinel_x1_pulse_save"', C.green, sub, 'wide')
      : `<button class="act wide dis" disabled style="--t:${C.grey}"><span class="ai">${this.icon('mdi:content-save-check', C.grey, 21)}</span><span class="at"><b>Save result</b><small>${sub}</small></span></button>`;
    if (running) return save(false, 'Available when the run finishes');
    if (!(measured > 0)) return save(false, 'Enter mL collected first');
    if (size > 1) return this.banner(C.amber, 'mdi:alert', 'Not used for pulses over 1 mL', `Your smallest pulse is ${fmt(size, 1)} mL; the factor only applies to doses of 1 mL or less.`, '', 'slim');
    const raw = old * measured / expected, overrun = measured / 50 - size / old;
    const off = measured < expected * 0.9 || measured > expected * 1.1;
    if (raw < 0.5 || raw > 1.5) {
      const sug = Math.max(Math.ceil(overrun * 100) / 10, size + 0.1).toFixed(1);
      const why = overrun > 0 ? `Each pulse overran by about ${Math.round(overrun * 1000)} µL. Raise Smallest accurate pulse (Delivery limits) to ${sug} mL, then run the check again.`
        : 'Check the line for air or a leak, then run the check again.';
      return this.banner(C.red, 'mdi:close-octagon', `Needs factor ${raw.toFixed(2)}, outside 0.5–1.5`, why, '', 'slim') + save(false, 'Can’t correct this much');
    }
    return `<div class="exp ${off ? 'off' : ''}">${this.icon('mdi:calculator-variant', off ? C.amber : C.muted, 16)}<span>${fmt(measured, 2)} of ${expected.toFixed(2)} mL → factor <b>${old.toFixed(3)} → ${raw.toFixed(3)}</b>${off ? ' · outside ±10 %, run again after saving' : ''}</span></div>`
      + (Math.abs(raw - old) / old > 0.25
        ? this.btn('Save result', 'mdi:content-save-check', 'confirm-run', `data-e="script.sentinel_x1_pulse_save" data-msg="This changes the pulse factor by ${Math.round(Math.abs(raw - old) / old * 100)} % (${old.toFixed(3)} → ${raw.toFixed(3)}). A change this big usually means a measuring or setup error. Save it anyway?"`, C.amber, `Big change: ${old.toFixed(3)} → ${raw.toFixed(3)}, asks first`, 'wide')
        : save(true, `Sets the factor to ${raw.toFixed(3)}`));
  }
  /* spread of the last pulses (bridge keeps on-time ÷ planned for the last 50) */
  pulseSpread() {
    const id = 'sensor.kamoer_x1_pro_t_kamoer_last_pulse', n = num(this.a(id, 'recent_n'));
    if (!n) return '';
    const lo = num(this.a(id, 'recent_min_ratio')), hi = num(this.a(id, 'recent_max_ratio')), avg = num(this.a(id, 'recent_avg_ratio'));
    const bad = hi > 1.15 || lo < 0.85;
    return `<div class="exp ${bad ? 'off' : ''}">${this.icon(bad ? 'mdi:alert' : 'mdi:chart-bell-curve', bad ? C.amber : C.muted, 16)}<span>Last ${n} pulse${n === 1 ? '' : 's'}: <b>${Math.round(lo * 100)}–${Math.round(hi * 100)} %</b> of planned on-time (avg ${Math.round(avg * 100)} %)${bad ? ' · uneven, check the bridge log and Wi-Fi' : ''}</span></div>`;
  }
  /* speed limits in mL/min: what the pump can do, what calibration covers, what is in use */
  speedRange() {
    const c = this.curve(); if (!c || c.length < 2) return '';
    const lo = c[1], hi = c[c.length - 1], f1 = this.flowAt(1), fMax = this.flowAt(350);
    const pRpm = num(this.s('input_number.sentinel_x1_pulse_rpm')), mRpm = num(this.s('input_number.sentinel_x1_min_rpm'));
    const pF = this.flowAt(pRpm), mF = this.flowAt(mRpm);
    const out = (r) => r < lo[0] || r > hi[0];
    const use = (lab, f, r) => `<div class="${out(r) ? 'warn' : ''}"><span class="lab">${lab}</span><b>${f.toFixed(1)} mL/min</b>${out(r) ? '<small>outside calibrated range, estimated</small>' : ''}</div>`;
    return `<div class="sub-h">Speed limits</div>` +
      this.row('Pump range', `<span class="ro">${f1.toFixed(2)}–${fMax.toFixed(1)} mL/min</span>`, '1–350 RPM the bridge accepts. Only the calibrated range below is verified.') +
      this.row('Calibrated range', `<span class="ro">${lo[1].toFixed(2)}–${hi[1].toFixed(1)} mL/min</span>`, `Measured between ${lo[0]} and ${hi[0]} RPM. Slower than this is estimated, not measured.`) +
      `<div class="spd">${use('Pulse speed', pF, pRpm)}${use('Slowest continuous', mF, mRpm)}</div>`;
  }
  /* engine never pulses below 2 pump-head turns at pulse speed */
  floorHint() {
    const e = this.engine(), fl = num(e.pulse_floor), eff = num(e.min_pulse_eff), set = num(this.s('input_number.sentinel_x1_min_pulse'));
    if (!fl) return '';
    return set < eff ? `<span style="color:${C.amber}">Raised to ${fmt(eff, 1)} mL: 2 pump-head turns = ${fl.toFixed(2)} mL at pulse speed</span>`
      : `At least ${fl.toFixed(2)} mL (2 pump-head turns at pulse speed)`;
  }
  /* calibration sanity: a new value more than 25 % from the current one asks first */
  _calGuard(id, v) {
    const CAL = { 'number.kamoer_x1_pro_t_kamoer_cal_200_rpm': 1, 'number.kamoer_x1_pro_t_kamoer_cal_350_rpm': 1, 'input_number.sentinel_x1_cal_low_collected': 5 };
    if (!(id in CAL)) return Promise.resolve(true);
    const cur = id.startsWith('input_number') ? num(this.s('number.kamoer_x1_pro_t_kamoer_cal_low')) * 5 : num(this.s(id));
    if (!(cur > 0) || !(v > 0) || Math.abs(v - cur) / cur <= 0.25) return Promise.resolve(true);
    return this._confirm(`${fmt(v, 2)} mL is ${Math.round(Math.abs(v - cur) / cur * 100)} % away from the current calibration (${fmt(cur, 2)} mL). A change this big usually means a measuring or setup error, and it rescales every dose. Save it anyway?`);
  }
  lastPulse() {
    const id = 'sensor.kamoer_x1_pro_t_kamoer_last_pulse', on = parseFloat(this.s(id));
    if (isNaN(on)) return `<span class="na">no pulse yet</span>`;
    const pl = num(this.a(id, 'planned_s'));
    return `<span class="ro">${on.toFixed(3)} s${pl ? `<span class="muted"> · planned ${pl.toFixed(3)}</span>` : ''}</span>`;
  }
  details(key, title, icon, body) {
    this._open = this._open || {};
    return `<details class="dt" data-k="${key}" ${this._open[key] ? 'open' : ''}><summary>${this.icon(icon, C.muted, 18)}<span>${title}</span>${this.icon('mdi:chevron-down', C.muted, 18)}</summary><div class="dt-b">${body}</div></details>`;
  }
  viewSettings() {
    const e = this.engine(), running = this.on('input_boolean.sentinel_x1_calibrating');
    const curve = (e.flow_curve || []).slice(1);
    const step = (n, title, hint, body) => `<div class="cstep"><div class="cn">${n}</div><div class="cb"><b>${title}</b><small>${hint}</small>${body}</div></div>`;
    const age = num(this.s('sensor.sentinel_x1_calibration_age'));
    /* calibration runs: live countdown + expected range (±10 % of the last calibration) */
    const RUNS = { low: 'script.sentinel_x1_cal_run_low', mid: 'script.sentinel_x1_cal_run_mid',
      high: 'script.sentinel_x1_cal_run_high', pulse: 'script.sentinel_x1_cal_run_pulses', test: 'script.sentinel_x1_test_run' };
    const TOTAL = { low: 300, mid: 60, high: 60 };
    const which = Object.keys(RUNS).find(k => this.on(RUNS[k]));
    const tEnd = this.s('timer.sentinel_x1_cal') === 'active' ? Date.parse(this.a('timer.sentinel_x1_cal', 'finishes_at')) : NaN;
    const tDur = (() => { const d = String(this.a('timer.sentinel_x1_cal', 'duration') || '').split(':').map(Number); return d.length === 3 ? (d[0] * 3600 + d[1] * 60 + d[2]) * 1000 : 0; })();
    const cdText = (end) => isNaN(end) ? 'Starting…' : `${mmss(end - Date.now())} left`;
    const countdown = (k) => {
      const total = tDur || (TOTAL[k] || 0) * 1000;
      const pct = !isNaN(tEnd) && total ? 100 - (tEnd - Date.now()) / total * 100 : 0;
      return `<div class="cdbox"><div class="cdtop">${this.icon('mdi:timer-sand', C.amber, 20)}<b class="cd" data-end="${isNaN(tEnd) ? '' : tEnd}">${cdText(tEnd)}</b>
        <button class="link strong" data-act="run" data-e="script.sentinel_x1_cal_cancel">Cancel</button></div>
        <div class="bar"><i class="cdbar" data-end="${isNaN(tEnd) ? '' : tEnd}" data-total="${total}" style="width:${Math.max(0, Math.min(100, pct))}%;background:${C.amber}"></i></div></div>`;
    };
    const lowF = num(this.s('number.kamoer_x1_pro_t_kamoer_cal_low')), midF = num(this.s('number.kamoer_x1_pro_t_kamoer_cal_200_rpm')),
      highF = num(this.s('number.kamoer_x1_pro_t_kamoer_cal_350_rpm')), size = num(this.engine().min_pulse_eff, num(this.s('input_number.sentinel_x1_min_pulse'), 0.1));
    const EXP = {
      low: num(this.s('input_number.sentinel_x1_cal_expect_low')) || lowF * 5,
      mid: num(this.s('input_number.sentinel_x1_cal_expect_mid')) || midF,
      high: num(this.s('input_number.sentinel_x1_cal_expect_high')) || highF,
      pulse: 50 * size };
    const GOT = { low: num(this.s('input_number.sentinel_x1_cal_low_collected')), mid: midF, high: highF, pulse: 0 };
    const range = (k) => {
      const x = EXP[k]; if (!(x > 0)) return this.note('No earlier calibration to compare against yet.', 'mdi:target');
      const dp = x < 20 ? 2 : 1, lo = x * 0.9, hi = x * 1.1, g = GOT[k];
      const off = g > 0 && (g < lo || g > hi);
      return `<div class="exp ${off ? 'off' : ''}">${this.icon(off ? 'mdi:alert' : 'mdi:target', off ? C.amber : C.muted, 16)}<span>Expected <b>${lo.toFixed(dp)}–${hi.toFixed(dp)} mL</b> (±10 % of ${x.toFixed(dp)})${off ? ` · ${g.toFixed(dp)} is outside, re-run to confirm` : ''}</span></div>`;
    };
    const runBtn = (k, label, sub) => which === k ? countdown(k)
      : this.btn(label, 'mdi:play', 'calrun', `data-e="${RUNS[k]}"`, which ? C.grey : C.blue, sub || '', 'wide');
    const stepNames = { low: 'Low speed', mid: '200 RPM', high: '350 RPM', pulse: 'Pulse check', test: 'Speed test' };
    const cal = this.panel('Calibration', 'mdi:beaker',
      (running ? this.banner(C.amber, 'mdi:progress-clock', which ? `${stepNames[which]} running · <span class="cd" data-end="${isNaN(tEnd) ? '' : tEnd}">${cdText(tEnd)}</span>` : 'Run in progress', 'Dosing is paused until it finishes.', `<div class="inline-acts"><button class="link strong" data-act="run" data-e="script.sentinel_x1_cal_cancel">Cancel run</button></div>`)
        : this.note('Put the dose line in a graduated cylinder. Run each step, read the cylinder, enter the number, empty the cylinder. Points left at 0 are skipped.', 'mdi:beaker-outline')) +
      step(1, 'Low speed · 5 min', 'Use your minimum stable speed',
        this.row('Low speed', this.stepper('number.kamoer_x1_pro_t_kamoer_cal_low_speed')) +
        runBtn('low', 'Run 5 min') + range('low') +
        this.row('mL collected in 5 min', this.stepper('input_number.sentinel_x1_cal_low_collected'))) +
      step(2, '200 RPM · 60 s', 'Enter mL collected',
        runBtn('mid', 'Run 60 s') + range('mid') +
        this.row('mL collected', this.stepper('number.kamoer_x1_pro_t_kamoer_cal_200_rpm', { unit: 'mL' }))) +
      step(3, '350 RPM · 60 s', 'Enter mL collected',
        runBtn('high', 'Run 60 s') + range('high') +
        this.row('mL collected', this.stepper('number.kamoer_x1_pro_t_kamoer_cal_350_rpm', { unit: 'mL' }))) +
      step(4, 'Pulse check · 50 pulses', `Optional · fine-tunes small pulses · 50 × ${fmt(size, 2)} mL`,
        runBtn('pulse', 'Run 50 pulses') + range('pulse') +
        this.row('mL collected', this.stepper('input_number.sentinel_x1_pulse_check_ml'), 'Type the reading, then Save') +
        this.pulsePreview(size, !!which) +
        this.row('Pulse factor', `<span class="ro">${fmt(this.s('number.kamoer_x1_pro_t_kamoer_pulse_factor'), 3)}</span>`, '1.000 = exact') +
        this.row('Last pulse', this.lastPulse(), 'Motor on-time of the most recent pulse') +
        this.pulseSpread() +
        this.btn('Reset factor to 1.000', 'mdi:restore', 'confirm-run', 'data-e="script.sentinel_x1_pulse_factor_reset" data-msg="Set the pulse factor back to 1.000? Run the pulse check afterwards to measure a new one."', C.slate, 'Start the pulse check from scratch', 'wide')));
    const status = this.panel('Calibration status', 'mdi:beaker-check',
      `<div class="kpis two">${this.kpi('mdi:calendar-check', 'Last calibration', esc(this.s('input_datetime.sentinel_x1_last_cal') || '—'), C.blue, age < 900 ? `${age} days ago` : '')}
       ${this.kpi('mdi:chart-bell-curve-cumulative', 'Flow curve', curve.length ? `${curve.length} points` : 'Not set', curve.length ? C.green : C.amber)}</div>` +
      (curve.length ? `<div class="curve">${curve.map(p => `<div><b>${p[0]}</b> RPM<span>${(+p[1]).toFixed(2)} mL/min</span></div>`).join('')}</div>` : '') +
      this.speedRange() +
      this.btn('Re-checked, no change', 'mdi:beaker-check', 'run', 'data-e="script.sentinel_x1_calibrated"', C.green, 'Resets the 90-day reminder', 'wide') +
      this.btn('Clear calibration', 'mdi:beaker-remove', 'confirm-run', 'data-e="script.sentinel_x1_cal_clear" data-msg="Wipe the calibration? All three speed points are erased and the pulse factor goes back to 1.000. The pump will not dose (scheduled or manual) until you calibrate all three speeds again."', C.red, 'Asks first · pump won’t dose until recalibrated', 'wide') +
      this.btn('Cancel run', 'mdi:close-circle', 'run', 'data-e="script.sentinel_x1_cal_cancel"', C.red, 'Stops any calibration or prime run', 'wide'));
    const pauses = this.panel('Pauses', 'mdi:pause-circle-outline',
      this.row('Feed pause length', this.stepper('input_number.sentinel_x1_feed_minutes')) +
      this.row('Sentinel Controller feed pause #', this.stepper('input_number.sentinel_x1_feed_n')) +
      this.row('Maintenance length', this.stepper('input_number.sentinel_x1_maint_minutes')) +
      this.row('Sentinel Controller maintenance #', this.stepper('input_number.sentinel_x1_maint_n')) +
      `<div class="field"><div class="fl">Missed volume after feed</div>${this.seg('input_select.sentinel_x1_missed')}</div>` +
      this.note('Which outlets switch during a pause is set in Sentinel Controller.', 'mdi:power-socket-us'));
    const limits = this.panel('Delivery limits', 'mdi:speedometer',
      this.row('Min stable continuous speed', this.flowStepper('input_number.sentinel_x1_min_rpm')) +
      this.row('Pulse speed', this.flowStepper('input_number.sentinel_x1_pulse_rpm')) +
      this.row('Smallest accurate pulse', this.stepper('input_number.sentinel_x1_min_pulse'), this.floorHint()) +
      this.row('Prime time', this.stepper('input_number.sentinel_x1_prime_seconds')) +
      this.btn('Prime line', 'mdi:pipe-valve', 'confirm-run', `data-e="script.sentinel_x1_prime" data-msg="${esc(PRIME_TXT)}"`, C.teal, 'Asks first', 'wide'));
    const tp = num(this.s('sensor.sentinel_x1_tubing_percent'));
    const tubing = this.panel('Tubing', 'mdi:timer-sand',
      `<div class="meter"><div class="mt"><b>${tp.toFixed(0)}<small>%</small></b><span>${num(this.s('input_number.sentinel_x1_tube_hours')).toFixed(1)} of ${num(this.s('input_number.sentinel_x1_tube_life')).toFixed(0)} h used</span></div>${this.bar(tp, tp >= 90 ? C.red : tp >= 80 ? C.amber : C.green)}</div>` +
      this.row('Run time', this.stepper('input_number.sentinel_x1_tube_hours', { step: 1, dp: 1 })) +
      this.row('Rated life', this.stepper('input_number.sentinel_x1_tube_life')) +
      this.btn('Tubing replaced', 'mdi:autorenew', 'confirm-run', 'data-e="script.sentinel_x1_tube_changed" data-msg="Reset tubing run time to 0? Recalibrate afterwards: new tubing changes flow."', C.blue, 'Resets run time; then recalibrate', 'wide'));
    const st = this.s('sensor.kamoer_x1_pro_t_kamoer_status') || 'unknown';
    const bridge = this.panel('Bridge', 'mdi:lan',
      this.row('Status', this.pill(st, ['idle', 'running'].includes(st) ? C.green : C.red)) +
      this.row('Last run', `<span class="ro">${esc(this.s('sensor.kamoer_x1_pro_t_kamoer_last_run') || '—')}</span>`) +
      this.row('Pump IP', `<span class="ro mono">${esc(this.s('sensor.kamoer_x1_pro_t_kamoer_ip') || '—')}</span>`) +
      `<div class="grid2">${this.btn('Stop pump', 'mdi:stop', 'press', 'data-e="button.kamoer_x1_pro_t_kamoer_stop"', C.red)}
        ${this.btn('Load defaults', 'mdi:restore', 'confirm-run', 'data-e="script.sentinel_x1_load_defaults" data-msg="Load the default settings? This overwrites your Sentinel X1 settings (not calibration)."', C.slate, 'First run only')}</div>`);
    /* speed test: timed run at any speed into a cylinder, compared with the calibration estimate */
    const tRpm = num(this.s('input_number.sentinel_x1_test_rpm')), tMin = num(this.s('input_number.sentinel_x1_test_minutes'));
    const tEst = this.flowAt(tRpm), c0 = this.curve(), calLo = c0 && c0.length > 1 ? c0[1][0] : 0;
    const lRpm = num(this.s('input_number.sentinel_x1_test_last_rpm')), lMin = num(this.s('input_number.sentinel_x1_test_last_minutes'));
    const got = num(this.s('input_number.sentinel_x1_test_collected')), lEst = this.flowAt(lRpm);
    let result = '';
    if (lRpm > 0 && lMin > 0 && got > 0 && which !== 'test') {
      const meas = got / lMin, diff = lEst ? (meas / lEst - 1) * 100 : NaN, off = Math.abs(diff) > 10;
      result = `<div class="exp ${off ? 'off' : ''}">${this.icon('mdi:calculator-variant', off ? C.amber : C.muted, 16)}<span>${lRpm} RPM for ${fmt(lMin, 0)} min: measured <b>${meas.toFixed(3)} mL/min</b>${lEst ? ` vs ${lEst.toFixed(3)} estimated (${diff >= 0 ? '+' : ''}${diff.toFixed(1)} %)` : ''}</span></div>` +
        (lRpm < 200 ? this.btn('Use as low calibration point', 'mdi:beaker-check', 'confirm-run', `data-e="script.sentinel_x1_test_use_low" data-msg="Replace the low calibration point (${calLo} RPM) with ${lRpm} RPM = ${meas.toFixed(3)} mL/min? Every slow speed and pulse is sized from this point."`, C.blue, `Sets the low point to ${lRpm} RPM`, 'wide') : '');
    }
    const test = this.panel('Speed test', 'mdi:speedometer',
      this.note('Timed run at any speed into a cylinder. Use it to check a speed outside the calibrated range before dosing at it.', 'mdi:beaker-outline') +
      this.row('Speed', this.stepper('input_number.sentinel_x1_test_rpm'), tEst != null ? `≈ ${tEst.toFixed(2)} mL/min ${tRpm < calLo ? '(estimated, below calibrated range)' : '(from calibration)'}` : '') +
      this.row('Run time', this.stepper('input_number.sentinel_x1_test_minutes'), tEst != null ? `Expect about ${(tEst * tMin).toFixed(1)} mL · max 29 min` : 'Max 29 min') +
      runBtn('test', 'Run speed test') +
      this.row('mL collected', this.stepper('input_number.sentinel_x1_test_collected'), 'Weigh or read the cylinder') + result);
    return `<div class="cols">${cal}${status}${test}${pauses}${limits}${tubing}${bridge}</div>`;
  }

  /* ---------- render + events ---------- */
  _render() {
    if (!this._hass) return;
    if (!this.shadowRoot) { this.attachShadow({ mode: 'open' }); this.shadowRoot.addEventListener('click', ev => this._click(ev));
      this.shadowRoot.addEventListener('change', ev => this._change(ev)); this.shadowRoot.addEventListener('toggle', ev => { const d = ev.target; if (d.matches && d.matches('details[data-k]')) { this._open = this._open || {}; this._open[d.dataset.k] = d.open; } }, true); this.shadowRoot.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ['num', 'flow'].includes(ev.target.dataset.act)) ev.target.blur(); });
      this.shadowRoot.addEventListener('focusin', ev => { if (ev.target.matches('input,select')) this._editing = true; });
      this.shadowRoot.addEventListener('focusout', ev => { if (ev.target.matches('input,select')) { this._editing = false; setTimeout(() => { if (this._dirty && !this._editing) { this._dirty = false; this._render(); } }, 250); } }); }
    const v = this._cfg.view;
    const body = !this.st(E) ? this.banner(C.red, 'mdi:alert', 'Sentinel X1 package not loaded', 'sensor.sentinel_x1_engine was not found.')
      : v === 'status' ? this.viewStatus() : v === 'settings' ? this.viewSettings() : this.viewDosing();
    this.shadowRoot.innerHTML = `<style>${CSS}</style><div class="wrap">${body}</div><div class="toast" hidden></div>`;
    this._cdTick();
  }
  /* countdown: repaint only the timer text/bar each second, no full re-render */
  _cdTick() {
    clearTimeout(this._cdT);
    const els = this.shadowRoot ? this.shadowRoot.querySelectorAll('.cd[data-end],.cdbar[data-end]') : [];
    if (!els.length) return;
    const now = Date.now();
    els.forEach(el => {
      const end = parseFloat(el.dataset.end); if (isNaN(end)) return;
      if (el.classList.contains('cdbar')) { const t = num(el.dataset.total); if (t) el.style.width = `${Math.max(0, Math.min(100, 100 - (end - now) / t * 100))}%`; }
      else el.textContent = end - now > 0 ? `${mmss(end - now)} left` : 'Finishing…';
    });
    this._cdT = setTimeout(() => this._cdTick(), 1000 - (now % 1000) + 20);
  }
  disconnectedCallback() { clearTimeout(this._cdT); }
  connectedCallback() { if (this.shadowRoot) this._cdTick(); }
  _click(ev) {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = b.dataset.e;
    if (act === 'inc' || act === 'dec') {
      const inp = b.parentElement.querySelector('input'); const step = num(b.dataset.s, 1);
      const v = num(inp.value) + (act === 'inc' ? step : -step);
      inp.value = fmt(v, decimals(step)); this.setNum(id, +v.toFixed(6));
    } else if (act === 'finc' || act === 'fdec') {
      const cur = this.flowAt(num(this.s(id))) || 0, step = cur < 10 ? 0.5 : 1;
      let r = Math.round(this.rpmAt(cur + (act === 'finc' ? step : -step))), now = num(this.s(id));
      if (r === now) r += act === 'finc' ? 1 : -1;            // always move at least one RPM
      this.setNum(id, Math.min(350, Math.max(1, r)));
    } else if (act === 'sel') this.call('input_select', 'select_option', { entity_id: id, option: b.dataset.v });
    else if (act === 'tog') this.call('homeassistant', 'toggle', { entity_id: id });
    else if (act === 'run') this.runScript(id);
    else if (act === 'calrun') this._calRun(id);
    else if (act === 'press') this.call('button', 'press', { entity_id: id });
    else if (act === 'confirm-run') this._confirm(b.dataset.msg).then(ok => ok && this.runScript(id));
    else if (act === 'nav') { history.pushState(null, '', location.pathname.replace(/[^/]+$/, b.dataset.p)); window.dispatchEvent(new CustomEvent('location-changed')); }
    else if (act === 'manual') {
      const max = num(this.s('input_number.sentinel_x1_manual_max'), 10);
      this._ask('Manual dose', 'How much to dose now?', num(this.s('input_number.sentinel_x1_manual_ml'), 1), 0.1, max, 0.1, 'mL', `Limit ${max} mL · counts toward today’s ceiling`)
        .then(v => v != null && this.runScript('script.sentinel_x1_manual_dose', { amount: v }));
    } else if (act === 'khtest') {
      this._ask('Enter KH test', 'Your hand test result', num(this.s('input_number.sentinel_x1_kh_manual'), 8.3) || 8.3, 3, 20, 0.01, 'dKH', 'Saved as the newest KH reading')
        .then(v => v != null && this.runScript('script.sentinel_x1_record_kh', { kh: v }));
    }
  }
  _change(ev) {
    const t = ev.target, id = t.dataset.e; if (!id) return;
    if (t.dataset.act === 'num') { const v = parseFloat(t.value); if (!isNaN(v)) this._calGuard(id, v).then(ok => ok ? this.setNum(id, v) : this._render()); }
    else if (t.dataset.act === 'flow') { const v = parseFloat(t.value); if (!isNaN(v) && v > 0) this.setFlow(id, v); }
    else if (t.dataset.act === 'pick') this.call('input_select', 'select_option', { entity_id: id, option: t.value });
    else if (t.dataset.act === 'time' && t.value) this.call('input_datetime', 'set_datetime', { entity_id: id, time: t.value + ':00' });
  }
  _modal(html) {
    this._modalOpen = true;
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="dlg">${html}</div>`;
    this.shadowRoot.appendChild(m); return m;
  }
  _close(m) { m.remove(); this._modalOpen = false; if (this._dirty) { this._dirty = false; this._render(); } }
  _confirm(msg) {
    return new Promise(res => {
      const m = this._modal(`<h4>Are you sure?</h4><p>${msg}</p><div class="dlg-a"><button class="ghost" data-x="0">Cancel</button><button class="primary" data-x="1">Yes, go ahead</button></div>`);
      m.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x || e.target === m) { this._close(m); res(!!(x && x.dataset.x === '1')); } });
    });
  }
  _ask(title, label, def, min, max, step, unit, hint) {
    return new Promise(res => {
      const m = this._modal(`<h4>${title}</h4><label>${label}</label><div class="step big"><button data-d="-1">−</button><input inputmode="decimal" value="${def}"/><span class="u">${unit}</span><button data-d="1">+</button></div><p class="hint">${hint}</p>
        <div class="dlg-a"><button class="ghost" data-x="0">Cancel</button><button class="primary" data-x="1">Dose</button></div>`);
      if (title.includes('KH')) m.querySelector('.primary').textContent = 'Save';
      const inp = m.querySelector('input'); setTimeout(() => inp.focus(), 50);
      m.addEventListener('click', e => {
        const d = e.target.closest('[data-d]'); if (d) { inp.value = fmt(Math.min(max, Math.max(min, num(inp.value) + step * +d.dataset.d)), decimals(step)); return; }
        const x = e.target.closest('[data-x]');
        if (x || e.target === m) {
          const v = parseFloat(inp.value);
          if (x && x.dataset.x === '1') { if (isNaN(v) || v < min || v > max) { m.querySelector('.hint').textContent = `Enter ${min}–${max} ${unit}.`; m.querySelector('.hint').style.color = C.red; return; } this._close(m); res(v); }
          else { this._close(m); res(null); }
        }
      });
    });
  }
  _toast(t) { const el = this.shadowRoot && this.shadowRoot.querySelector('.toast'); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(this._tt); this._tt = setTimeout(() => el.hidden = true, 4000); }
}

const CSS = `
:host{display:block;padding:16px 16px 28px;max-width:1480px;margin:0 auto;--ink:${C.ink};--muted:${C.muted};--line:${C.line};--soft:${C.soft};--blue:${C.blue};font-family:var(--ha-font-family-body, Roboto, system-ui, sans-serif);color:var(--ink)}
*{box-sizing:border-box} button{font:inherit;color:inherit;cursor:pointer;border:none;background:none;-webkit-tap-highlight-color:transparent}
.wrap{display:flex;flex-direction:column;gap:14px}
ha-icon{display:inline-flex;flex:none}
.panel,.hero,.wrap>.kpis,.banner,.act,.enable{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(19,35,58,.05),0 6px 18px rgba(19,35,58,.04)}
.cols{columns:3 330px;column-gap:14px}.cols>.panel{display:inline-flex;width:100%;margin:0 0 14px;break-inside:avoid;vertical-align:top}
.panel{padding:16px 16px 12px;display:flex;flex-direction:column;gap:10px}
.panel>header{display:flex;align-items:center;gap:8px;margin:-2px 0 2px}
.panel h3{font-size:15.5px;font-weight:700;margin:0;flex:1;letter-spacing:.01em}
/* hero */
.hero{padding:18px 20px}
.hero-top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.brand{display:flex;align-items:center;gap:12px}.logo{width:40px;height:40px;border-radius:12px;background:transparent;display:flex;align-items:center;justify-content:center}
.bt{font-size:17px;font-weight:750;line-height:1.1}.bs{font-size:12px;color:var(--muted)}
.hero-main{display:flex;align-items:center;gap:22px;margin-top:14px;flex-wrap:wrap}
.ring{width:118px;height:118px;flex:none}.rp{font-size:22px;font-weight:750;fill:var(--ink)}.rs{font-size:10.5px;fill:var(--muted)}
.hero-txt{flex:1;min-width:160px}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:650}
.headline{font-size:21px;font-weight:750;line-height:1.25;margin-top:3px}.hsub{font-size:13px;color:var(--muted);margin-top:5px;line-height:1.4}
.hero-ctl{flex:none;min-width:250px;max-width:360px}
.enable{display:flex;align-items:center;gap:14px;padding:12px 14px;width:100%;text-align:left;border-color:var(--line);transition:border-color .2s,background .2s}
.enable.on{border-color:${C.green}66;background:${C.green}0D}.et{flex:1;display:flex;flex-direction:column}.et b{font-size:15px}.et small{color:var(--muted);font-size:12px}
.hero .banner{margin-top:14px;box-shadow:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:10px}
.hero .kpis{margin-top:14px}
.wrap>.kpis{padding:14px}
.kpis.two{grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr))}
.kpi{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px;min-width:0}
.kpi-i{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none}
.kpi-t{min-width:0}.lab{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:650}
.val{font-size:15.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-weight:650;font-size:12.5px;white-space:nowrap;text-transform:capitalize}.pill i{width:7px;height:7px;border-radius:50%}
/* overview */
.ov{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(19,35,58,.05),0 6px 18px rgba(19,35,58,.04);padding:18px 20px}
.ov-hd{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.ov-badge{width:62px;height:62px;border-radius:18px;display:flex;align-items:center;justify-content:center;flex:none}
.ov-t{flex:1;min-width:200px}.ov-score{display:flex;flex-direction:column;align-items:flex-end}.ov-score b{font-size:28px;line-height:1}.ov-score span{font-size:12px;color:var(--muted)}
.ov{container-type:inline-size}.ov-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}@container (min-width:860px){.ov-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.ov-grid .g.wide{grid-column:1/-1}}@container (max-width:480px){.ov-grid{grid-template-columns:1fr}.ov-grid .g.wide{grid-column:auto}}
.g{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:11px 13px;min-width:0}.g.wide{grid-column:span 2}
.g-h{display:flex;align-items:center;gap:7px}.g-l{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:650;flex:1}.g-v{font-weight:700;font-size:15px;white-space:nowrap}
.g .bar{height:7px;margin-top:9px}.g-s{font-size:11.5px;color:var(--muted);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.phs{margin-top:10px}.phs-track{position:relative;height:10px;border-radius:999px;background:#F3D9D9}.phs-band{position:absolute;top:0;bottom:0;background:#BFE6D3;border-radius:999px}
.phs-dot{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);transform:translate(-50%,-50%)}
.phs-tgt{position:absolute;top:-4px;bottom:-4px;width:2px;background:${C.teal};transform:translateX(-1px)}
.phs-ax{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px}
.dt{border-top:1px solid var(--line);margin-top:4px}.dt summary{list-style:none;display:flex;align-items:center;gap:8px;padding:10px 0 4px;cursor:pointer;font-weight:650;font-size:13.5px;color:var(--muted)}
.dt summary::-webkit-details-marker{display:none}.dt summary span{flex:1}.dt[open] summary ha-icon:last-child{transform:rotate(180deg)}
/* banners */
.banner{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;background:color-mix(in srgb,var(--t) 7%,#fff);border-color:color-mix(in srgb,var(--t) 30%,#fff);border-left:4px solid var(--t);box-shadow:none}
.banner b{font-size:14.5px}.banner p{margin:3px 0 0;color:#46566E;font-size:13px;line-height:1.45}
.banner-btn{display:block;width:100%;text-align:left;padding:0}
.inline-acts{display:flex;gap:14px;margin-top:8px}.link{color:var(--muted);font-weight:600;font-size:13px;padding:2px 0}.link.strong{color:var(--blue)}
/* actions */
.hacts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}.hacts .act,.grid2.mini .act{min-height:0;padding:8px 6px;box-shadow:none;flex-direction:column;gap:4px;align-items:center;text-align:center}.hacts .act small{display:none}.hacts .ai,.grid2.mini .ai{width:30px;height:30px;border-radius:9px}.hacts .at b,.grid2.mini .at b{font-size:13px}.grid2.mini{gap:8px}.grid2.mini .act{flex-direction:row;justify-content:flex-start;padding:7px 10px}
.banner.slim{padding:9px 14px;align-items:center}.banner.slim p{margin:1px 0 0}.banner .go{margin-left:auto}.banner-btn .banner.slim>div{flex:1;display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap}.go{font-weight:650;font-size:13px;color:${C.blue};white-space:nowrap}
.pstat{display:flex;align-items:center;gap:8px;font-size:13px;color:#46566E;padding:2px 0}.pstat b{color:var(--ink,#13233A)}
.act.slim{min-height:0;padding:8px 12px}.act.slim .ai{width:32px;height:32px}
.dwrap{container-type:inline-size}.dgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}.dstack{display:flex;flex-direction:column;gap:14px;min-width:0}
@container (min-width:700px){.dgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.dstack{display:contents}}
@container (min-width:1040px){.dgrid{grid-template-columns:repeat(3,minmax(0,1fr))}.dstack{display:flex}}
.dgrid .bars{height:48px}.dgrid .bignum{padding:2px 0 6px}
.actions3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}
.act{display:flex;align-items:center;gap:12px;padding:12px 14px;text-align:left;min-height:64px;transition:transform .08s,box-shadow .15s,border-color .15s}
.act:hover{border-color:color-mix(in srgb,var(--t) 45%,#fff)}.act:active{transform:scale(.985)}
.ai{width:40px;height:40px;border-radius:12px;background:color-mix(in srgb,var(--t) 12%,#fff);display:flex;align-items:center;justify-content:center;flex:none}
.at{display:flex;flex-direction:column;min-width:0}.at b{font-size:14.5px}.at small{font-size:12px;color:var(--muted)}
.act.solid{background:var(--t);border-color:var(--t);color:#fff}.act.solid .ai{background:rgba(255,255,255,.18)}.act.solid small{color:rgba(255,255,255,.85)}
.act.active{border-color:var(--t);box-shadow:inset 0 0 0 1.5px var(--t);background:color-mix(in srgb,var(--t) 8%,#fff)}
.act.wide{width:100%;box-shadow:none}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid2 .act{box-shadow:none;min-height:56px}
/* rows & controls */
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #F0F3F8}
.row:last-child{border-bottom:none}.rl{min-width:0}.rn{font-size:14px;font-weight:550}.rh{font-size:12px;color:var(--muted)}.rc{flex:none;display:flex;align-items:center}
.ro{font-weight:650;font-size:14px}.ro.big{font-size:20px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}.muted{color:var(--muted);font-weight:500}
.field{display:flex;flex-direction:column;gap:6px;padding:4px 0}.fl{font-size:12px;font-weight:650;color:var(--muted);letter-spacing:.02em}
.sub-h{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:8px;padding-top:10px;border-top:1px solid var(--line)}
.step{display:inline-flex;align-items:center;background:#F1F4F9;border:1px solid #E1E7F0;border-radius:12px;overflow:hidden;height:40px}
.step button{width:38px;height:100%;font-size:20px;color:var(--blue);font-weight:500}.step button:hover{background:#E6ECF6}
.step input{width:70px;border:none;background:transparent;text-align:right;font:inherit;font-weight:700;font-size:15px;color:var(--ink);outline:none;padding:0 2px}
.step .u{font-size:12px;color:var(--muted);padding:0 4px 0 3px;min-width:6px}
.step:focus-within{border-color:var(--blue);box-shadow:0 0 0 3px #1F6FEB22}
.bignum{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0 10px}.bignum .step{height:52px;border-radius:14px}.bignum .step input{width:110px;font-size:24px;text-align:center}.bignum .step button{width:52px;font-size:26px}.bn-l{font-size:12px;color:var(--muted);font-weight:600}
.seg{display:flex;background:#F1F4F9;border:1px solid #E1E7F0;border-radius:12px;padding:3px;gap:3px;flex-wrap:wrap}
.seg button{flex:1 1 auto;padding:8px 10px;border-radius:9px;font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap}
.seg button.on{background:#fff;color:var(--blue);box-shadow:0 1px 3px rgba(19,35,58,.12)}
.sel{position:relative;display:flex;align-items:center}.sel select{appearance:none;-webkit-appearance:none;width:100%;height:42px;border-radius:12px;border:1px solid #E1E7F0;background:#F1F4F9;font:inherit;font-size:14px;font-weight:600;color:var(--ink);padding:0 36px 0 12px;outline:none;text-overflow:ellipsis}
.sel select:focus{border-color:var(--blue);box-shadow:0 0 0 3px #1F6FEB22}.sel ha-icon{position:absolute;right:10px;pointer-events:none}
.sw{width:50px;height:28px;border-radius:999px;background:#C9D2DE;position:relative;flex:none;transition:background .2s;display:inline-block}
.sw i{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .2s}
.sw.on{background:${C.green}}.sw.dis{opacity:.45;cursor:not-allowed}.sw.on i{left:25px}.sw.big{width:56px;height:32px}.sw.big i{width:26px;height:26px}.sw.big.on i{left:27px}
.time{height:40px;border-radius:12px;border:1px solid #E1E7F0;background:#F1F4F9;font:inherit;font-weight:700;font-size:15px;color:var(--ink);padding:0 10px;outline:none}
.times{display:flex;flex-direction:column}
.note{display:flex;gap:8px;align-items:flex-start;margin:2px 0 0;color:var(--muted);font-size:12.5px;line-height:1.45}
.meter{padding:4px 0 6px}.mt{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.mt b{font-size:26px}.mt b small{font-size:13px;color:var(--muted)}.mt span{font-size:12.5px;color:var(--muted);text-align:right}
.bar{height:10px;border-radius:999px;background:#EDF1F7;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;border-radius:999px;transition:width .4s}
.plan{margin-top:4px}.bars{display:flex;align-items:flex-end;gap:2px;height:64px;margin-top:6px;padding:4px;background:var(--soft);border-radius:10px;border:1px solid var(--line)}
.bars i{flex:1;border-radius:3px 3px 1px 1px;min-width:2px}.axis{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);padding:3px 4px 0}
.khhead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;font-size:13.5px}
.cstep{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.cn{width:30px;height:30px;border-radius:50%;background:var(--blue);color:#fff;font-weight:750;display:flex;align-items:center;justify-content:center;flex:none}
.cb{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}.cb>b{font-size:14.5px}.cb>small{font-size:12px;color:var(--muted);margin-top:-5px}
.curve{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}.curve div{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;color:var(--muted)}.curve b{font-size:15px;color:var(--ink)}.curve span{display:block;font-weight:650;color:var(--ink)}
.na{color:var(--muted);font-size:12px}
.spd{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:2px 0 4px}.spd>div{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.spd .lab{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:650}.spd b{font-size:15px}.spd small{font-size:11px;color:${C.amber}}.spd .warn{border-color:color-mix(in srgb,${C.amber} 45%,#fff)}
.act.dis{opacity:.55;cursor:not-allowed}.act.dis:active{transform:none}
.cdbox{background:color-mix(in srgb,${C.amber} 8%,#fff);border:1px solid color-mix(in srgb,${C.amber} 35%,#fff);border-radius:12px;padding:10px 14px}
.cdtop{display:flex;align-items:center;gap:10px}.cdtop b{flex:1;font-size:20px;font-variant-numeric:tabular-nums}.cdbox .bar{margin-top:8px;height:8px}.cdbox .bar i{transition:width 1s linear}
.exp{display:flex;gap:7px;align-items:flex-start;font-size:12.5px;color:var(--muted);line-height:1.4}.exp b{color:var(--ink)}.exp.off{color:${C.amber}}.exp.off b{color:${C.amber}}
.banner b .cd{font-variant-numeric:tabular-nums}
/* modal */
.modal{position:fixed;inset:0;background:rgba(19,35,58,.38);display:flex;align-items:center;justify-content:center;z-index:9;padding:20px;backdrop-filter:blur(2px)}
.dlg{background:#fff;border-radius:18px;padding:20px;width:min(380px,100%);box-shadow:0 20px 50px rgba(19,35,58,.25)}
.dlg h4{margin:0 0 8px;font-size:18px}.dlg p{margin:0 0 4px;color:#46566E;font-size:14px;line-height:1.45}.dlg label{display:block;font-size:13px;color:var(--muted);margin-bottom:8px}
.dlg .step.big{height:54px;width:100%}.dlg .step.big input{flex:1;font-size:24px;text-align:center}.dlg .step.big button{width:54px;font-size:26px}.hint{font-size:12.5px!important;margin-top:8px!important}
.dlg-a{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}.dlg-a button{padding:10px 18px;border-radius:12px;font-weight:650}.ghost{background:#F1F4F9}.primary{background:var(--blue);color:#fff}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;z-index:10}
@media (max-width:600px){.g.wide{grid-column:auto}.ov-score{align-items:flex-start}:host{padding:10px 10px 24px}.hero{padding:16px}.hero-ctl{min-width:100%}.headline{font-size:18px}.ring{width:100px;height:100px}.hero-main{gap:16px}.step input{width:60px}}
`;

customElements.get('sentinel-x1-card') || customElements.define('sentinel-x1-card', SentinelX1Card);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'sentinel-x1-card', name: 'Sentinel X1 Pro-T', description: 'Sentinel X1 dosing dashboard (views: dosing, status, settings)' });
console.info(`%c SENTINEL-X1-CARD %c ${SX_VERSION} `, 'background:#1F6FEB;color:#fff;border-radius:3px 0 0 3px', 'background:#0E9FB3;color:#fff;border-radius:0 3px 3px 0');
