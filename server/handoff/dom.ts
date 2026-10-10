/**
 * Scripts injected into pages by the browser agent. Kept as strings so they run in the page
 * context without bundling. Interactive elements get a numeric `data-errand-id` the model refers to.
 */

export interface PageElement {
  id: number;
  tag: string;
  role: string;
  text: string;
  type?: string;
  name?: string;
  placeholder?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: string[];
}

export const indexElements = (start: number) => `((start) => {
  const SELECTOR = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-errand-id]').forEach(el => el.removeAttribute('data-errand-id'));
  const out = [];
  let n = start;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > innerHeight * 2.5 || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
    if (aria) return aria;
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap && wrap !== el) return wrap.innerText;
    return el.innerText || el.value || '';
  };
  const seen = new Set();
  const roots = [document];
  document.querySelectorAll('*').forEach(e => { if (e.shadowRoot) roots.push(e.shadowRoot); });
  for (const root of roots) for (const el of root.querySelectorAll(SELECTOR)) {
    if (seen.has(el) || !visible(el)) continue;
    // Skip wrappers whose only purpose is to contain another indexed control.
    if (el.matches('[tabindex],[onclick]') && !el.matches('a,button,input,select,textarea') && el.querySelector('a,button,input,select,textarea')) continue;
    seen.add(el);
    el.setAttribute('data-errand-id', String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || undefined;
    const isSecret = type === 'password' || /cc-|card|cvc|cvv|security.?code/i.test((el.getAttribute('autocomplete') || '') + ' ' + (el.name || '') + ' ' + (el.id || ''));
    const item = { id: n, tag, role: el.getAttribute('role') || '', text: label(el).replace(/\\s+/g, ' ').trim().slice(0, 100) };
    if (type) item.type = type;
    if (el.name) item.name = el.name;
    if (el.placeholder) item.placeholder = el.placeholder.slice(0, 60);
    if (tag === 'a') item.href = (el.getAttribute('href') || '').slice(0, 120);
    if ((tag === 'input' || tag === 'textarea') && el.value && type !== 'hidden') item.value = isSecret ? (el.value ? '[filled]' : '') : el.value.slice(0, 60);
    if (type === 'checkbox' || type === 'radio') item.checked = el.checked;
    if (el.disabled) item.disabled = true;
    if (tag === 'select') { item.options = [...el.options].slice(0, 30).map(o => o.text.trim()); item.value = el.options[el.selectedIndex]?.text; }
    out.push(item);
    n++;
    if (n > start + 400) break;
  }
  return out;
})(${start})`;

/** Draw numbered boxes over indexed elements so vision models can match ids to what they see. */
export const DRAW_LABELS = `(() => {
  const layer = document.createElement('div');
  layer.id = '__errand_labels';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const colors = ['#e11d48','#2563eb','#16a34a','#d97706','#7c3aed','#0891b2'];
  document.querySelectorAll('[data-errand-id]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const id = el.getAttribute('data-errand-id');
    const c = colors[Number(id) % colors.length];
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid ' + c + ';left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;box-sizing:border-box';
    const tag = document.createElement('div');
    tag.textContent = id;
    tag.style.cssText = 'position:absolute;top:-2px;left:-2px;background:' + c + ';color:#fff;font:bold 11px/1 sans-serif;padding:2px 3px';
    box.appendChild(tag);
    layer.appendChild(box);
  });
  document.documentElement.appendChild(layer);
})()`;

export const REMOVE_LABELS = `document.getElementById('__errand_labels')?.remove()`;

/** Visible text of the page, trimmed. */
export const PAGE_TEXT = `(() => {
  const t = (document.body?.innerText || '').replace(/\\n\\s*\\n+/g, '\\n').trim();
  return t.slice(0, 6000);
})()`;

/** Mask fields that were filled from the vault so screenshots sent to a model never show them. */
export const MASK_SECRETS = `document.querySelectorAll('[data-errand-secret]').forEach(el => { el.style.setProperty('-webkit-text-security', 'disc', 'important'); el.style.setProperty('color', 'transparent', 'important'); el.style.setProperty('text-shadow', '0 0 0 #555', 'important'); })`;

/** Resolves once the page has gone 300 ms without changing, or after 2.5 s on a page that never stops. */
export const SETTLE = `new Promise((resolve) => {
  let quiet = setTimeout(done, 300);
  const cap = setTimeout(done, 2500);
  const obs = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 300); });
  obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  function done() { obs.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(true); }
})`;
