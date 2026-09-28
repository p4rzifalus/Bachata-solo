/* Панель слайдеров со всеми порогами детекции. Значения живут в localStorage:
 * нашёл рабочие — перенеси их в DETECT_META в src/steps.js и закоммить.
 */

import { DETECT_META, defaultSettings } from "./steps.js";

const KEY = "bachata.detect";

// Настройки меняются «на месте», поэтому детектор подхватывает их сразу, без перезапуска.
export function loadSettings() {
  const s = defaultSettings();
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}
  for (const k of Object.keys(s)) if (!(k in DETECT_META)) delete s[k];
  return s;
}

export function mountSliders(root, settings) {
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {} };
  const inputs = {};
  root.innerHTML = "";
  for (const [k, m] of Object.entries(DETECT_META)) {
    const row = document.createElement("div");
    row.className = "drow";
    row.innerHTML = `<label for="d-${k}"><span>${m.label}</span><span class="dval"></span></label>
      <input id="d-${k}" type="range" min="${m.min}" max="${m.max}" step="${m.step}">`;
    const input = row.querySelector("input"), val = row.querySelector(".dval");
    const show = () => { val.textContent = settings[k]; val.classList.toggle("changed", settings[k] !== m.v); };
    input.value = settings[k];
    show();
    input.addEventListener("input", () => { settings[k] = +input.value; show(); save(); });
    inputs[k] = { input, show };
    root.appendChild(row);
  }
  return {
    reset() {
      Object.assign(settings, defaultSettings());
      for (const [k, { input, show }] of Object.entries(inputs)) { input.value = settings[k]; show(); }
      save();
    },
  };
}
