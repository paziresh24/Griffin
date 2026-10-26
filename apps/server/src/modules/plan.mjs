// What switching a module on or off does to the others: pure, so the marketplace can show it before
// anything changes and the tests can run it without a host. docs/modules.md, «تعارض و مهاجرت».
//
//   enable X   the modules X requires come on with it; a module already on that fills one of X's
//              slots (provides) or is named in conflicts goes off (a switch, not a refusal);
//   disable X  the modules that require X go off with it;
//   blocked    when no consistent set exists (X requires something that is not installed, or X and
//              something X needs cannot live together).

const shares = (a, b) => a.provides.filter((slot) => b.provides.includes(slot));
const clash = (a, b) => (a.conflicts.includes(b.id) || b.conflicts.includes(a.id) ? { kind: "conflict" } : shares(a, b).length ? { kind: "slot", slot: shares(a, b)[0] } : null);

/**
 * @param manifests Map id -> parsed manifest (every installed module that parses)
 * @param on Set of the ids on now
 * @param id the module to switch
 * @param enable true = switch on, false = switch off
 * @returns {{ok:boolean, blocked:string|null, enable:string[], disable:string[], reasons:object}}
 *   enable/disable are the ids that change (id included); reasons[id] says why each one is there.
 */
export function planSwitch(manifests, on, id, enable) {
  const out = { ok: true, blocked: null, enable: [], disable: [], reasons: {} };
  const block = (message) => ({ ...out, ok: false, blocked: message, enable: [], disable: [] });
  const target = manifests.get(id);
  if (!target) return block(`ماژول «${id}» نصب نیست`);
  const next = new Set(on);

  const turnOff = (moduleId, reason) => {
    if (!next.has(moduleId)) return;
    next.delete(moduleId);
    out.disable.push(moduleId);
    out.reasons[moduleId] = reason;
  };

  if (!enable) {
    if (!next.has(id)) return out;
    turnOff(id, "خودتان خاموش کردید");
    cascade(manifests, next, turnOff);
    return out;
  }

  if (next.has(id)) return out;
  // 1. everything it requires comes on with it
  const queue = [id];
  const wanted = new Set([id]);
  out.reasons[id] = "خودتان روشن کردید";
  while (queue.length) {
    const m = manifests.get(queue.shift());
    for (const need of m.requires.modules) {
      if (!manifests.has(need)) return block(`«${m.title}» به ماژول «${need}» نیاز دارد که نصب نیست`);
      if (!wanted.has(need) && !next.has(need)) {
        wanted.add(need);
        queue.push(need);
        out.reasons[need] = `«${m.title}» به آن نیاز دارد`;
      }
    }
  }
  // 2. the ones coming on must not clash with each other
  const incoming = [...wanted];
  for (let i = 0; i < incoming.length; i += 1) {
    for (let j = i + 1; j < incoming.length; j += 1) {
      const c = clash(manifests.get(incoming[i]), manifests.get(incoming[j]));
      if (c) return block(`«${manifests.get(incoming[i]).title}» و «${manifests.get(incoming[j]).title}» با هم جور نیستند`);
    }
  }
  // 3. the ones on now that clash with an incoming one go off
  for (const inId of incoming) {
    const m = manifests.get(inId);
    for (const other of [...next]) {
      const c = clash(m, manifests.get(other));
      if (!c) continue;
      if (wanted.has(other)) continue;
      turnOff(other, c.kind === "slot" ? `با «${m.title}» هم‌جایگزین است و فقط یکی از این دو روشن می‌ماند` : `با «${m.title}» جور نیست`);
    }
  }
  // 4. whatever required something that just went off goes off too — unless an incoming module needs it
  cascade(manifests, next, turnOff);
  for (const w of wanted) {
    const lost = manifests.get(w).requires.modules.find((need) => !next.has(need) && !wanted.has(need));
    if (lost) return block(`«${manifests.get(lost).title}» هم لازم است و هم با چیز دیگری از همین انتخاب جور نیست`);
  }
  for (const w of wanted) {
    next.add(w);
    out.enable.push(w);
  }
  return out;
}

// A module on that requires one now off cannot stay on.
function cascade(manifests, next, turnOff) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const other of [...next]) {
      const m = manifests.get(other);
      const lost = m?.requires.modules.find((need) => !next.has(need));
      if (lost) {
        turnOff(other, `به «${manifests.get(lost)?.title || lost}» نیاز دارد که خاموش می‌شود`);
        changed = true;
      }
    }
  }
}

/** The ids that fill a slot among the modules on. */
export const providersOf = (manifests, on, slot) => [...on].filter((id) => manifests.get(id)?.provides.includes(slot));
